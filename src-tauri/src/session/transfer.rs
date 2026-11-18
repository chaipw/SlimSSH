use std::path::PathBuf;

use russh_sftp::{client::SftpSession, protocol::OpenFlags};
use tokio::{fs, io::{self, AsyncWriteExt}};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Transfer {
    Download { remote: String, local: PathBuf },
    Upload { directory: String, local: PathBuf },
}

impl Transfer {
    pub(super) async fn run(self, sftp: &SftpSession, cancel: &CancellationToken) -> io::Result<()> {
        match self {
            Self::Download { remote, local } => {
                let metadata = sftp.metadata(&remote).await.map_err(io::Error::other);
                if !metadata?.is_regular() {
                    return Err(io::Error::other("只能下载普通文件"));
                }
                let mut source = sftp.open(remote).await.map_err(io::Error::other)?;
                let temp = local.with_file_name(format!(".slimssh-{}.part", Uuid::new_v4()));
                let mut target = fs::OpenOptions::new().write(true).create_new(true).open(&temp).await?;
                let copied = copy(&mut source, &mut target, cancel).await;
                drop(target);
                let result = match copied {
                    Ok(()) => fs::rename(&temp, &local).await,
                    Err(error) => Err(error),
                };
                if result.is_err() {
                    let _ = fs::remove_file(&temp).await;
                }
                result
            }
            Self::Upload { directory, local } => {
                let name = local.file_name().and_then(|name| name.to_str()).ok_or_else(|| io::Error::other("本地文件名无效"))?;
                if !fs::metadata(&local).await?.is_file() {
                    return Err(io::Error::other(format!("只能上传普通文件：{name}")));
                }
                let mut source = fs::File::open(&local).await?;
                let directory = directory.trim_end_matches('/');
                let destination = format!("{directory}/{name}");
                let temp = format!("{directory}/.slimssh-{}.part", Uuid::new_v4());
                let mut target = sftp.open_with_flags(&temp, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE)
                    .await.map_err(io::Error::other)?;
                let copied = copy(&mut source, &mut target, cancel).await;
                drop(target);
                let result = match copied {
                    Ok(()) => sftp.rename(&temp, &destination).await.map_err(io::Error::other),
                    Err(error) => Err(error),
                };
                if result.is_err() {
                    let _ = sftp.remove_file(&temp).await;
                }
                result
            }
        }
    }
}

async fn copy(
    source: &mut (impl io::AsyncRead + Unpin),
    target: &mut (impl io::AsyncWrite + Unpin),
    cancel: &CancellationToken,
) -> io::Result<()> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(io::Error::new(io::ErrorKind::Interrupted, "SSH 会话已关闭")),
        result = async {
            io::copy(source, target).await?;
            target.shutdown().await
        } => result,
    }
}
