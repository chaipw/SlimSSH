use std::{collections::BTreeMap, path::PathBuf, sync::Mutex};

use russh::keys::{HashAlg, PublicKey};
use serde::{Deserialize, Serialize};

use crate::profile::{read_json, validate_host, write_json_atomic, StoreError};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub public_key: String,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct KnownHostsFile {
    entries: Vec<KnownHostEntry>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum KnownHostsError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("known_hosts lock is poisoned")]
    Lock,
    #[error("invalid known host entry")]
    InvalidEntry,
}

pub(crate) struct KnownHostsStore {
    path: PathBuf,
    entries: Mutex<BTreeMap<String, KnownHostEntry>>,
}

impl KnownHostsStore {
    pub fn load(path: PathBuf) -> Result<Self, KnownHostsError> {
        let file: KnownHostsFile = read_json(&path)?.unwrap_or_default();
        let mut entries = BTreeMap::new();
        for entry in file.entries {
            validate_entry(&entry)?;
            let key = entry_key(&entry.host, entry.port);
            if entries.insert(key, entry).is_some() {
                return Err(KnownHostsError::InvalidEntry);
            }
        }
        Ok(Self {
            path,
            entries: Mutex::new(entries),
        })
    }

    pub fn lookup(&self, host: &str, port: u16) -> Result<Option<KnownHostEntry>, KnownHostsError> {
        Ok(self
            .entries
            .lock()
            .map_err(|_| KnownHostsError::Lock)?
            .get(&entry_key(host, port))
            .cloned())
    }

    pub fn save(&self, entry: KnownHostEntry) -> Result<(), KnownHostsError> {
        validate_entry(&entry)?;
        let mut entries = self.entries.lock().map_err(|_| KnownHostsError::Lock)?;
        let mut next = entries.clone();
        next.insert(entry_key(&entry.host, entry.port), entry);
        write_file(&self.path, &next)?;
        *entries = next;
        Ok(())
    }

    pub fn forget(&self, host: &str, port: u16) -> Result<(), KnownHostsError> {
        validate_host(host)?;
        if port == 0 {
            return Err(KnownHostsError::InvalidEntry);
        }
        let mut entries = self.entries.lock().map_err(|_| KnownHostsError::Lock)?;
        let mut next = entries.clone();
        next.remove(&entry_key(host, port));
        write_file(&self.path, &next)?;
        *entries = next;
        Ok(())
    }
}

impl KnownHostEntry {
    pub fn from_public_key(
        host: &str,
        port: u16,
        key: &PublicKey,
    ) -> Result<Self, KnownHostsError> {
        Ok(Self {
            host: normalize_host(host),
            port,
            algorithm: key.algorithm().to_string(),
            public_key: key
                .to_openssh()
                .map_err(|_| KnownHostsError::InvalidEntry)?,
        })
    }

    pub fn fingerprint(&self) -> String {
        PublicKey::from_openssh(&self.public_key)
            .map(|key| key.fingerprint(HashAlg::Sha256).to_string())
            .unwrap_or_else(|_| "invalid stored key".into())
    }
}

pub(crate) fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

fn normalize_host(host: &str) -> String {
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

fn entry_key(host: &str, port: u16) -> String {
    format!("{}:{port}", normalize_host(host))
}

fn validate_entry(entry: &KnownHostEntry) -> Result<(), KnownHostsError> {
    validate_host(&entry.host)?;
    if entry.port == 0 {
        return Err(KnownHostsError::InvalidEntry);
    }
    let key =
        PublicKey::from_openssh(&entry.public_key).map_err(|_| KnownHostsError::InvalidEntry)?;
    if key.algorithm().to_string() != entry.algorithm {
        return Err(KnownHostsError::InvalidEntry);
    }
    Ok(())
}

fn write_file(
    path: &PathBuf,
    entries: &BTreeMap<String, KnownHostEntry>,
) -> Result<(), StoreError> {
    let file = KnownHostsFile {
        entries: entries.values().cloned().collect(),
    };
    write_json_atomic(path, &file)
}
