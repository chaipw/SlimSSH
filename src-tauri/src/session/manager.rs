use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use tauri::{async_runtime::JoinHandle, ipc::Channel};
use tokio::{
    sync::{mpsc, oneshot, Semaphore},
    time::{timeout_at, Instant},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    known_hosts::KnownHostsStore,
    model::{HostKeyDecision, Profile, RemoteDirectory, SessionEvent},
};

use super::actor::{self, ActorCommand, HostKeyBroker};
use super::transfer::{Transfer, TransferProgress};

const MAX_SESSIONS: usize = 16;
const COMMAND_QUEUE_SIZE: usize = 32;
const MAX_INPUT_QUEUE_BYTES: usize = 64 * 1024;
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

type JoinSlot = Arc<Mutex<Option<JoinHandle<()>>>>;

#[derive(Clone)]
pub(super) struct SessionControl {
    profile_id: String,
    sender: mpsc::Sender<ActorCommand>,
    join: JoinSlot,
    close_reason: Arc<Mutex<Option<String>>>,
    queued_input: Arc<AtomicUsize>,
    pub cancellation: CancellationToken,
    pub host_keys: Arc<HostKeyBroker>,
}

impl SessionControl {
    fn initiate_close(&self, reason: &str) {
        if let Ok(mut close_reason) = self.close_reason.lock() {
            if close_reason.is_none() {
                *close_reason = Some(reason.to_string());
            }
        }
        self.host_keys.set_cancelled();
        self.cancellation.cancel();
    }

    pub fn close_reason(&self) -> Option<String> {
        self.close_reason.lock().ok()?.clone()
    }

    pub fn complete_input(&self, len: usize) {
        self.queued_input.fetch_sub(len, Ordering::AcqRel);
    }
}

pub(super) struct ManagerInner {
    sessions: Mutex<HashMap<String, SessionControl>>,
    pub upload_slot: Arc<Semaphore>,
}

impl ManagerInner {
    pub fn remove(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
    }
}

pub(crate) struct SessionManager {
    inner: Arc<ManagerInner>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(ManagerInner {
                sessions: Mutex::new(HashMap::new()),
                upload_slot: Arc::new(Semaphore::new(1)),
            }),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open(
        &self,
        profile: Profile,
        secret: Option<Zeroizing<String>>,
        cols: u32,
        rows: u32,
        events: Channel<SessionEvent>,
        known_hosts: Arc<KnownHostsStore>,
    ) -> Result<String, String> {
        let session_id = Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel(COMMAND_QUEUE_SIZE);
        let control = SessionControl {
            profile_id: profile.id.clone(),
            sender,
            join: Arc::new(Mutex::new(None)),
            close_reason: Arc::new(Mutex::new(None)),
            queued_input: Arc::new(AtomicUsize::new(0)),
            cancellation: CancellationToken::new(),
            host_keys: Arc::new(HostKeyBroker::new()),
        };

        let mut sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| "session manager lock is poisoned".to_string())?;
        if sessions.len() >= MAX_SESSIONS {
            return Err("the maximum of 16 active sessions has been reached".into());
        }
        let join = tauri::async_runtime::spawn(actor::run(
            session_id.clone(),
            profile,
            secret,
            cols,
            rows,
            events,
            known_hosts,
            control.clone(),
            receiver,
            self.inner.clone(),
        ));
        *control
            .join
            .lock()
            .map_err(|_| "session task lock is poisoned".to_string())? = Some(join);
        sessions.insert(session_id.clone(), control);
        Ok(session_id)
    }

    pub fn input(&self, session_id: &str, data: Vec<u8>) -> Result<(), String> {
        let control = self.control(session_id)?;
        if control.cancellation.is_cancelled() {
            return Err("session is closing or closed".into());
        }
        let len = data.len();
        control
            .queued_input
            .try_update(Ordering::AcqRel, Ordering::Acquire, |queued| {
                queued
                    .checked_add(len)
                    .filter(|total| *total <= MAX_INPUT_QUEUE_BYTES)
            })
            .map_err(|_| "terminal input queue exceeds 64 KiB".to_string())?;
        if let Err(error) = control.sender.try_send(ActorCommand::Input(data)) {
            control.complete_input(len);
            return Err(match error {
                mpsc::error::TrySendError::Full(_) => {
                    "session command queue is full; retry after processing output".into()
                }
                mpsc::error::TrySendError::Closed(_) => "session is closed".into(),
            });
        }
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), String> {
        self.send(session_id, ActorCommand::Resize { cols, rows })
    }

    pub fn preview(&self, session_id: &str, path: String) -> Result<oneshot::Receiver<Result<String, String>>, String> {
        let (reply, receiver) = oneshot::channel();
        self.send(session_id, ActorCommand::Preview { path, reply })?;
        Ok(receiver)
    }

    pub fn list_dir(
        &self,
        session_id: &str,
        path: String,
    ) -> Result<oneshot::Receiver<Result<RemoteDirectory, String>>, String> {
        let (reply, receiver) = oneshot::channel();
        self.send(session_id, ActorCommand::ListDir { path, reply })?;
        Ok(receiver)
    }

    pub fn transfer(
        &self,
        session_id: &str,
        transfer: Transfer,
        progress: Option<Channel<TransferProgress>>,
    ) -> Result<oneshot::Receiver<Result<(), String>>, String> {
        let (reply, receiver) = oneshot::channel();
        self.send(session_id, ActorCommand::Transfer { transfer, progress, reply })?;
        Ok(receiver)
    }

    pub fn ack(&self, session_id: &str, seq: u64) -> Result<(), String> {
        self.send(session_id, ActorCommand::Ack(seq))
    }

    pub fn host_key_decision(
        &self,
        session_id: &str,
        request_id: &str,
        decision: HostKeyDecision,
    ) -> Result<(), String> {
        self.control(session_id)?
            .host_keys
            .decide(request_id, decision)
    }

    pub fn close(&self, session_id: &str) {
        if let Ok(control) = self.control(session_id) {
            control.initiate_close("user");
        }
    }

    pub fn has_profile(&self, profile_id: &str) -> Result<bool, String> {
        Ok(self
            .inner
            .sessions
            .lock()
            .map_err(|_| "session manager lock is poisoned".to_string())?
            .values()
            .any(|control| control.profile_id == profile_id))
    }

    pub async fn shutdown_all(&self) {
        let controls: Vec<SessionControl> = match self.inner.sessions.lock() {
            Ok(sessions) => sessions.values().cloned().collect(),
            Err(_) => Vec::new(),
        };
        for control in &controls {
            control.initiate_close("shutdown");
        }

        let mut joins = Vec::new();
        for control in &controls {
            if let Ok(mut slot) = control.join.lock() {
                if let Some(join) = slot.take() {
                    joins.push(join);
                }
            }
        }
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        for mut join in joins {
            if timeout_at(deadline, &mut join).await.is_err() {
                join.abort();
            }
        }
        if let Ok(mut sessions) = self.inner.sessions.lock() {
            sessions.clear();
        }
    }

    fn send(&self, session_id: &str, command: ActorCommand) -> Result<(), String> {
        let control = self.control(session_id)?;
        if control.cancellation.is_cancelled() {
            return Err("session is closing or closed".into());
        }
        control
            .sender
            .try_send(command)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => {
                    "session command queue is full; retry after processing output".into()
                }
                mpsc::error::TrySendError::Closed(_) => "session is closed".into(),
            })
    }

    fn control(&self, session_id: &str) -> Result<SessionControl, String> {
        self.inner
            .sessions
            .lock()
            .map_err(|_| "session manager lock is poisoned".to_string())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| "session was not found".into())
    }
}
