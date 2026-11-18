use zeroize::Zeroizing;

use crate::model::AuthMethod;

const SERVICE: &str = "com.slimssh.desktop";

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("Windows Credential Manager operation failed: {0}")]
    Os(#[from] std::io::Error),
    #[error("stored credential is not valid UTF-8")]
    InvalidUtf8,
    #[error("credential exceeds the Windows credential size limit")]
    TooLarge,
    #[error("Windows Credential Manager is unavailable on this platform")]
    Unsupported,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct CredentialStore;

impl CredentialStore {
    pub fn get(
        &self,
        profile_id: &str,
        method: AuthMethod,
    ) -> Result<Option<Zeroizing<String>>, CredentialError> {
        platform::get(&account(profile_id, method))
    }

    pub fn has(&self, profile_id: &str, method: AuthMethod) -> Result<bool, CredentialError> {
        Ok(self.get(profile_id, method)?.is_some())
    }

    pub fn set(
        &self,
        profile_id: &str,
        method: AuthMethod,
        secret: &Zeroizing<String>,
    ) -> Result<(), CredentialError> {
        platform::set(&account(profile_id, method), secret)
    }

    pub fn delete(&self, profile_id: &str, method: AuthMethod) -> Result<(), CredentialError> {
        platform::delete(&account(profile_id, method))
    }

    pub fn delete_all(&self, profile_id: &str) -> Result<(), CredentialError> {
        self.delete(profile_id, AuthMethod::Password)?;
        self.delete(profile_id, AuthMethod::PrivateKey)?;
        Ok(())
    }
}

fn account(profile_id: &str, method: AuthMethod) -> String {
    let suffix = match method {
        AuthMethod::Password => "password",
        AuthMethod::PrivateKey => "key_passphrase",
    };
    format!("{profile_id}:{suffix}")
}

#[cfg(windows)]
mod platform {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt, ptr};

    use windows_sys::Win32::{
        Foundation::ERROR_NOT_FOUND,
        Security::Credentials::{
            CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
            CRED_TYPE_GENERIC,
        },
    };
    use zeroize::Zeroizing;

    use super::{CredentialError, SERVICE};

    const MAX_CREDENTIAL_BLOB_BYTES: usize = 2560;

    struct CredentialPtr(*mut CREDENTIALW);

    impl Drop for CredentialPtr {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CredFree(self.0.cast::<c_void>()) };
            }
        }
    }

    pub(super) fn get(account: &str) -> Result<Option<Zeroizing<String>>, CredentialError> {
        let target = wide(&format!("{SERVICE}/{account}"));
        let mut credential = ptr::null_mut();
        let result = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) };
        if result == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_NOT_FOUND as i32) {
                return Ok(None);
            }
            return Err(error.into());
        }
        let credential = CredentialPtr(credential);
        let bytes = unsafe {
            let credential = &*credential.0;
            if credential.CredentialBlobSize == 0 {
                return Ok(Some(Zeroizing::new(String::new())));
            }
            std::slice::from_raw_parts(
                credential.CredentialBlob,
                credential.CredentialBlobSize as usize,
            )
        };
        let text = String::from_utf8(bytes.to_vec()).map_err(|_| CredentialError::InvalidUtf8)?;
        Ok(Some(Zeroizing::new(text)))
    }

    pub(super) fn set(account: &str, secret: &Zeroizing<String>) -> Result<(), CredentialError> {
        let bytes = secret.as_bytes();
        if bytes.len() > MAX_CREDENTIAL_BLOB_BYTES {
            return Err(CredentialError::TooLarge);
        }
        let mut target = wide(&format!("{SERVICE}/{account}"));
        let mut account = wide(account);
        let blob = Zeroizing::new(bytes.to_vec());
        let credential = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_mut_ptr(),
            Comment: ptr::null_mut(),
            LastWritten: unsafe { std::mem::zeroed() },
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: ptr::null_mut(),
            TargetAlias: ptr::null_mut(),
            UserName: account.as_mut_ptr(),
        };
        let result = unsafe { CredWriteW(&credential, 0) };
        if result == 0 {
            Err(std::io::Error::last_os_error().into())
        } else {
            Ok(())
        }
    }

    pub(super) fn delete(account: &str) -> Result<(), CredentialError> {
        let target = wide(&format!("{SERVICE}/{account}"));
        let result = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if result != 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_NOT_FOUND as i32) {
            Ok(())
        } else {
            Err(error.into())
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(Some(0))
            .collect()
    }
}

#[cfg(not(windows))]
mod platform {
    use zeroize::Zeroizing;

    use super::CredentialError;

    pub(super) fn get(_: &str) -> Result<Option<Zeroizing<String>>, CredentialError> {
        Err(CredentialError::Unsupported)
    }

    pub(super) fn set(_: &str, _: &Zeroizing<String>) -> Result<(), CredentialError> {
        Err(CredentialError::Unsupported)
    }

    pub(super) fn delete(_: &str) -> Result<(), CredentialError> {
        Err(CredentialError::Unsupported)
    }
}
