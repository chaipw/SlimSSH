use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMethod {
    Password,
    PrivateKey,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub x11_forwarding: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct RemoteDirectory {
    pub path: String,
    pub entries: Vec<RemoteEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    #[serde(flatten)]
    pub profile: Profile,
    pub has_secret: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSaveInput {
    pub profile: Profile,
    pub secret: Option<String>,
    pub save_secret: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum HostKeyDecision {
    Reject,
    Once,
    Save,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Connecting,
    VerifyingHostKey,
    Authenticating,
    Ready,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    WorkingDirectory {
        path: String,
    },
    State {
        state: SessionState,
    },
    HostKeyRequired {
        request_id: String,
        host: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
    },
    HostKeyMismatch {
        host: String,
        port: u16,
        expected: String,
        actual: String,
    },
    Output {
        seq: u64,
        data: String,
    },
    Error {
        code: String,
        message: String,
    },
    Closed {
        reason: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_event_uses_wire_format() {
        let event = SessionEvent::HostKeyRequired {
            request_id: "request-1".into(),
            host: "example.com".into(),
            port: 22,
            algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:test".into(),
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["type"], "host_key_required");
        assert_eq!(value["request_id"], "request-1");
        assert!(value.get("requestId").is_none());
    }

    #[test]
    fn profile_uses_camel_case() {
        let profile = Profile {
            id: "id".into(),
            name: "name".into(),
            host: "host".into(),
            port: 22,
            username: "user".into(),
            auth_method: AuthMethod::PrivateKey,
            private_key_path: Some("C:\\key".into()),
            x11_forwarding: false,
        };
        let value = serde_json::to_value(profile).unwrap();
        assert_eq!(value["authMethod"], "private_key");
        assert_eq!(value["privateKeyPath"], "C:\\key");
    }
}
