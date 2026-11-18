import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Modal from "./components/Modal";
import ProfileEditor from "./components/ProfileEditor";
import ProfileList from "./components/ProfileList";
import FileBrowser from "./components/FileBrowser";
import SessionTabs from "./components/SessionTabs";
import TerminalView from "./components/TerminalView";
import TitleBar, { type ThemeMode } from "./components/TitleBar";
import { deleteProfile, errorMessage, listProfiles, saveProfile } from "./lib/ipc";
import type {
  ProfileSavePayload,
  ProfileView,
  SessionState,
  WorkspaceSession,
} from "./types";

type EditorState = { mode: "new" } | { mode: "edit"; profile: ProfileView } | null;

const DISPLAY_FIELDS = [
  { key: "terminal", label: "终端正文", min: 8, max: 28 },
  { key: "gutter", label: "时间戳和行号", min: 8, max: 24 },
  { key: "tabs", label: "会话标签栏", min: 8, max: 24 },
] as const;
type DisplaySizes = Record<(typeof DISPLAY_FIELDS)[number]["key"], number>;
const DISPLAY_STORAGE = "slimssh:display-sizes";
const DEFAULT_DISPLAY_SIZES: DisplaySizes = { terminal: 13, gutter: 11, tabs: 12 };

function loadDisplaySizes(): DisplaySizes {
  try {
    const saved = JSON.parse(localStorage.getItem(DISPLAY_STORAGE) ?? "null") as Partial<DisplaySizes> | null;
    const sizes = { ...DEFAULT_DISPLAY_SIZES };
    for (const { key, min, max } of DISPLAY_FIELDS) {
      const value = saved?.[key];
      if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) sizes[key] = value;
    }
    return sizes;
  } catch {
    return DEFAULT_DISPLAY_SIZES;
  }
}

function newWorkspaceSession(profile: ProfileView, instance: number): WorkspaceSession {
  return {
    id: crypto.randomUUID(),
    instance,
    profile,
    state: "connecting",
    error: null,
    closedReason: null,
    backendId: null,
  };
}

function statusLabel(session: WorkspaceSession): string {
  if (session.closedReason) return "已断开";
  if (session.error) return "连接异常";
  const labels: Record<SessionState, string> = {
    connecting: "正在连接",
    verifying_host_key: "验证主机密钥",
    authenticating: "正在认证",
    ready: "已连接",
  };
  return labels[session.state];
}

export default function App() {
  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [displaySettingsOpen, setDisplaySettingsOpen] = useState(false);
  const [displaySizes, setDisplaySizes] = useState(loadDisplaySizes);
  const [deleting, setDeleting] = useState<ProfileView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<WorkspaceSession[]>([]);
  const sessionCounts = useRef(new Map<string, number>());
  const [split, setSplit] = useState<{ left: string; right: string } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(() => localStorage.getItem("slimssh:highlight") !== "off");
  const [sidebarTab, setSidebarTab] = useState<"connections" | "files">("connections");
  const [theme, setTheme] = useState<ThemeMode>(() =>
    localStorage.getItem("slimssh:theme") === "light" ? "light" : "dark",
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("slimssh:theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(DISPLAY_STORAGE, JSON.stringify(displaySizes));
  }, [displaySizes]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }, []);

  const toggleHighlight = () => {
    setHighlight((current) => {
      const next = !current;
      localStorage.setItem("slimssh:highlight", next ? "on" : "off");
      return next;
    });
  };

  const fetchProfiles = useCallback(async () => {
    const result = await listProfiles();
    setProfiles(result);
    setProfilesError(null);
  }, []);

  useEffect(() => {
    let mounted = true;
    listProfiles()
      .then((result) => {
        if (!mounted) return;
        setProfiles(result);
        setProfilesError(null);
      })
      .catch((error) => {
        if (mounted) setProfilesError(errorMessage(error));
      })
      .finally(() => {
        if (mounted) setProfilesLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const retryProfiles = async () => {
    setProfilesLoading(true);
    try {
      await fetchProfiles();
    } catch (error) {
      setProfilesError(errorMessage(error));
    } finally {
      setProfilesLoading(false);
    }
  };

  const handleSaveProfile = async (input: ProfileSavePayload) => {
    await saveProfile(input);
    setEditor(null);
    try {
      await fetchProfiles();
    } catch (error) {
      setProfilesError(errorMessage(error));
    }
  };

  const handleDeleteProfile = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteProfile(deleting.id);
      setProfiles((current) => current.filter((profile) => profile.id !== deleting.id));
      setDeleting(null);
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setDeleteBusy(false);
    }
  };

  const connect = (profile: ProfileView) => {
    const instance = (sessionCounts.current.get(profile.id) ?? 0) + 1;
    sessionCounts.current.set(profile.id, instance);
    const session = newWorkspaceSession(profile, instance);
    setSessions((current) => [...current, session]);
    setSplit((current) => current && { ...current, left: session.id });
    setActiveId(session.id);
  };

  const selectSession = (id: string) => {
    setSplit((current) => {
      if (!current || id === current.left || id === current.right) return current;
      return { ...current, left: id };
    });
    setActiveId(id);
  };

  const toggleSplit = () => {
    if (split) {
      setSplit(null);
      return;
    }
    const other = sessions.find((session) => session.id !== activeId);
    if (activeId && other) setSplit({ left: activeId, right: other.id });
  };

  const moveSession = (source: string, target: string) => {
    if (source === target) return;
    setSessions((current) => {
      const from = current.findIndex((session) => session.id === source);
      const to = current.findIndex((session) => session.id === target);
      if (from < 0 || to < 0) return current;
      const reordered = [...current];
      const [moved] = reordered.splice(from, 1);
      reordered.splice(to, 0, moved);
      return reordered;
    });
  };

  const reconnect = useCallback((id: string) => {
    const existing = sessions.find((session) => session.id === id);
    if (!existing) return;
    const replacement = newWorkspaceSession(existing.profile, existing.instance);
    setSessions((current) => current.map((session) => session.id === id ? replacement : session));
    setSplit((current) => current && ({
      left: current.left === id ? replacement.id : current.left,
      right: current.right === id ? replacement.id : current.right,
    }));
    setActiveId(replacement.id);
  }, [sessions]);

  const closeSession = useCallback((id: string) => {
    const index = sessions.findIndex((session) => session.id === id);
    if (index < 0) return;
    const remaining = sessions.filter((session) => session.id !== id);
    setSessions(remaining);
    const leftFallback = remaining.find((session) => session.id !== split?.right)?.id;
    if (split?.right === id || (split?.left === id && !leftFallback)) {
      setSplit(null);
    } else if (split?.left === id && leftFallback) {
      setSplit({ ...split, left: leftFallback });
    }
    if (activeId === id) {
      setActiveId(split?.left === id && leftFallback ? leftFallback : remaining[Math.min(index, remaining.length - 1)]?.id ?? null);
    }
  }, [activeId, sessions, split]);

  const handleStateChange = useCallback((id: string, state: SessionState) => {
    setSessions((current) => current.map((session) => session.id === id ? {
      ...session,
      state,
      error: state === "ready" ? null : session.error,
      closedReason: null,
    } : session));
  }, []);

  const handleBackendId = useCallback((id: string, backendId: string) => {
    setSessions((current) => current.map((session) => session.id === id ? {
      ...session,
      backendId,
    } : session));
  }, []);

  const handleSessionError = useCallback((id: string, message: string) => {
    setSessions((current) => current.map((session) => session.id === id ? { ...session, error: message } : session));
  }, []);

  const handleSessionClosed = useCallback((id: string, reason: string) => {
    setSessions((current) => current.map((session) => session.id === id ? { ...session, closedReason: reason } : session));
  }, []);

  const sessionTabs = sessions.map((session) => ({
    id: session.id,
    name: session.instance === 1 ? session.profile.name : `${session.profile.name} (${session.instance})`,
    detail: `${session.profile.username}@${session.profile.host}:${session.profile.port}`,
    state: session.state,
    error: session.error !== null,
    closed: session.closedReason !== null,
  }));
  const activeSession = sessions.find((session) => session.id === activeId) ?? null;
  const activeProfileIds = useMemo(
    () => new Set(sessions.filter((session) => !session.closedReason).map((session) => session.profile.id)),
    [sessions],
  );

  return (
    <div className="app-shell" style={{
      "--term-gutter-font-size": `${displaySizes.gutter}px`,
      "--session-tab-font-size": `${displaySizes.tabs}px`,
    } as CSSProperties}>
      <TitleBar theme={theme} onToggleTheme={toggleTheme} onOpenSettings={() => setDisplaySettingsOpen(true)} />

      <div className="app-body">
      <aside className="sidebar" aria-label="侧栏">
        <nav className="sidebar-tabs">
          <button
            type="button"
            className={`sidebar-tab${sidebarTab === "connections" ? " is-active" : ""}`}
            onClick={() => setSidebarTab("connections")}
          >
            连接
          </button>
          <button
            type="button"
            className={`sidebar-tab${sidebarTab === "files" ? " is-active" : ""}`}
            onClick={() => setSidebarTab("files")}
          >
            文件
          </button>
        </nav>
        {sidebarTab === "connections" ? (
          <ProfileList
            profiles={profiles}
            loading={profilesLoading}
            activeProfileIds={activeProfileIds}
            onNew={() => setEditor({ mode: "new" })}
            onEdit={(profile) => setEditor({ mode: "edit", profile })}
            onDelete={(profile) => {
              setDeleteError(null);
              setDeleting(profile);
            }}
            onConnect={connect}
          />
        ) : (
          <FileBrowser
            key={activeSession?.backendId ?? "no-session"}
            backendId={activeSession?.backendId ?? null}
            connected={activeSession?.state === "ready"}
          />
        )}
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div className="workspace-title">
            <span className="eyebrow">TERMINAL WORKSPACE</span>
            <strong>{activeSession?.profile.name ?? "终端工作台"}</strong>
          </div>
          {activeSession ? (
            <div className="connection-summary">
              <span className={`summary-dot${activeSession.error || activeSession.closedReason ? " amber" : activeSession.state === "ready" ? " cyan" : ""}`} aria-hidden="true" />
              <span>{statusLabel(activeSession)}</span>
              <span className="summary-divider" aria-hidden="true" />
              <code>{activeSession.profile.username}@{activeSession.profile.host}:{activeSession.profile.port}</code>
            </div>
          ) : (
            <span className="workspace-idle"><span className="status-led" aria-hidden="true" /> 本地终端待命</span>
          )}
        </header>

        {sessionTabs.length > 0 && (
          <div className={`workspace-tabbar${split ? " is-split" : ""}`}>
            {(split ? (["left", "right"] as const) : [null]).map((side) => {
              const paneId = side && split ? split[side] : null;
              const tabs = side && split ? sessionTabs.filter((tab) => side === "right" ? tab.id === split.right : tab.id !== split.right) : sessionTabs;
              const otherId = side && split ? split[side === "left" ? "right" : "left"] : null;
              return (
                <div className="workspace-tab-pane" key={side ?? "single"}>
                  <SessionTabs
                    sessions={tabs}
                    activeId={paneId ?? activeId}
                    label={side === "left" ? "左侧会话" : side === "right" ? "右侧会话" : "已打开的终端"}
                    onSelect={selectSession}
                    onMove={moveSession}
                    onClose={closeSession}
                  />
                  {side && sessionTabs.length > 2 && (
                    <select className="pane-session-picker" aria-label={side === "left" ? "切换左侧会话" : "切换右侧会话"}
                      value="" onChange={(event) => {
                        const id = event.currentTarget.value;
                        if (!id) return;
                        setSplit((current) => current && { ...current, [side]: id });
                        setActiveId(id);
                      }}>
                      <option value="">切换会话</option>
                      {sessionTabs.filter((tab) => tab.id !== paneId && tab.id !== otherId).map((tab) => (
                        <option key={tab.id} value={tab.id}>{tab.name}</option>
                      ))}
                    </select>
                  )}
                  {side !== "left" && (
                    <button type="button" className="button button-small split-toggle" aria-pressed={!!split}
                      disabled={sessions.length < 2} onClick={toggleSplit}>
                      {split ? "退出分屏" : "左右分屏"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {profilesError && (
          <div className="error-banner" role="alert">
            <div><strong>连接配置读取失败</strong><span>{profilesError}</span></div>
            <button type="button" className="button button-small button-secondary" onClick={() => void retryProfiles()} disabled={profilesLoading}>
              {profilesLoading ? "重试中…" : "重试"}
            </button>
          </div>
        )}

        {activeSession?.error && (
          <div className="error-banner session-error" role="alert">
            <div><strong>会话发生错误</strong><span>{activeSession.error}</span></div>
            <div className="banner-actions">
              <button type="button" className="text-button" onClick={() => setSessions((current) => current.map((session) => session.id === activeSession.id ? { ...session, error: null } : session))}>忽略</button>
              <button type="button" className="button button-small button-secondary" onClick={() => reconnect(activeSession.id)}>重新连接</button>
            </div>
          </div>
        )}

        {activeSession?.closedReason && (
          <div className="closed-banner" role="status">
            <span>{activeSession.closedReason}</span>
            <button type="button" className="button button-small button-secondary" onClick={() => reconnect(activeSession.id)}>重新连接</button>
          </div>
        )}

        {sessions.length === 0 ? (
          <section className="empty-workspace">
            <div className="empty-terminal" aria-hidden="true">
              <div className="empty-terminal-bar"><i /><i /><i /></div>
              <div className="empty-terminal-body"><span>&gt;</span><b>_</b></div>
            </div>
            <p className="eyebrow">SECURE SHELL</p>
            <h2>选择一个连接开始工作</h2>
            <p>从左侧打开已保存的主机，或创建新的 SSH 连接。每个会话将在独立标签中保持运行。</p>
            <button type="button" className="button button-primary" onClick={() => setEditor({ mode: "new" })}>
              <span aria-hidden="true">＋</span> 新建连接
            </button>
            <div className="empty-meta"><span>SSH</span><i /><span>UTF-8</span><i /><span>多会话</span></div>
          </section>
        ) : (
          <div className={`terminal-stack${split ? " is-split" : ""}`}>
            {sessions.map((session) => (
              <TerminalView
                key={session.id}
                sessionId={session.id}
                profile={session.profile}
                active={split ? session.id === split.left || session.id === split.right : session.id === activeId}
                focused={session.id === activeId}
                side={split ? (session.id === split.right ? "right" : "left") : undefined}
                highlight={highlight}
                theme={theme}
                fontSize={displaySizes.terminal}
                gutterFontSize={displaySizes.gutter}
                onStateChange={handleStateChange}
                onBackendId={handleBackendId}
                onError={handleSessionError}
                onClosed={handleSessionClosed}
                onActivate={setActiveId}
                onReconnect={reconnect}
                onClose={closeSession}
              />
            ))}
          </div>
        )}

        <footer className="workspace-statusbar">
          <span><i className={`status-led${activeSession?.state === "ready" && !activeSession.error ? " ready" : ""}`} />{activeSession ? statusLabel(activeSession) : "无活动会话"}</span>
          <div>
            <button
              type="button"
              className={`status-toggle${highlight ? " is-on" : ""}`}
              onClick={toggleHighlight}
              aria-pressed={highlight}
              title="对日志中的时间戳、级别、IP、URL 等语义着色（全屏程序不受影响）"
            >
              语义高亮
            </button>
            <span>UTF-8</span><span>SSH</span><span>{sessions.length} 个会话</span>
          </div>
        </footer>
      </main>
      </div>

      {displaySettingsOpen && (
        <Modal title="显示设置" onClose={() => setDisplaySettingsOpen(false)} width="narrow">
          <div className="modal-body display-settings">
            {DISPLAY_FIELDS.map(({ key, label, min, max }) => (
              <label className="display-size" key={key}>
                <span>{label}</span>
                <output>{displaySizes[key]} px</output>
                <input
                  type="range"
                  aria-label={label}
                  min={min}
                  max={max}
                  value={displaySizes[key]}
                  onChange={(event) => {
                    const value = event.currentTarget.valueAsNumber;
                    setDisplaySizes((current) => ({ ...current, [key]: value }));
                  }}
                />
              </label>
            ))}
          </div>
          <footer className="modal-footer">
            <button type="button" className="button button-secondary" onClick={() => setDisplaySizes(DEFAULT_DISPLAY_SIZES)}>恢复默认</button>
            <button type="button" className="button button-primary" onClick={() => setDisplaySettingsOpen(false)}>完成</button>
          </footer>
        </Modal>
      )}

      {editor && (
        <ProfileEditor
          key={editor.mode === "edit" ? editor.profile.id : "new"}
          profile={editor.mode === "edit" ? editor.profile : undefined}
          onSave={handleSaveProfile}
          onCancel={() => setEditor(null)}
        />
      )}

      {deleting && (
        <Modal
          title="删除连接"
          description="此操作仅删除本地连接配置，且无法撤销。"
          onClose={() => setDeleting(null)}
          closeDisabled={deleteBusy}
          width="narrow"
        >
          <div className="modal-body">
            <div className="delete-target">
              <strong>{deleting.name}</strong>
              <code>{deleting.username}@{deleting.host}:{deleting.port}</code>
            </div>
            <p className="delete-warning">已打开的相关终端不会被自动关闭。</p>
            {deleteError && <div className="form-error" role="alert">{deleteError}</div>}
          </div>
          <footer className="modal-footer">
            <button type="button" className="button button-secondary" onClick={() => setDeleting(null)} disabled={deleteBusy}>取消</button>
            <button type="button" className="button button-danger" onClick={() => void handleDeleteProfile()} disabled={deleteBusy}>
              {deleteBusy ? "删除中…" : "确认删除"}
            </button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
