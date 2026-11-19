use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use russh::{
    client::{self, ChannelOpenHandle, Handle},
    keys::{decode_secret_key, PrivateKeyWithHashAlg, PublicKeyOrCertificate},
    ChannelMsg, Disconnect,
};
use russh_sftp::client::SftpSession;
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf},
    net::TcpStream,
    sync::{mpsc, oneshot, watch},
    time::{interval, sleep, sleep_until, timeout, timeout_at, Instant, MissedTickBehavior},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    known_hosts::{fingerprint, KnownHostEntry, KnownHostsStore},
    model::{AuthMethod, HostKeyDecision, Profile, RemoteDirectory, RemoteEntry, SessionEvent, SessionState},
};

use super::{
    directory::find_shell,
    manager::{ManagerInner, SessionControl},
    output::OutputBuffer,
    transfer::{Transfer, TransferProgress},
    x11::{X11, PROTOCOL as X11_PROTOCOL},
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SFTP_TIMEOUT: Duration = Duration::from_secs(10);
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
const HOST_KEY_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);

pub(super) enum ActorCommand {
    Input(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Ack(u64),
    Preview { path: String, reply: oneshot::Sender<Result<String, String>> },
    ListDir {
        path: String,
        reply: oneshot::Sender<Result<RemoteDirectory, String>>,
    },
    Transfer {
        transfer: Transfer,
        progress: Option<Channel<TransferProgress>>,
        reply: oneshot::Sender<Result<(), String>>,
    },
}

async fn open_sftp(handle: Option<&Handle<ClientHandler>>) -> Result<SftpSession, String> {
    let handle = handle.ok_or("SSH 会话未连接")?;
    timeout(SFTP_TIMEOUT, async {
        let channel = handle.channel_open_session().await.map_err(|error| error.to_string())?;
        channel.request_subsystem(true, "sftp").await.map_err(|error| error.to_string())?;
        SftpSession::new(channel.into_stream()).await.map_err(|error| error.to_string())
    }).await.map_err(|_| "打开 SFTP 超时".to_string())?
}

struct CancelStream {
    stream: TcpStream,
    cancellation: CancellationToken,
    cancelled: Pin<Box<dyn Future<Output = ()> + Send>>,
}

impl CancelStream {
    fn new(stream: TcpStream, cancellation: CancellationToken) -> Self {
        let _ = stream.set_nodelay(true);
        let cancelled = Box::pin(cancellation.clone().cancelled_owned());
        Self {
            stream,
            cancellation,
            cancelled,
        }
    }

    fn check_cancelled(&mut self, context: &mut Context<'_>) -> std::io::Result<()> {
        if self.cancellation.is_cancelled() || self.cancelled.as_mut().poll(context).is_ready() {
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "SSH transport was cancelled",
            ))
        } else {
            Ok(())
        }
    }
}

impl AsyncRead for CancelStream {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        if let Err(error) = this.check_cancelled(context) {
            return Poll::Ready(Err(error));
        }
        Pin::new(&mut this.stream).poll_read(context, buffer)
    }
}

impl AsyncWrite for CancelStream {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        if let Err(error) = this.check_cancelled(context) {
            return Poll::Ready(Err(error));
        }
        Pin::new(&mut this.stream).poll_write(context, buffer)
    }

    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        if let Err(error) = this.check_cancelled(context) {
            return Poll::Ready(Err(error));
        }
        Pin::new(&mut this.stream).poll_flush(context)
    }

    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let this = self.get_mut();
        if let Err(error) = this.check_cancelled(context) {
            return Poll::Ready(Err(error));
        }
        Pin::new(&mut this.stream).poll_shutdown(context)
    }
}

#[derive(Debug)]
struct Failure {
    code: &'static str,
    message: String,
}

impl Failure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn cancelled() -> Self {
        Self::new("cancelled", "session was cancelled")
    }
}

#[derive(Debug, thiserror::Error)]
enum ClientError {
    #[error(transparent)]
    Russh(#[from] russh::Error),
    #[error("host key mismatch")]
    HostKeyMismatch,
    #[error("host key rejected")]
    HostKeyRejected,
    #[error("host key decision timed out")]
    HostKeyTimeout,
    #[error("host key could not be encoded")]
    InvalidHostKey,
    #[error("known_hosts operation failed: {0}")]
    KnownHosts(String),
    #[error("session cancelled")]
    Cancelled,
    #[error("frontend event channel closed")]
    FrontendClosed,
}

pub(super) struct HostKeyBroker {
    pending: Mutex<HashMap<String, oneshot::Sender<HostKeyDecision>>>,
    waiting: watch::Sender<bool>,
    cancelled: AtomicBool,
}

impl HostKeyBroker {
    pub(crate) fn new() -> Self {
        let (waiting, _) = watch::channel(false);
        Self {
            pending: Mutex::new(HashMap::new()),
            waiting,
            cancelled: AtomicBool::new(false),
        }
    }

    pub fn decide(&self, request_id: &str, decision: HostKeyDecision) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .map_err(|_| "host key request lock is poisoned".to_string())?
            .remove(request_id)
            .ok_or_else(|| "host key request was not found or was already answered".to_string())?;
        sender
            .send(decision)
            .map_err(|_| "host key request is no longer active".to_string())
    }

    fn subscribe(&self) -> watch::Receiver<bool> {
        self.waiting.subscribe()
    }

    pub(crate) fn set_cancelled(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.clear();
    }

    fn clear(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

struct WaitingGuard(Arc<HostKeyBroker>);

impl Drop for WaitingGuard {
    fn drop(&mut self) {
        self.0.waiting.send_replace(false);
    }
}

struct ClientHandler {
    host: String,
    port: u16,
    known_hosts: Arc<KnownHostsStore>,
    broker: Arc<HostKeyBroker>,
    events: Channel<SessionEvent>,
    cancellation: CancellationToken,
    transport_error: Arc<Mutex<Option<String>>>,
    x11: Option<X11>,
}

impl client::Handler for ClientHandler {
    type Error = ClientError;

    async fn server_channel_open_x11(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if let Some(x11) = self.x11.clone() {
            reply.accept().await;
            let cancellation = self.cancellation.clone();
            tokio::spawn(async move {
                tokio::select! {
                    _ = cancellation.cancelled() => {},
                    _ = x11.relay(channel.into_stream()) => {},
                }
            });
        }
        Ok(())
    }

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = server_public_key.public_key();
        let entry = KnownHostEntry::from_public_key(&self.host, self.port, &key)
            .map_err(|_| ClientError::InvalidHostKey)?;
        let actual_fingerprint = fingerprint(&key);

        if let Some(expected) = self
            .known_hosts
            .lookup(&self.host, self.port)
            .map_err(|error| ClientError::KnownHosts(error.to_string()))?
        {
            if expected.public_key == entry.public_key && expected.algorithm == entry.algorithm {
                return Ok(true);
            }
            let _ = self.events.send(SessionEvent::HostKeyMismatch {
                host: self.host.clone(),
                port: self.port,
                expected: expected.fingerprint(),
                actual: actual_fingerprint,
            });
            return Err(ClientError::HostKeyMismatch);
        }

        let request_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.broker
            .pending
            .lock()
            .map_err(|_| ClientError::KnownHosts("host key request lock is poisoned".into()))?
            .insert(request_id.clone(), sender);
        self.broker.waiting.send_replace(true);
        let _waiting = WaitingGuard(self.broker.clone());

        if self
            .events
            .send(SessionEvent::HostKeyRequired {
                request_id: request_id.clone(),
                host: self.host.clone(),
                port: self.port,
                algorithm: entry.algorithm.clone(),
                fingerprint: actual_fingerprint,
            })
            .is_err()
        {
            if let Ok(mut pending) = self.broker.pending.lock() {
                pending.remove(&request_id);
            }
            return Err(ClientError::FrontendClosed);
        }

        let decision = tokio::select! {
            _ = self.cancellation.cancelled() => Err(ClientError::Cancelled),
            result = timeout(HOST_KEY_TIMEOUT, receiver) => {
                match result {
                    Err(_) => Err(ClientError::HostKeyTimeout),
                    Ok(Err(_)) if self.broker.is_cancelled() => Err(ClientError::Cancelled),
                    Ok(Err(_)) => Err(ClientError::HostKeyRejected),
                    Ok(Ok(decision)) => Ok(decision),
                }
            }
        };
        if let Ok(mut pending) = self.broker.pending.lock() {
            pending.remove(&request_id);
        }

        match decision? {
            HostKeyDecision::Reject => Err(ClientError::HostKeyRejected),
            HostKeyDecision::Once => Ok(true),
            HostKeyDecision::Save => {
                self.known_hosts
                    .save(entry)
                    .map_err(|error| ClientError::KnownHosts(error.to_string()))?;
                Ok(true)
            }
        }
    }

    async fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        match reason {
            client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            client::DisconnectReason::Error(error) => {
                if let Ok(mut transport_error) = self.transport_error.lock() {
                    *transport_error = Some(error.to_string());
                }
                Err(error)
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run(
    session_id: String,
    profile: Profile,
    secret: Option<Zeroizing<String>>,
    cols: u32,
    rows: u32,
    events: Channel<SessionEvent>,
    known_hosts: Arc<KnownHostsStore>,
    control: SessionControl,
    mut commands: mpsc::Receiver<ActorCommand>,
    manager: Arc<ManagerInner>,
) {
    let mut failure = None;
    let mut output = OutputBuffer::new();
    let mut remote_closed = false;
    let transport_error = Arc::new(Mutex::new(None));
    let mut flush_timer = interval(FLUSH_INTERVAL);
    flush_timer.set_missed_tick_behavior(MissedTickBehavior::Delay);

    if !send_state(&events, SessionState::Connecting) {
        failure = Some(Failure::new(
            "frontend_closed",
            "frontend event channel is closed",
        ));
    }

    if failure.is_none() && profile.auth_method == AuthMethod::Password && secret.is_none() {
        failure = Some(Failure::new(
            "secret_required",
            "no password is saved for this profile",
        ));
    }

    let x11 = if failure.is_none() && profile.x11_forwarding {
        match X11::start().await {
            Ok(display) => Some(display),
            Err(error) => {
                failure = Some(Failure::new("x11_display_failed", error));
                None
            }
        }
    } else {
        None
    };

    let mut ssh = if failure.is_none() {
        send_state(&events, SessionState::VerifyingHostKey);
        let broker = control.host_keys.clone();
        let connection_cancellation = control.cancellation.child_token();
        let handler = ClientHandler {
            host: profile.host.clone(),
            port: profile.port,
            known_hosts: known_hosts.clone(),
            broker: broker.clone(),
            events: events.clone(),
            cancellation: connection_cancellation.clone(),
            transport_error: transport_error.clone(),
            x11: x11.clone(),
        };
        let config = Arc::new(client::Config {
            channel_buffer_size: 8,
            nodelay: true,
            ..Default::default()
        });
        match connect_cancellable(
            config,
            &profile.host,
            profile.port,
            handler,
            broker,
            connection_cancellation,
        )
        .await
        {
            Ok(handle) => Some(handle),
            Err(error) => {
                failure = Some(error);
                None
            }
        }
    } else {
        None
    };

    if failure.is_none() {
        if let Some(handle) = ssh.as_mut() {
            send_state(&events, SessionState::Authenticating);
            match cancellable_timeout(
                AUTH_TIMEOUT,
                authenticate(handle, &profile, secret),
                &control.cancellation,
                "authentication_timeout",
                "SSH authentication timed out",
            )
            .await
            {
                Ok(()) => {}
                Err(error) => failure = Some(error),
            }
        }
    }

    let mut ssh = ssh.map(Arc::new);
    let mut channel = if failure.is_none() {
        if let Some(handle) = ssh.as_mut() {
            let setup = async {
                let mut channel = handle.channel_open_session().await.map_err(|error| {
                    Failure::new(
                        "channel_open_failed",
                        format!("could not open SSH channel: {error}"),
                    )
                })?;
                if let Some(display) = &x11 {
                    channel.request_x11(true, false, X11_PROTOCOL, display.remote_cookie_hex(), 0)
                        .await.map_err(|error| Failure::new("x11_request_failed", error.to_string()))?;
                    if !matches!(channel.wait().await, Some(ChannelMsg::Success)) {
                        return Err(Failure::new("x11_refused", "远端 SSH 服务未接受 X11 转发，请检查 X11Forwarding 和 xauth"));
                    }
                }
                channel
                    .request_pty(true, "xterm", cols, rows, 0, 0, &[])
                    .await
                    .map_err(|error| {
                        Failure::new("pty_failed", format!("could not request PTY: {error}"))
                    })?;
                channel.request_shell(true).await.map_err(|error| {
                    Failure::new("shell_failed", format!("could not request shell: {error}"))
                })?;
                Ok(channel)
            };
            match cancellable_timeout(
                CONNECT_TIMEOUT,
                setup,
                &control.cancellation,
                "channel_timeout",
                "SSH channel setup timed out",
            )
            .await
            {
                Ok(channel) => {
                    send_state(&events, SessionState::Ready);
                    Some(channel)
                }
                Err(error) => {
                    failure = Some(error);
                    None
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    if channel.is_some() {
        if let Some(handle) = ssh.as_ref() {
            let handle = handle.clone();
            let directory_events = events.clone();
            let cancellation = control.cancellation.clone();
            tokio::spawn(async move {
                let setup = open_sftp(Some(handle.as_ref()));
                let sftp = tokio::select! {
                    _ = cancellation.cancelled() => return,
                    result = setup => match result { Ok(sftp) => sftp, Err(_) => return },
                };
                let pid = tokio::select! {
                    _ = cancellation.cancelled() => return,
                    result = timeout(Duration::from_secs(3), find_shell(&sftp)) => match result {
                        Ok(Ok(pid)) => pid,
                        _ => { let _ = sftp.close().await; return; }
                    },
                };
                let mut tick = interval(Duration::from_millis(600));
                tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
                let mut previous = String::new();
                let mut failures = 0;
                loop {
                    tokio::select! {
                        _ = cancellation.cancelled() => break,
                        _ = tick.tick() => {},
                    }
                    let result = tokio::select! {
                        _ = cancellation.cancelled() => break,
                        result = timeout(Duration::from_secs(3), sftp.read_link(format!("/proc/{pid}/cwd"))) => result,
                    };
                    match result {
                        Ok(Ok(path)) if path.starts_with('/') => {
                            failures = 0;
                            if path != previous {
                                if directory_events.send(SessionEvent::WorkingDirectory { path: path.clone() }).is_err() { break; }
                                previous = path;
                            }
                        }
                        // Unsupported procfs/SFTP must not affect the terminal.
                        _ => { failures += 1; if failures >= 3 { break; } }
                    }
                }
                let _ = timeout(Duration::from_secs(1), sftp.close()).await;
            });
        }
    }

    if let Some(ssh_channel) = channel.as_mut() {
        let mut sftp_session: Option<SftpSession> = None;
        while failure.is_none() && !remote_closed {
            if control.cancellation.is_cancelled() {
                break;
            }
            let can_read = output.can_read();
            tokio::select! {
                _ = control.cancellation.cancelled() => break,
                _ = flush_timer.tick() => {
                    if let Err(error) = emit_output(&events, &mut output, true) {
                        failure = Some(error);
                    }
                }
                command = commands.recv() => {
                    match command {
                        Some(ActorCommand::Input(data)) => {
                            control.complete_input(data.len());
                            if let Err(error) = ssh_channel.data_bytes(data).await {
                                failure = Some(Failure::new("input_failed", format!("could not send terminal input: {error}")));
                            }
                        }
                        Some(ActorCommand::Resize { cols, rows }) => {
                            if let Err(error) = ssh_channel.window_change(cols, rows, 0, 0).await {
                                failure = Some(Failure::new("resize_failed", format!("could not resize PTY: {error}")));
                            }
                        }
                        Some(ActorCommand::Preview { path, reply }) => {
                            let channel = open_sftp(ssh.as_deref()).await;
                            tokio::spawn(async move {
                                let result = async {
                                    let sftp = channel?;
                                    let metadata = sftp.metadata(&path).await.map_err(|e| e.to_string())?;
                                    if !metadata.is_regular() { return Err("只能打开普通文件".into()); }
                                    let file = sftp.open(path).await.map_err(|e| e.to_string())?;
                                    const LIMIT: usize = 64 * 1024;
                                    let mut bytes = Vec::new();
                                    file.take(LIMIT as u64 + 1).read_to_end(&mut bytes).await.map_err(|e| e.to_string())?;
                                    let truncated = bytes.len() > LIMIT;
                                    bytes.truncate(LIMIT);
                                    if bytes.contains(&0) || std::str::from_utf8(&bytes).is_err_and(|e| !truncated || e.error_len().is_some()) {
                                        return Ok("二进制或非 UTF-8 文件，请下载后使用本地应用打开。".to_string());
                                    }
                                    let mut text = String::from_utf8_lossy(&bytes).into_owned();
                                    if truncated { text.push_str("\n…（仅显示前 64 KiB）"); }
                                    Ok(text)
                                };
                                let _ = reply.send(timeout(SFTP_TIMEOUT, result).await.unwrap_or_else(|_| Err("打开文件超时".into())));
                            });
                        }
                        Some(ActorCommand::ListDir { path, reply }) => {
                            let outcome = async {
                                if sftp_session.is_none() {
                                    sftp_session = Some(open_sftp(ssh.as_deref()).await?);
                                }
                                let sftp = sftp_session.as_ref().ok_or("SFTP 会话不可用")?;
                                let path = sftp.canonicalize(path).await.map_err(|error| error.to_string())?;
                                let entries = sftp.read_dir(&path).await.map_err(|error| error.to_string())?
                                    .into_iter()
                                    .filter(|entry| !matches!(entry.file_name().as_str(), "." | ".."))
                                    .map(|entry| RemoteEntry {
                                        name: entry.file_name(),
                                        is_dir: entry.file_type().is_dir(),
                                        size: entry.metadata().size.unwrap_or(0),
                                    }).collect();
                                Ok(RemoteDirectory { path, entries })
                            };
                            let outcome = timeout(SFTP_TIMEOUT, outcome).await
                                .unwrap_or_else(|_| Err("读取远端目录超时".into()));
                            let _ = reply.send(outcome);
                        }
                        Some(ActorCommand::Transfer { transfer, progress, reply }) => {
                            let sftp = match open_sftp(ssh.as_deref()).await {
                                Ok(sftp) => sftp,
                                Err(error) => {
                                    let _ = reply.send(Err(error));
                                    continue;
                                }
                            };
                            let cancellation = control.cancellation.clone();
                            let upload_slot = if matches!(&transfer, Transfer::Upload { .. }) { Some(manager.upload_slot.clone()) } else { None };
                            tokio::spawn(async move {
                                let _permit = if let Some(slot) = upload_slot {
                                    let permit = tokio::select! {
                                        _ = cancellation.cancelled() => None,
                                        result = slot.acquire_owned() => result.ok(),
                                    };
                                    if permit.is_none() {
                                        let _ = sftp.close().await;
                                        let _ = reply.send(Err("SSH 会话已关闭".into()));
                                        return;
                                    }
                                    permit
                                } else { None };
                                let result = transfer.run(&sftp, &cancellation, progress).await.map_err(|error| error.to_string());
                                let _ = sftp.close().await;
                                let _ = reply.send(result);
                            });
                        }
                        Some(ActorCommand::Ack(seq)) => {
                            if !output.ack(seq) {
                                failure = Some(Failure::new("invalid_ack", "output acknowledgement has an invalid sequence"));
                            } else if let Err(error) = emit_output(&events, &mut output, false) {
                                failure = Some(error);
                            }
                        }
                        None => {
                            failure = Some(Failure::new("actor_channel_closed", "session command channel closed"));
                        }
                    }
                }
                message = ssh_channel.wait(), if can_read => {
                    match message {
                        Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                            if !output.push(&data) {
                                failure = Some(Failure::new("output_overflow", "terminal output queue exceeded its limit"));
                            } else if let Err(error) = emit_output(&events, &mut output, false) {
                                failure = Some(error);
                            }
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                            remote_closed = true;
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    if remote_closed && failure.is_none() && !control.cancellation.is_cancelled() {
        let network_error = transport_error
            .lock()
            .ok()
            .and_then(|mut error| error.take());
        if let Some(message) = network_error {
            failure = Some(Failure::new(
                "network_error",
                format!("SSH transport failed: {message}"),
            ));
            remote_closed = false;
        }
    }

    if remote_closed && failure.is_none() && !control.cancellation.is_cancelled() {
        while !output.pending_is_empty() && !control.cancellation.is_cancelled() {
            if let Err(error) = emit_output(&events, &mut output, true) {
                failure = Some(error);
                break;
            }
            if output.pending_is_empty() {
                break;
            }
            tokio::select! {
                _ = control.cancellation.cancelled() => break,
                _ = flush_timer.tick() => {}
                command = commands.recv() => {
                    match command {
                        Some(ActorCommand::Ack(seq)) => {
                            if !output.ack(seq) {
                                failure = Some(Failure::new("invalid_ack", "output acknowledgement has an invalid sequence"));
                                break;
                            }
                        }
                        Some(ActorCommand::Input(_)) | Some(ActorCommand::Resize { .. }) | Some(ActorCommand::ListDir { .. }) | Some(ActorCommand::Transfer { .. }) | Some(ActorCommand::Preview { .. }) => {}
                        None => break,
                    }
                }
            }
        }
    }

    control.host_keys.set_cancelled();
    if let Some(channel) = channel.take() {
        let _ = timeout(Duration::from_secs(1), channel.close()).await;
    }
    if let Some(handle) = ssh.take() {
        let _ = timeout(
            Duration::from_secs(1),
            handle.disconnect(Disconnect::ByApplication, "SlimSSH session closed", "en"),
        )
        .await;
    }

    let close_reason = control.close_reason();
    if let Some(error) = failure {
        if !control.cancellation.is_cancelled() && error.code != "cancelled" {
            let _ = events.send(SessionEvent::Error {
                code: error.code.into(),
                message: error.message,
            });
        }
    }
    let reason = close_reason.unwrap_or_else(|| {
        if remote_closed {
            "remote".into()
        } else {
            "error".into()
        }
    });
    let _ = events.send(SessionEvent::Closed { reason });
    control.cancellation.cancel();
    manager.remove(&session_id);
}

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    profile: &Profile,
    secret: Option<Zeroizing<String>>,
) -> Result<(), Failure> {
    let authenticated = match profile.auth_method {
        AuthMethod::Password => {
            let password = secret.ok_or_else(|| {
                Failure::new("secret_required", "no password is saved for this profile")
            })?;
            handle
                .authenticate_password(&profile.username, password.as_str().to_owned())
                .await
                .map_err(|error| {
                    Failure::new(
                        "authentication_error",
                        format!("SSH authentication failed: {error}"),
                    )
                })?
                .success()
        }
        AuthMethod::PrivateKey => {
            let path = profile.private_key_path.as_deref().ok_or_else(|| {
                Failure::new("private_key_missing", "private key path is not configured")
            })?;
            const MAX_PRIVATE_KEY_BYTES: u64 = 1024 * 1024;
            let file = tokio::fs::File::open(path).await.map_err(|error| {
                Failure::new(
                    "private_key_read_failed",
                    format!("could not open private key: {error}"),
                )
            })?;
            let mut key_text = Zeroizing::new(String::new());
            let mut limited = file.take(MAX_PRIVATE_KEY_BYTES + 1);
            limited
                .read_to_string(&mut key_text)
                .await
                .map_err(|error| {
                    Failure::new(
                        "private_key_read_failed",
                        format!("could not read private key: {error}"),
                    )
                })?;
            if key_text.len() as u64 > MAX_PRIVATE_KEY_BYTES {
                return Err(Failure::new(
                    "private_key_too_large",
                    "private key file exceeds 1 MiB",
                ));
            }
            let key = decode_secret_key(&key_text, secret.as_ref().map(|value| value.as_str()))
                .map_err(|_| {
                    Failure::new(
                        "private_key_invalid",
                        "private key could not be parsed or decrypted",
                    )
                })?;
            let hash = handle.best_supported_rsa_hash().await.map_err(|error| {
                Failure::new(
                    "authentication_error",
                    format!("SSH algorithm negotiation failed: {error}"),
                )
            })?;
            handle
                .authenticate_publickey(
                    &profile.username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash.flatten()),
                )
                .await
                .map_err(|error| {
                    Failure::new(
                        "authentication_error",
                        format!("SSH authentication failed: {error}"),
                    )
                })?
                .success()
        }
    };
    if authenticated {
        Ok(())
    } else {
        Err(Failure::new(
            "authentication_failed",
            "the server rejected the supplied credentials",
        ))
    }
}

async fn connect_cancellable(
    config: Arc<client::Config>,
    host: &str,
    port: u16,
    handler: ClientHandler,
    broker: Arc<HostKeyBroker>,
    cancellation: CancellationToken,
) -> Result<Handle<ClientHandler>, Failure> {
    let deadline = Instant::now() + CONNECT_TIMEOUT;
    let socket = tokio::select! {
        result = timeout_at(deadline, TcpStream::connect((host, port))) => {
            match result {
                Ok(Ok(socket)) => socket,
                Ok(Err(error)) => {
                    return Err(Failure::new(
                        "connect_failed",
                        format!("TCP connection failed: {error}"),
                    ));
                }
                Err(_) => {
                    return Err(Failure::new("connect_timeout", "SSH connection timed out"));
                }
            }
        }
        _ = cancellation.cancelled() => {
            broker.set_cancelled();
            return Err(Failure::cancelled());
        }
    };
    let stream = CancelStream::new(socket, cancellation.clone());
    let connect = client::connect_stream(config, stream, handler);
    tokio::pin!(connect);
    let mut waiting = broker.subscribe();
    let mut timer = Box::pin(sleep_until(deadline));
    loop {
        tokio::select! {
            result = &mut connect => {
                return result.map_err(map_client_error);
            }
            _ = cancellation.cancelled() => {
                broker.set_cancelled();
                return Err(Failure::cancelled());
            }
            changed = waiting.changed() => {
                if changed.is_err() {
                    return Err(Failure::new("host_key_wait_failed", "host key wait state was closed"));
                }
                timer.as_mut().reset(Instant::now() + CONNECT_TIMEOUT);
            }
            _ = &mut timer, if !*waiting.borrow() => {
                cancellation.cancel();
                broker.set_cancelled();
                return Err(Failure::new("connect_timeout", "SSH connection timed out"));
            }
        }
    }
}

fn map_client_error(error: ClientError) -> Failure {
    match error {
        ClientError::HostKeyMismatch => Failure::new(
            "host_key_mismatch",
            "the server host key does not match the saved key",
        ),
        ClientError::HostKeyRejected => {
            Failure::new("host_key_rejected", "the server host key was rejected")
        }
        ClientError::HostKeyTimeout => Failure::new(
            "host_key_timeout",
            "timed out waiting for the host key decision",
        ),
        ClientError::InvalidHostKey => Failure::new(
            "host_key_invalid",
            "the server host key could not be encoded",
        ),
        ClientError::KnownHosts(message) => Failure::new("known_hosts_error", message),
        ClientError::Cancelled => Failure::cancelled(),
        ClientError::FrontendClosed => {
            Failure::new("frontend_closed", "frontend event channel is closed")
        }
        ClientError::Russh(error) => Failure::new(
            "connect_failed",
            format!("SSH connection or host key verification failed: {error}"),
        ),
    }
}

async fn cancellable_timeout<F, T>(
    duration: Duration,
    future: F,
    cancellation: &CancellationToken,
    timeout_code: &'static str,
    timeout_message: &'static str,
) -> Result<T, Failure>
where
    F: Future<Output = Result<T, Failure>>,
{
    tokio::pin!(future);
    tokio::select! {
        result = &mut future => result,
        _ = cancellation.cancelled() => Err(Failure::cancelled()),
        _ = sleep(duration) => Err(Failure::new(timeout_code, timeout_message)),
    }
}

fn send_state(events: &Channel<SessionEvent>, state: SessionState) -> bool {
    events.send(SessionEvent::State { state }).is_ok()
}

fn emit_output(
    events: &Channel<SessionEvent>,
    output: &mut OutputBuffer,
    force: bool,
) -> Result<(), Failure> {
    for chunk in output.flush(force) {
        events
            .send(SessionEvent::Output {
                seq: chunk.seq,
                data: BASE64.encode(chunk.data),
            })
            .map_err(|_| Failure::new("frontend_closed", "frontend event channel is closed"))?;
    }
    Ok(())
}
