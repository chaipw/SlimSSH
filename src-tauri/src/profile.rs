use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::de::DeserializeOwned;
use uuid::Uuid;

use crate::model::{AuthMethod, Profile};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("storage I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid stored JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid profile: {0}")]
    InvalidProfile(String),
    #[error("profile not found")]
    ProfileNotFound,
    #[error("profile store lock is poisoned")]
    Lock,
}

pub(crate) struct ProfileStore {
    path: PathBuf,
    profiles: Mutex<Vec<Profile>>,
}

impl ProfileStore {
    pub fn load(path: PathBuf) -> Result<Self, StoreError> {
        let profiles: Vec<Profile> = read_json(&path)?.unwrap_or_default();
        let mut ids = HashSet::new();
        for profile in &profiles {
            validate_profile(profile)?;
            if profile.id.is_empty() || !ids.insert(profile.id.clone()) {
                return Err(StoreError::InvalidProfile(
                    "stored profile IDs must be non-empty and unique".into(),
                ));
            }
        }
        Ok(Self {
            path,
            profiles: Mutex::new(profiles),
        })
    }

    pub fn list(&self) -> Result<Vec<Profile>, StoreError> {
        Ok(self.profiles.lock().map_err(|_| StoreError::Lock)?.clone())
    }

    pub fn get(&self, id: &str) -> Result<Profile, StoreError> {
        self.profiles
            .lock()
            .map_err(|_| StoreError::Lock)?
            .iter()
            .find(|profile| profile.id == id)
            .cloned()
            .ok_or(StoreError::ProfileNotFound)
    }

    pub fn save(&self, mut profile: Profile) -> Result<Profile, StoreError> {
        if profile.id.is_empty() {
            profile.id = Uuid::new_v4().to_string();
        }
        validate_profile(&profile)?;

        let mut profiles = self.profiles.lock().map_err(|_| StoreError::Lock)?;
        let mut next = profiles.clone();
        if let Some(index) = next.iter().position(|item| item.id == profile.id) {
            next[index] = profile.clone();
        } else {
            next.push(profile.clone());
        }
        write_json_atomic(&self.path, &next)?;
        *profiles = next;
        Ok(profile)
    }

    pub fn delete(&self, id: &str) -> Result<Profile, StoreError> {
        let mut profiles = self.profiles.lock().map_err(|_| StoreError::Lock)?;
        let mut next = profiles.clone();
        let index = next
            .iter()
            .position(|profile| profile.id == id)
            .ok_or(StoreError::ProfileNotFound)?;
        let removed = next.remove(index);
        write_json_atomic(&self.path, &next)?;
        *profiles = next;
        Ok(removed)
    }
}

pub(crate) fn validate_profile(profile: &Profile) -> Result<(), StoreError> {
    if !profile.id.is_empty() && Uuid::parse_str(&profile.id).is_err() {
        return Err(StoreError::InvalidProfile(
            "profile ID must be a UUID".into(),
        ));
    }
    if profile.name.trim().is_empty() {
        return Err(StoreError::InvalidProfile("name is required".into()));
    }
    validate_host(&profile.host)?;
    if profile.port == 0 {
        return Err(StoreError::InvalidProfile(
            "port must be between 1 and 65535".into(),
        ));
    }
    if profile.username.trim().is_empty()
        || profile.username.chars().any(char::is_control)
        || profile.username.chars().any(char::is_whitespace)
    {
        return Err(StoreError::InvalidProfile(
            "username must be non-empty and contain no whitespace or control characters".into(),
        ));
    }
    match profile.auth_method {
        AuthMethod::Password => {
            if profile.private_key_path.is_some() {
                return Err(StoreError::InvalidProfile(
                    "private key path is only valid for private key authentication".into(),
                ));
            }
        }
        AuthMethod::PrivateKey => {
            let path = profile
                .private_key_path
                .as_deref()
                .unwrap_or_default()
                .trim();
            if path.is_empty() || Path::new(path).as_os_str().is_empty() {
                return Err(StoreError::InvalidProfile(
                    "private key path is required".into(),
                ));
            }
            if path.chars().any(char::is_control) {
                return Err(StoreError::InvalidProfile(
                    "private key path contains control characters".into(),
                ));
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_host(host: &str) -> Result<(), StoreError> {
    let host = host.trim();
    if host.is_empty()
        || host.chars().any(char::is_whitespace)
        || host.chars().any(char::is_control)
        || host.contains('/')
    {
        return Err(StoreError::InvalidProfile(
            "host must be non-empty and contain no whitespace, control characters, or '/'".into(),
        ));
    }
    Ok(())
}

pub(crate) fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, StoreError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn write_json_atomic<T: serde::Serialize>(
    path: &Path,
    value: &T,
) -> Result<(), StoreError> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "storage path has no parent",
        )
    })?;
    fs::create_dir_all(parent)?;
    let bytes = serde_json::to_vec_pretty(value)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("store");
    let temporary = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));

    let result = (|| -> Result<(), StoreError> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str) -> Profile {
        Profile {
            id: id.into(),
            name: "server".into(),
            host: "example.com".into(),
            port: 22,
            username: "root".into(),
            auth_method: AuthMethod::Password,
            private_key_path: None,
            x11_forwarding: false,
        }
    }

    #[test]
    fn save_generates_uuid_and_persists() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("profiles.json");
        let store = ProfileStore::load(path.clone()).unwrap();
        let saved = store.save(profile("")).unwrap();
        assert!(Uuid::parse_str(&saved.id).is_ok());
        assert_eq!(
            ProfileStore::load(path).unwrap().list().unwrap(),
            vec![saved]
        );
    }

    #[test]
    fn rejects_invalid_endpoint() {
        let directory = tempfile::tempdir().unwrap();
        let store = ProfileStore::load(directory.path().join("profiles.json")).unwrap();
        let mut value = profile("");
        value.host = "bad host".into();
        assert!(store.save(value).is_err());
    }
}
