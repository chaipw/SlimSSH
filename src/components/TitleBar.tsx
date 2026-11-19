import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export type ThemeMode = "dark" | "light";

interface TitleBarProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

export default function TitleBar({ theme, onToggleTheme, onOpenSettings, sidebarCollapsed, onToggleSidebar }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (!isTauri) return;
    const win = getCurrentWindow();
    let disposed = false;

    const sync = () => {
      void win.isMaximized().then((value) => {
        if (!disposed) setMaximized(value);
      }).catch(() => {});
    };

    sync();
    let unlistenResize: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;

    void win.onResized(sync).then((fn) => {
      if (disposed) fn();
      else unlistenResize = fn;
    }).catch(() => {});

    void win.onFocusChanged((event) => {
      if (!disposed) setActive(event.payload);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenFocus = fn;
    }).catch(() => {});

    return () => {
      disposed = true;
      unlistenResize?.();
      unlistenFocus?.();
    };
  }, []);

  const invoke = (action: "minimize" | "toggleMaximize" | "close") => {
    if (!isTauri) return;
    const win = getCurrentWindow();
    const pending = action === "minimize"
      ? win.minimize()
      : action === "toggleMaximize"
        ? win.toggleMaximize()
        : win.close();
    void pending.catch(() => {});
  };

  return (
    <header className={`titlebar${active ? "" : " is-inactive"}`} data-tauri-drag-region>
      <div className="titlebar-brand" data-tauri-drag-region>
        <div className="brand-mark" aria-hidden="true">&gt;_</div>
        <strong>SlimSSH</strong>
        <span>安全终端工作台</span>
        <button type="button" className="window-control sidebar-toggle" onClick={onToggleSidebar}
          aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          aria-expanded={!sidebarCollapsed} aria-controls="slimssh-sidebar">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
            <path d="M5.5 3v10" />
            <path d={sidebarCollapsed ? "m8 5.5 2.5 2.5L8 10.5" : "m11 5.5-2.5 2.5 2.5 2.5"} />
          </svg>
        </button>
      </div>

      <button type="button" className="window-control display-settings-toggle" onClick={onOpenSettings} aria-label="显示设置" title="显示设置" aria-haspopup="dialog">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 4h12M2 8h12M2 12h12M5 2.5v3M11 6.5v3M6 10.5v3" />
        </svg>
        <span>设置</span>
      </button>
      <div className="titlebar-drag" data-tauri-drag-region />

      <div className="window-controls">
        <button
          type="button"
          className="window-control theme-toggle"
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
        >
          {theme === "dark" ? (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="3.2" />
              <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.05 3.05l1.13 1.13M11.82 11.82l1.13 1.13M12.95 3.05l-1.13 1.13M4.18 11.82l-1.13 1.13" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M13.5 9.8A5.8 5.8 0 0 1 6.2 2.5a5.8 5.8 0 1 0 7.3 7.3Z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="window-control"
          onClick={() => invoke("minimize")}
          aria-label="最小化"
          title="最小化"
        >
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5.5h6" /></svg>
        </button>
        <button
          type="button"
          className="window-control"
          onClick={() => invoke("toggleMaximize")}
          aria-label={maximized ? "向下还原" : "最大化"}
          title={maximized ? "向下还原" : "最大化"}
        >
          {maximized ? (
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <rect x="1.5" y="3.5" width="5" height="5" />
              <path d="M3.5 3.5V1.5h5v5h-2" />
            </svg>
          ) : (
            <svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" /></svg>
          )}
        </button>
        <button
          type="button"
          className="window-control close"
          onClick={() => invoke("close")}
          aria-label="关闭"
          title="关闭"
        >
          <svg viewBox="0 0 10 10" aria-hidden="true"><path d="m1.5 1.5 7 7m0-7-7 7" /></svg>
        </button>
      </div>
    </header>
  );
}
