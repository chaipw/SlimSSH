use std::{env, fs, io, path::PathBuf, process::Command, time::Duration};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::Mutex,
    time::{sleep, timeout},
};
use uuid::Uuid;

pub(super) const PROTOCOL: &str = "MIT-MAGIC-COOKIE-1";
const DISPLAY: &str = "17";
const ENDPOINT: &str = "127.0.0.1:6017";
static START_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Clone)]
pub(super) struct X11 {
    remote_cookie: Uuid,
    local_cookie: [u8; 16],
}

impl X11 {
    pub(super) async fn start() -> Result<Self, String> {
        let _guard = START_LOCK.lock().await;
        let local_data = env::var_os("LOCALAPPDATA").ok_or("找不到 Windows 本地应用数据目录")?;
        let directory = PathBuf::from(local_data).join("SlimSSH-x11");
        let authority = directory.join("Xauthority");
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let cookie = match fs::read(&authority) {
            Ok(bytes) => {
                let mut record = authority_record(&[0; 16]);
                record.truncate(record.len() - 16);
                bytes.strip_prefix(record.as_slice())
                    .and_then(|suffix| suffix.try_into().ok())
                    .ok_or("SlimSSH 的本地 X11 授权文件格式无效")?
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let cookie = *Uuid::new_v4().as_bytes();
                fs::write(&authority, authority_record(&cookie)).map_err(|error| error.to_string())?;
                cookie
            }
            Err(error) => return Err(error.to_string()),
        };

        if TcpStream::connect(ENDPOINT).await.is_err() {
            let executable = ["ProgramFiles", "ProgramFiles(x86)"].into_iter()
                .filter_map(env::var_os)
                .map(|root| PathBuf::from(root).join("VcXsrv").join("vcxsrv.exe"))
                .find(|path| path.is_file())
                .ok_or("请先安装 VcXsrv，以显示远端图形窗口")?;
            let mut command = Command::new(executable);
            command.args([":17", "-multiwindow", "-noreset", "-noclipboard", "-listen", "tcp", "-nolisten", "inet6", "-auth"])
                .arg(authority);
            command.spawn().map_err(|error| error.to_string())?;
            timeout(Duration::from_secs(7), async {
                while TcpStream::connect(ENDPOINT).await.is_err() {
                    sleep(Duration::from_millis(150)).await;
                }
            }).await.map_err(|_| "VcXsrv 未能启动本地图形显示")?;
        }
        Ok(Self { remote_cookie: Uuid::new_v4(), local_cookie: cookie })
    }

    pub(super) fn remote_cookie_hex(&self) -> String {
        self.remote_cookie.simple().to_string()
    }

    pub(super) async fn relay(self, mut channel: russh::ChannelStream<russh::client::Msg>) -> io::Result<()> {
        let handshake = timeout(Duration::from_secs(8), self.read_handshake(&mut channel))
            .await.map_err(io::Error::other)??;
        let mut display = TcpStream::connect(ENDPOINT).await?;
        display.write_all(&handshake).await?;
        tokio::io::copy_bidirectional(&mut channel, &mut display).await?;
        Ok(())
    }

    async fn read_handshake(&self, channel: &mut (impl AsyncReadExt + Unpin)) -> io::Result<Vec<u8>> {
        let mut header = [0; 12];
        channel.read_exact(&mut header).await?;
        let decode = match header[0] {
            b'l' => u16::from_le_bytes,
            b'B' => u16::from_be_bytes,
            _ => return Err(invalid_handshake()),
        };
        let name_len = decode([header[6], header[7]]) as usize;
        let cookie_len = decode([header[8], header[9]]) as usize;
        if name_len != PROTOCOL.len() || cookie_len != 16 {
            return Err(invalid_handshake());
        }
        let cookie_start = 12 + (name_len + 3) / 4 * 4;
        let mut handshake = vec![0; cookie_start + cookie_len];
        handshake[..12].copy_from_slice(&header);
        channel.read_exact(&mut handshake[12..]).await?;
        if &handshake[12..12 + name_len] != PROTOCOL.as_bytes()
            || &handshake[cookie_start..] != self.remote_cookie.as_bytes()
        {
            return Err(invalid_handshake());
        }
        handshake[cookie_start..].copy_from_slice(&self.local_cookie);
        Ok(handshake)
    }
}

fn authority_record(cookie: &[u8; 16]) -> Vec<u8> {
    let mut record = u16::MAX.to_be_bytes().to_vec();
    for field in [b"".as_slice(), DISPLAY.as_bytes(), PROTOCOL.as_bytes(), cookie.as_slice()] {
        record.extend_from_slice(&(field.len() as u16).to_be_bytes());
        record.extend_from_slice(field);
    }
    record
}

fn invalid_handshake() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "invalid X11 authentication")
}
