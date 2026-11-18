use std::fmt::Display;

use tauri::{ipc::Channel, State};
#[cfg(not(windows))]
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;

use crate::{
    model::{HostKeyDecision, ProfileSaveInput, ProfileView, RemoteDirectory, SessionEvent},
    session::Transfer,
    AppState,
};

const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_PATH_BYTES: usize = 4096;

#[tauri::command]
pub async fn choose_download_path(window: tauri::WebviewWindow, file_name: String) -> Result<Option<String>, String> {
    let name: String = file_name.chars().map(|ch| {
        if ch.is_control() || "<>:\"/\\|?*".contains(ch) { '_' } else { ch }
    }).collect();
    let name = name.trim_end_matches([' ', '.']);
    let name = if name.is_empty() { "download" } else { name };
    #[cfg(windows)]
    {
        let owner = window.hwnd().map_err(display)?.0 as usize;
        let name = name.to_owned();
        return tauri::async_runtime::spawn_blocking(move || save_dialog(owner, &name)).await.map_err(display)?;
    }
    #[cfg(not(windows))]
    {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window.dialog().file().set_parent(&window)
        .set_file_name(name)
        .save_file(move |selected| { let _ = sender.send(selected); });
    let selected = receiver.await.map_err(|_| "保存对话框已关闭".to_string())?;
    selected.map(|path| path.into_path()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())).transpose()
    }
}

#[cfg(windows)]
fn save_dialog(owner: usize, name: &str) -> Result<Option<String>, String> {
    use windows_sys::Win32::UI::Controls::Dialogs::*;
    let mut buffer = vec![0u16; 32768];
    let initial: Vec<_> = name.encode_utf16().collect();
    if initial.len() >= buffer.len() { return Err("文件名过长".into()); }
    buffer[..initial.len()].copy_from_slice(&initial);
    let filter: Vec<_> = "所有文件\0*.*\0\0".encode_utf16().collect();
    // Windows reads the suggested name and writes the selected path in the same buffer.
    let mut dialog: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    dialog.lStructSize = std::mem::size_of_val(&dialog) as u32;
    dialog.hwndOwner = owner as _;
    dialog.lpstrFile = buffer.as_mut_ptr();
    dialog.nMaxFile = buffer.len() as u32;
    dialog.lpstrFilter = filter.as_ptr();
    dialog.Flags = OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    if unsafe { GetSaveFileNameW(&mut dialog) } == 0 {
        let error = unsafe { CommDlgExtendedError() };
        return if error == 0 { Ok(None) } else { Err(format!("另存为窗口错误 {error}")) };
    }
    let end = buffer.iter().position(|v| *v == 0).unwrap_or(buffer.len());
    Ok(Some(String::from_utf16_lossy(&buffer[..end])))
}

#[tauri::command]
pub async fn preview_file(session_id: String, path: String, state: State<'_, AppState>) -> Result<String, String> {
    if !path.starts_with('/') || path.len() > MAX_PATH_BYTES || path.contains('\0') { return Err("文件路径无效".into()); }
    state.sessions.preview(&session_id, path)?.await.map_err(display)?

}

#[tauri::command]
pub fn profile_list(state: State<'_, AppState>) -> Result<Vec<ProfileView>, String> {
    let profiles = state.profiles.list().map_err(display)?;
    profiles
        .into_iter()
        .map(|profile| {
            let has_secret = state
                .credentials
                .has(&profile.id, profile.auth_method)
                .map_err(display)?;
            Ok(ProfileView {
                profile,
                has_secret,
            })
        })
        .collect()
}

#[tauri::command]
pub fn profile_save(
    input: ProfileSaveInput,
    state: State<'_, AppState>,
) -> Result<ProfileView, String> {
    let _gate = state
        .profile_gate
        .lock()
        .map_err(|_| "profile lock is poisoned")?;
    let secret = input.secret.map(Zeroizing::new);
    let profile = state.profiles.save(input.profile).map_err(display)?;

    if !input.save_secret {
        state.credentials.delete_all(&profile.id).map_err(display)?;
    } else {
        let other_method = match profile.auth_method {
            crate::model::AuthMethod::Password => crate::model::AuthMethod::PrivateKey,
            crate::model::AuthMethod::PrivateKey => crate::model::AuthMethod::Password,
        };
        state
            .credentials
            .delete(&profile.id, other_method)
            .map_err(display)?;
        if let Some(secret) = secret.as_ref().filter(|secret| !secret.is_empty()) {
            state
                .credentials
                .set(&profile.id, profile.auth_method, secret)
                .map_err(display)?;
        }
    }

    let has_secret = state
        .credentials
        .has(&profile.id, profile.auth_method)
        .map_err(display)?;
    Ok(ProfileView {
        profile,
        has_secret,
    })
}

#[tauri::command]
pub fn profile_delete(profile_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let _gate = state
        .profile_gate
        .lock()
        .map_err(|_| "profile lock is poisoned")?;
    if state.sessions.has_profile(&profile_id)? {
        return Err("profile has an active session".into());
    }
    state.profiles.get(&profile_id).map_err(display)?;
    state.credentials.delete_all(&profile_id).map_err(display)?;
    state.profiles.delete(&profile_id).map_err(display)?;
    Ok(())
}

#[tauri::command]
pub fn session_open(
    profile_id: String,
    cols: u32,
    rows: u32,
    channel: Channel<SessionEvent>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    validate_dimensions(cols, rows)?;
    let _gate = state
        .profile_gate
        .lock()
        .map_err(|_| "profile lock is poisoned")?;
    let profile = state.profiles.get(&profile_id).map_err(display)?;
    let secret = state
        .credentials
        .get(&profile.id, profile.auth_method)
        .map_err(display)?;
    state.sessions.open(
        profile,
        secret,
        cols,
        rows,
        channel,
        state.known_hosts.clone(),
    )
}

#[tauri::command]
pub fn session_input(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if data.len() > MAX_INPUT_BYTES {
        return Err("terminal input exceeds 64 KiB".into());
    }
    state.sessions.input(&session_id, data.into_bytes())
}

#[tauri::command]
pub async fn session_list_dir(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<RemoteDirectory, String> {
    if path.is_empty() || path.len() > MAX_PATH_BYTES {
        return Err("invalid remote path".into());
    }
    let receiver = state.sessions.list_dir(&session_id, path)?;
    receiver
        .await
        .map_err(|_| "session closed while listing directory".to_string())?
}

#[tauri::command]
pub async fn session_transfer(
    session_id: String,
    transfer: Transfer,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (remote, local) = match &transfer {
        Transfer::Upload { directory, local } => (directory, local),
        Transfer::Download { remote, local } => (remote, local),
    };
    if !remote.starts_with('/') || remote.len() > MAX_PATH_BYTES || remote.contains('\0') || !local.is_absolute() {
        return Err("文件路径无效".into());
    }
    state.sessions.transfer(&session_id, transfer)?.await
        .map_err(|_| "SSH 会话在传输期间关闭".to_string())?
}

#[tauri::command]
pub fn session_resize(
    session_id: String,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_dimensions(cols, rows)?;
    state.sessions.resize(&session_id, cols, rows)
}

#[tauri::command]
pub fn session_output_ack(
    session_id: String,
    seq: u64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.sessions.ack(&session_id, seq)
}

#[tauri::command]
pub fn host_key_decision(
    session_id: String,
    request_id: String,
    decision: HostKeyDecision,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .sessions
        .host_key_decision(&session_id, &request_id, decision)
}

#[tauri::command]
pub fn known_hosts_forget(
    host: String,
    port: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.known_hosts.forget(&host, port).map_err(display)
}

#[tauri::command]
pub fn session_close(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.sessions.close(&session_id);
    Ok(())
}

fn validate_dimensions(cols: u32, rows: u32) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        Err("terminal columns and rows must be greater than zero".into())
    } else {
        Ok(())
    }
}

fn display(error: impl Display) -> String {
    error.to_string()
}
