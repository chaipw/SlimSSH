import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { decodeBase64 } from "../lib/base64";
import { Highlighter } from "../lib/highlight";
import { copySelection, isCopyShortcut, isPasteShortcut, readClipboard } from "../lib/terminalKeys";
import {
  createSessionChannel,
  errorMessage,
  hostKeyDecision,
  knownHostsForget,
  openSession,
  sessionClose,
  sessionInput,
  sessionOutputAck,
  sessionResize,
} from "../lib/ipc";
import type {
  HostKeyDecision,
  ProfileView,
  SessionEvent,
  SessionState,
} from "../types";
import HostKeyDialog, { type HostKeyPrompt } from "./HostKeyDialog";

const DARK_TERM = {
  background: "#1e2422",
  foreground: "#c9cfc9",
  cursor: "#e6b455",
  cursorAccent: "#1e2422",
  selectionBackground: "#33484a",
  black: "#232a28",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#c9cfc9",
  brightBlack: "#6b7a75",
  brightRed: "#ef8087",
  brightGreen: "#a9d48c",
  brightYellow: "#f0cd8a",
  brightBlue: "#76bdf5",
  brightMagenta: "#d290e8",
  brightCyan: "#68c8d4",
  brightWhite: "#eef3ef",
};

const LIGHT_TERM = {
  background: "#fbfcfb",
  foreground: "#1f2622",
  cursor: "#216e39",
  cursorAccent: "#fbfcfb",
  selectionBackground: "#c6dfd0",
  selectionForeground: "#141d18",
  black: "#1f2622",
  red: "#a8322f",
  green: "#216e39",
  yellow: "#7a5c00",
  blue: "#0b5394",
  magenta: "#7b2b86",
  cyan: "#16606b",
  white: "#4a5550",
  brightBlack: "#5f6a64",
  brightRed: "#c0392b",
  brightGreen: "#2e7d32",
  brightYellow: "#8a6400",
  brightBlue: "#1565c0",
  brightMagenta: "#8e24aa",
  brightCyan: "#00707c",
  brightWhite: "#2b3531",
};
const LIGHT_MINIMUM_CONTRAST = 5;

function terminalLineHeight(fontSize: number, gutterFontSize: number): number {
  return 1.12 * Math.max(1, gutterFontSize / fontSize);
}

interface TerminalViewProps {
  sessionId: string;
  profile: ProfileView;
  active: boolean;
  focused?: boolean;
  side?: "left" | "right";
  highlight: boolean;
  theme: "dark" | "light";
  fontSize: number;
  gutterFontSize: number;
  onStateChange: (sessionId: string, state: SessionState) => void;
  onBackendId: (sessionId: string, backendId: string) => void;
  onError: (sessionId: string, message: string) => void;
  onClosed: (sessionId: string, reason: string) => void;
  onActivate: (sessionId: string) => void;
  onReconnect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
}

export default function TerminalView({
  sessionId,
  profile,
  active,
  focused = active,
  side,
  highlight,
  theme,
  fontSize,
  gutterFontSize,
  onStateChange,
  onBackendId,
  onError,
  onClosed,
  onActivate,
  onReconnect,
  onClose,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const highlighterRef = useRef<Highlighter | null>(null);
  const themeRef = useRef(theme);
  const activeRef = useRef(active);
  const fitNowRef = useRef<() => void>(() => undefined);
  const scheduleFitRef = useRef<() => void>(() => undefined);
  const sessionPromiseRef = useRef<Promise<string> | null>(null);
  const callbacksRef = useRef({ onStateChange, onBackendId, onError, onClosed, onActivate, onReconnect, onClose });
  const highlightRef = useRef(highlight);
  const [hostPrompt, setHostPrompt] = useState<HostKeyPrompt | null>(null);

  activeRef.current = active;
  highlightRef.current = highlight;
  callbacksRef.current = { onStateChange, onBackendId, onError, onClosed, onActivate, onReconnect, onClose };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let closeRequested = false;
    let closedReceived = false;
    let frame: number | null = null;

    const terminal = new Terminal({
      scrollback: 5000,
      fontFamily: 'Consolas, "Cascadia Mono", "Microsoft YaHei UI", monospace',
      fontSize,
      fontWeight: 400,
      fontWeightBold: 500,
      lineHeight: terminalLineHeight(fontSize, gutterFontSize),
      cursorBlink: true,
      cursorStyle: "bar",
      scrollOnUserInput: true,
      theme: themeRef.current === "light" ? LIGHT_TERM : DARK_TERM,
      minimumContrastRatio: themeRef.current === "light" ? LIGHT_MINIMUM_CONTRAST : 1,
    });
    const fitAddon = new FitAddon();
    const highlighter = new Highlighter(themeRef.current === "light");
    highlighterRef.current = highlighter;
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    if (activeRef.current) fitAddon.fit();

    const gutter = gutterRef.current;
    const lineTimes = new Map<number, number>();
    let firstRow = 0;
    let lastRow = -1;
    let gutterFrame: number | null = null;

    // xterm's public buffer indices are relative to its retained scrollback.
    type Scrollback = { onTrim: (listener: (count: number) => void) => { dispose(): void } };
    const core = (terminal as unknown as { _core?: { buffers: { normal: { lines: Scrollback } } } })._core;
    const onTrim = (count: number) => {
      const nextFirst = firstRow + count;
      for (let row = firstRow; row < nextFirst; row += 1) lineTimes.delete(row);
      firstRow = nextFirst;
    };
    let scrollback = core?.buffers.normal.lines;
    let trimDisposable = scrollback?.onTrim(onTrim);

    const formatClock = (stamp: number) => {
      const date = new Date(stamp);
      const pad = (value: number) => String(value).padStart(2, "0");
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    };

    const measureGutter = () => {
      if (!gutter) return;
      const screen = container.querySelector<HTMLElement>(".xterm-screen");
      const row = container.querySelector<HTMLElement>(".xterm-rows > div");
      const cellHeight = row?.getBoundingClientRect().height ?? 0;
      const gutterTop = (screen ?? container).getBoundingClientRect().top - gutter.getBoundingClientRect().top;
      gutter.style.paddingTop = `${gutterTop}px`;
      if (cellHeight > 0) gutter.style.setProperty("--term-line-height", `${cellHeight}px`);
    };

    const syncTimes = () => {
      const buffer = terminal.buffer.active;
      if (buffer.type === "alternate") return;
      const current = firstRow + buffer.baseY + buffer.cursorY;
      if (current > lastRow) {
        const now = Date.now();
        for (let row = Math.max(firstRow, lastRow + 1); row <= current; row += 1) lineTimes.set(row, now);
        lastRow = current;
      }
    };

    const paintGutter = () => {
      if (!gutter) return;
      const buffer = terminal.buffer.active;
      const top = firstRow + buffer.viewportY;
      gutter.style.setProperty("--term-line-digits", String(Math.max(4, String(lastRow).length)));
      const parts: string[] = [];
      for (let index = 0; index < terminal.rows; index += 1) {
        const absolute = top + index;
        const stamp = buffer.type === "alternate" ? undefined : lineTimes.get(absolute);
        parts.push(`<div>${stamp === undefined ? "" : `<span>[${formatClock(stamp)}]</span><span>${absolute}</span>`}</div>`);
      }
      gutter.innerHTML = parts.join("");
    };

    const scheduleGutter = () => {
      if (gutterFrame !== null) return;
      gutterFrame = requestAnimationFrame(() => {
        gutterFrame = null;
        measureGutter();
        syncTimes();
        paintGutter();
      });
    };

    terminal.onScroll(scheduleGutter);
    terminal.onResize(scheduleGutter);
    const bufferDisposable = terminal.buffer.onBufferChange(() => {
      const next = core?.buffers.normal.lines;
      if (next !== scrollback) {
        trimDisposable?.dispose();
        scrollback = next;
        trimDisposable = scrollback?.onTrim(onTrim);
        firstRow = lastRow + 1;
        lineTimes.clear();
      }
      scheduleGutter();
    });
    scheduleGutter();

    const pasteClipboard = () => {
      void readClipboard().then((text) => {
        if (text && !disposed && activeRef.current) terminal.paste(text);
      }).catch(reportError);
    };

    terminal.attachCustomKeyEventHandler((event) => {
      if (isPasteShortcut(event)) {
        event.preventDefault();
        pasteClipboard();
        return false;
      }
      const selection = terminal.getSelection();
      if (!isCopyShortcut(event, selection)) return true;
      void copySelection(selection).catch(reportError);
      return false;
    });

    const onContextMenu = (event: MouseEvent) => {
      if (event.button !== 2 || terminal.modes.mouseTrackingMode !== "none") return;
      event.preventDefault();
      event.stopPropagation();
      const selection = terminal.getSelection();
      terminal.focus();
      if (selection) {
        terminal.clearSelection();
        terminal.paste(selection);
        return;
      }
      pasteClipboard();
    };
    container.addEventListener("contextmenu", onContextMenu, true);

    let lastSentCols = terminal.cols;
    let lastSentRows = terminal.rows;
    const sessionPromise = Promise.resolve().then(() =>
      openSession(profile.id, terminal.cols, terminal.rows, channel),
    );
    sessionPromiseRef.current = sessionPromise;
    sessionPromise.then((backendId) => {
      if (!disposed) callbacksRef.current.onBackendId(sessionId, backendId);
    }).catch(() => undefined);

    const reportError = (error: unknown) => {
      if (!disposed && !closedReceived) callbacksRef.current.onError(sessionId, errorMessage(error));
    };

    const sendResize = () => {
      if (!activeRef.current || disposed) return;
      const proposed = fitAddon.proposeDimensions();
      if (!proposed || !proposed.cols || !proposed.rows) return;
      fitAddon.fit();
      scheduleGutter();
      const { cols, rows } = terminal;
      if (!cols || !rows || (cols === lastSentCols && rows === lastSentRows)) return;
      lastSentCols = cols;
      lastSentRows = rows;
      void sessionPromise
        .then((backendId) => {
          if (!disposed) return sessionResize(backendId, cols, rows);
        })
        .catch(reportError);
    };
    fitNowRef.current = sendResize;

    const scheduleFit = () => {
      if (disposed || !activeRef.current || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        sendResize();
      });
    };
    scheduleFitRef.current = scheduleFit;

    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(container);

    const inputDisposable = terminal.onData((data) => {
      void sessionPromise
        .then((backendId) => {
          if (!disposed) return sessionInput(backendId, data);
        })
        .catch(reportError);
    });

    const handleEvent = (event: SessionEvent) => {
      if (disposed) return;
      switch (event.type) {
        case "state":
          callbacksRef.current.onStateChange(sessionId, event.state);
          break;
        case "output": {
          const bytes = decodeBase64(event.data);
          const painted = highlightRef.current ? highlighter.process(bytes) : bytes;
          const acknowledge = () => {
            if (disposed) return;
            void sessionPromise
              .then((backendId) => {
                if (!disposed) return sessionOutputAck(backendId, event.seq);
              })
              .catch(reportError);
          };
          if (painted.length) terminal.write(painted, () => {
            acknowledge();
            scheduleGutter();
          });
          else {
            acknowledge();
            scheduleGutter();
          }
          break;
        }
        case "host_key_required":
          setHostPrompt({
            kind: "required",
            requestId: event.request_id,
            host: event.host,
            port: event.port,
            algorithm: event.algorithm,
            fingerprint: event.fingerprint,
          });
          callbacksRef.current.onActivate(sessionId);
          break;
        case "host_key_mismatch":
          setHostPrompt({
            kind: "mismatch",
            host: event.host,
            port: event.port,
            expected: event.expected,
            actual: event.actual,
          });
          callbacksRef.current.onActivate(sessionId);
          break;
        case "error":
          callbacksRef.current.onError(sessionId, event.code ? `${event.message}（${event.code}）` : event.message);
          break;
        case "closed":
          closedReceived = true;
          callbacksRef.current.onClosed(sessionId, event.reason || "连接已关闭");
          break;
      }
    };

    const channel = createSessionChannel(handleEvent);
    void sessionPromise.catch(reportError);

    return () => {
      disposed = true;
      fitNowRef.current = () => undefined;
      scheduleFitRef.current = () => undefined;
      resizeObserver.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      if (gutterFrame !== null) cancelAnimationFrame(gutterFrame);
      inputDisposable.dispose();
      container.removeEventListener("contextmenu", onContextMenu, true);
      bufferDisposable.dispose();
      trimDisposable?.dispose();
      terminal.dispose();
      sessionPromiseRef.current = null;
      if (!closeRequested) {
        closeRequested = true;
        void sessionPromise.then((backendId) => sessionClose(backendId)).catch(() => undefined);
      }
    };
  }, [profile.id, sessionId]);

  useLayoutEffect(() => {
    if (active) {
      fitNowRef.current();
      scheduleFitRef.current();
    }
    // A visible session can move into/out of a pane without changing `active`.
    // Explicitly refit on that layout change, including on WebViews where the
    // ResizeObserver notification can lag behind incoming SSH output.
  }, [active, side]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options = { fontSize, lineHeight: terminalLineHeight(fontSize, gutterFontSize) };
    scheduleFitRef.current();
  }, [fontSize, gutterFontSize]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options = {
      theme: theme === "light" ? LIGHT_TERM : DARK_TERM,
      minimumContrastRatio: theme === "light" ? LIGHT_MINIMUM_CONTRAST : 1,
    };
    themeRef.current = theme;
    highlighterRef.current?.setTheme(theme === "light");
  }, [theme]);

  const decideHostKey = async (decision: HostKeyDecision) => {
    if (!hostPrompt || hostPrompt.kind !== "required") return;
    const sessionPromise = sessionPromiseRef.current;
    if (!sessionPromise) throw new Error("会话已关闭，请重新连接。");
    await hostKeyDecision(await sessionPromise, hostPrompt.requestId, decision);
    setHostPrompt(null);
  };

  const forgetHostKey = async () => {
    if (!hostPrompt || hostPrompt.kind !== "mismatch") return;
    await knownHostsForget(hostPrompt.host, hostPrompt.port);
    callbacksRef.current.onReconnect(sessionId);
  };

  return (
    <section className="terminal-session" data-side={side} hidden={!active} aria-label={`${profile.name} 终端`}>
      <div className="term-shell" onFocusCapture={() => onActivate(sessionId)} onPointerDown={() => onActivate(sessionId)}>
        <div ref={gutterRef} className="term-gutter" aria-hidden="true" />
        <div ref={containerRef} className="terminal-host" />
      </div>
      {focused && hostPrompt && (
        <HostKeyDialog
          prompt={hostPrompt}
          onDecision={decideHostKey}
          onForget={forgetHostKey}
          onCloseConnection={() => callbacksRef.current.onClose(sessionId)}
        />
      )}
    </section>
  );
}
