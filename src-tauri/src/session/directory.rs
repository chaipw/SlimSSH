use russh_sftp::client::SftpSession;
use tokio::io::AsyncReadExt;

fn parent_pid(status: &str) -> Result<u32, String> {
    status.lines().find_map(|line| line.strip_prefix("PPid:"))
        .and_then(|value| value.trim().parse::<u32>().ok()).filter(|pid| *pid > 0)
        .ok_or_else(|| "远端未提供进程信息".into())
}

fn child_pids(children: &str) -> Vec<u32> {
    children.split_whitespace().filter_map(|value| value.parse::<u32>().ok())
        .filter(|pid| *pid > 0).take(64).collect()
}

async fn read_proc(sftp: &SftpSession, path: String) -> Result<String, String> {
    let file = sftp.open(path).await.map_err(|error| error.to_string())?;
    let mut text = String::new();
    file.take(8192).read_to_string(&mut text).await.map_err(|error| error.to_string())?;
    Ok(text)
}

/// The SFTP process and PTY login shell are siblings under the same sshd
/// connection. Follow only that connection, without shell commands or rc edits.
pub(super) async fn find_shell(sftp: &SftpSession) -> Result<u32, String> {
    let own = sftp.read_link("/proc/self").await.map_err(|error| error.to_string())?;
    let own: u32 = own.parse().map_err(|_| "远端未提供 Linux procfs".to_string())?;
    let status = read_proc(sftp, format!("/proc/{own}/status")).await?;
    let parent = parent_pid(&status)?;
    let children = read_proc(sftp, format!("/proc/{parent}/task/{parent}/children")).await?;
    for pid in child_pids(&children) {
        if pid == own { continue; }
        if let Ok(input) = sftp.read_link(format!("/proc/{pid}/fd/0")).await {
            if input.starts_with("/dev/pts/") || input.starts_with("/dev/tty") {
                return Ok(pid);
            }
        }
    }
    Err("当前 SSH 会话未提供可跟随的登录终端".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_only_the_parent_field_and_rejects_invalid_pids() {
        assert_eq!(parent_pid("Name:\tsftp\nPid:\t123\nPPid:\t42\n").unwrap(), 42);
        assert!(parent_pid("Pid: 12\nPPid: 0\n").is_err());
        assert!(parent_pid("PPid: ../../other").is_err());
    }
    #[test]
    fn bounds_process_candidates_and_accepts_only_numeric_pids() {
        assert_eq!(child_pids("12 34\n0 nope ../../99"), vec![12, 34]);
        assert_eq!(child_pids(&"123 ".repeat(1000)).len(), 64);
    }
}
