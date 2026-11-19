import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import Modal from "./Modal";
import { open } from "@tauri-apps/plugin-dialog";
import { chooseDownloadPath, previewFile, errorMessage, sessionListDir, sessionTransfer, type RemoteEntry } from "../lib/ipc";
import { clearFinishedUploads, enqueueUploads, useUploadQueue } from "../lib/uploadQueue";

interface FileBrowserProps {
  backendId: string | null;
  connected: boolean;
  workingDirectory?: string | null;
  sessionName?: string;
}

function normalize(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return "/";
  return `${trimmed.slice(0, index)}/`;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export default function FileBrowser({ backendId, connected, workingDirectory = null, sessionName = "当前会话" }: FileBrowserProps) {
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [transfer, setTransfer] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<{ entry: RemoteEntry; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);
  const browser = useRef<HTMLDivElement>(null);
  const transferBusy = useRef(false);
  const loadRequest = useRef(0);
  const requestedPath = useRef(".");
  const uploads = useUploadQueue();
  const seenCompletion = useRef(uploads.completion);

  const load = useCallback(
    async (target: string) => {
      if (!backendId) return;
      const request = ++loadRequest.current;
      requestedPath.current = target;
      setSelected(null);
      setMenu(null);
      setLoading(true);
      setError(null);
      try {
        const directory = await sessionListDir(backendId, target);
        if (loadRequest.current !== request) return;
        directory.entries.sort((left, right) => {
          if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
          return left.name.localeCompare(right.name);
        });
        setEntries(directory.entries);
        requestedPath.current = directory.path;
        setPath(directory.path);
      } catch (cause) {
        if (loadRequest.current === request) setError(errorMessage(cause));
      } finally {
        if (loadRequest.current === request) setLoading(false);
      }
    },
    [backendId],
  );

  useEffect(() => {
    if (backendId && connected) void load(workingDirectory ?? ".");
    return () => { loadRequest.current += 1; };
  }, [backendId, connected, load, workingDirectory]);

  useEffect(() => {
    const previous = seenCompletion.current;
    if (previous === uploads.completion) return;
    seenCompletion.current = uploads.completion;
    if (connected && backendId && uploads.jobs.some((job) =>
      (job.completedSequence ?? 0) > previous && job.backendId === backendId && normalize(job.directory) === normalize(requestedPath.current)
    )) void load(requestedPath.current);
  }, [uploads.completion, uploads.jobs, backendId, connected, load]);

  const upload = useCallback((files: string[]) => {
    if (!backendId || !path || !connected || files.length === 0) return;
    if (loading) {
      setError("目录正在刷新，请稍后添加上传文件。");
      return;
    }
    setStatus(null);
    setError(null);
    enqueueUploads(backendId, path, files, sessionName);
  }, [backendId, path, connected, loading, sessionName]);

  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  useEffect(() => {
    if (!connected || !isTauri()) return;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (disposed) return;
      if (payload.type === "leave") {
        setDragging(false);
        return;
      }
      const box = browser.current?.getBoundingClientRect();
      const { x, y } = payload.position.toLogical(window.devicePixelRatio);
      const inside = !!box && x >= box.left && x < box.right && y >= box.top && y < box.bottom;
      setDragging(inside && payload.type !== "drop");
      if (inside && payload.type === "drop") void uploadRef.current(payload.paths);
    }).then((remove) => {
      if (disposed) remove();
      else unsubscribe = remove;
    }).catch((cause) => {
      if (!disposed) setError(errorMessage(cause));
    });
    return () => { disposed = true; unsubscribe?.(); };
  }, [connected]);

  const chooseUpload = async () => {
    try {
      const selected = await open({ multiple: true, directory: false });
      if (selected) upload(Array.isArray(selected) ? selected : [selected]);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const download = async (entry: RemoteEntry) => {
    setMenu(null);
    if (!backendId || !path || transferBusy.current || /[\/\0]/.test(entry.name) || entry.name === ".." || entry.name === ".") return;
    transferBusy.current = true;
    setStatus(null);
    setError(null);
    try {
      const local = await chooseDownloadPath(entry.name);
      if (!local) return;
      setTransfer(`正在下载 · ${entry.name}`);
      await sessionTransfer(backendId, { kind: "download", remote: normalize(path) + entry.name, local });
      setStatus(`已下载 · ${entry.name}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      transferBusy.current = false;
      setTransfer(null);
    }
  };

  const openEntry = async (entry: RemoteEntry) => {
    if (!backendId || !path || transferBusy.current) return;
    const remote = normalize(path) + entry.name;
    if (entry.isDir) return load(remote);
    transferBusy.current = true;
    setTransfer(`正在打开 · ${entry.name}`);
    setError(null);
    try { setPreview({ name: entry.name, content: await previewFile(backendId, remote) }); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { transferBusy.current = false; setTransfer(null); }
  };

  const current = normalize(path ?? "/");
  const segments = current.split("/").filter(Boolean);
  const activeUpload = uploads.jobs.find((job) => job.state === "uploading");
  const waiting = uploads.jobs.filter((job) => job.state === "queued").length;
  const completed = uploads.jobs.filter((job) => job.state === "completed").length;
  const failed = uploads.jobs.filter((job) => job.state === "failed").length;
  const shownUpload = activeUpload ?? uploads.jobs.at(-1);
  const percent = !shownUpload ? 0 : shownUpload.state === "completed" ? 100 : shownUpload.total === null ? null
    : shownUpload.total === 0 ? 0 : Math.min(100, Math.max(0, shownUpload.transferred / shownUpload.total * 100));
  const queueLabels = { queued: "等待上传", uploading: "上传中", completed: "已完成", failed: "失败" };

  return (
    <div className={`file-browser${dragging ? " is-drop-target" : ""}`} ref={browser}>
      {connected && backendId && <div className="file-path">
        <button type="button" className="file-up" disabled={!!transfer} onClick={() => void load(parentPath(current))} title="上级目录">
          ↑
        </button>
        <button type="button" className="file-crumb" disabled={!!transfer} onClick={() => void load("/")} title="根目录">
          /
        </button>
        {segments.map((segment, index) => {
          const target = `/${segments.slice(0, index + 1).join("/")}/`;
          return (
            <button key={target} type="button" className="file-crumb" disabled={!!transfer} onClick={() => void load(target)}>
              {segment}
            </button>
          );
        })}
        <button type="button" className="file-refresh" disabled={!!transfer} onClick={() => void load(path ?? ".")} title="刷新">
          ↻
        </button>
      </div>}

      <ul className="file-list">
        {(!connected || !backendId) && <li className="file-empty">先连接一台服务器，再查看远程文件。</li>}
        {loading && entries.length === 0 ? <li className="file-empty">读取中…</li> : null}
        {connected && backendId && !loading && entries.length === 0 && !error ? <li className="file-empty">空目录</li> : null}
        {entries.map((entry) => (
          <li key={entry.name}>
            <button type="button" title={entry.name} aria-pressed={selected === entry.name}
              className={`file-row${entry.isDir ? " is-dir" : ""}`}
              disabled={loading || !!transfer}
              onClick={() => setSelected(entry.name)}
              onDoubleClick={() => void openEntry(entry)}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); void openEntry(entry); }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setSelected(entry.name);
                if (!entry.isDir && !transferBusy.current) setMenu({ entry, x: event.clientX, y: event.clientY });
              }}>
              <span className="file-icon">{entry.isDir ? "▸" : "·"}</span>
              <span className="file-name">{entry.name}</span>
              {!entry.isDir && <span className="file-size">{formatSize(entry.size)}</span>}
            </button>
          </li>
        ))}
      </ul>
      <footer className="file-transfer-footer" aria-label="文件传输">
        <div className="file-transfer-bar">
          <button type="button" className="button button-small" disabled={!backendId || !connected || !path || loading} onClick={() => void chooseUpload()}>
            {activeUpload || waiting ? "添加文件" : "上传文件"}
          </button>
          <span>{dragging ? "松开加入上传队列" : "可多选或拖入多个文件"}</span>
        </div>
        {(transfer || status) && <p className="file-transfer-status" role="status">{transfer || status}</p>}
        {error && <p className="file-error">{error}</p>}
        {uploads.jobs.length > 0 && <>
          <div className="file-upload-summary">
            <span role="status">{activeUpload ? `正在上传 · ${activeUpload.name}` : `已上传 ${completed}/${uploads.jobs.length} 个文件`}</span>
            {(completed > 0 || failed > 0) && <button type="button" onClick={clearFinishedUploads}>清除记录</button>}
          </div>
          {shownUpload && <p className="file-upload-target" title={`${shownUpload.sessionName} · ${shownUpload.directory}`}>
            {shownUpload.sessionName} · {shownUpload.directory}
          </p>}
          <ul className="file-upload-queue" aria-label="上传队列">
            {uploads.jobs.map((job) => <li key={job.id} data-state={job.state}>
              <span title={`${job.name} → ${job.sessionName} · ${job.directory}`}>{job.name}</span><small>{queueLabels[job.state]}</small>
              {job.error && <p>{job.error}</p>}
            </li>)}
          </ul>
        </>}
        <div className="file-upload-meter">
          <span>{activeUpload && percent === 100 ? "正在保存远端文件…" : shownUpload?.total != null ? `${formatSize(shownUpload.transferred)} / ${formatSize(shownUpload.total)}` : "上传进度"}</span>
          <span>{waiting > 0 ? `等待 ${waiting} 个 · ` : ""}{percent === null ? "准备中…" : `${Math.floor(percent)}%`}</span>
        </div>
        <progress className="file-upload-progress" aria-label="上传进度" max={100} value={percent ?? undefined} />
      </footer>
      {preview && <Modal title={preview.name} onClose={() => setPreview(null)} width="wide">
        <pre className="file-preview">{preview.content}</pre>
      </Modal>}
      {menu && (
        <div className="file-menu-backdrop" onMouseDown={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null); }}>
          <div className="file-menu" style={{ left: Math.min(menu.x, window.innerWidth - 130), top: Math.min(menu.y, window.innerHeight - 45) }} onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" autoFocus onClick={() => void download(menu.entry)} onKeyDown={(event) => { if (event.key === "Escape") setMenu(null); }}>下载</button>
          </div>
        </div>
      )}
    </div>
  );
}
