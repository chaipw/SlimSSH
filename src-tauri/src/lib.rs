mod commands;
mod credentials;
mod known_hosts;
mod model;
mod profile;
mod session;

use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, Mutex,
};

use tauri::{Manager, RunEvent, WebviewWindowBuilder};

use crate::{
    credentials::CredentialStore, known_hosts::KnownHostsStore, profile::ProfileStore,
    session::SessionManager,
};

pub(crate) struct AppState {
    profiles: Arc<ProfileStore>,
    credentials: Arc<CredentialStore>,
    known_hosts: Arc<KnownHostsStore>,
    sessions: Arc<SessionManager>,
    profile_gate: Mutex<()>,
}

pub fn run() {
    let shutdown_state = Arc::new(AtomicU8::new(0));
    let shutdown_flag = shutdown_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let profiles = Arc::new(ProfileStore::load(config_dir.join("profiles.json"))?);
            let known_hosts = Arc::new(KnownHostsStore::load(config_dir.join("known_hosts.json"))?);
            app.manage(AppState {
                profiles,
                credentials: Arc::new(CredentialStore),
                known_hosts,
                sessions: Arc::new(SessionManager::new()),
                profile_gate: Mutex::new(()),
            });
            WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .enable_clipboard_access()
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::profile_list,
            commands::profile_save,
            commands::profile_delete,
            commands::session_open,
            commands::session_input,
            commands::session_list_dir,
            commands::session_transfer,
            commands::choose_download_path,
            commands::preview_file,
            commands::session_resize,
            commands::session_output_ack,
            commands::host_key_decision,
            commands::known_hosts_forget,
            commands::session_close,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build SlimSSH")
        .run(move |app, event| {
            if let RunEvent::ExitRequested { code, api, .. } = event {
                if shutdown_flag.load(Ordering::Acquire) != 2 {
                    api.prevent_exit();
                }
                if shutdown_flag
                    .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
                {
                    let sessions = app.state::<AppState>().sessions.clone();
                    let app_handle = app.clone();
                    let shutdown_flag = shutdown_flag.clone();
                    tauri::async_runtime::spawn(async move {
                        sessions.shutdown_all().await;
                        shutdown_flag.store(2, Ordering::Release);
                        app_handle.exit(code.unwrap_or(0));
                    });
                }
            }
        });
}
