import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "../types";
import TerminalView from "./TerminalView";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  dimensions: { cols: 80, rows: 24 },
  channels: [] as Array<{ onmessage: (event: SessionEvent) => void }>,
  terminals: [] as Array<{
    writes: Uint8Array[];
    writeCallbacks: Array<(() => void) | undefined>;
    dispose: ReturnType<typeof vi.fn>;
    buffer: { active: { baseY: number; cursorY: number; viewportY: number } };
    scroll: () => void;
    trim: (count: number) => void;
    selection: string;
    paste: ReturnType<typeof vi.fn>;
    keyHandler: (event: KeyboardEvent) => boolean;
  }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class<T> {
    onmessage: (event: T) => void = () => undefined;
    constructor() {
      mocks.channels.push(this as unknown as { onmessage: (event: SessionEvent) => void });
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    terminal?: { cols: number; rows: number };
    activate(terminal: { cols: number; rows: number }) { this.terminal = terminal; }
    fit = vi.fn(() => {
      if (this.terminal) Object.assign(this.terminal, mocks.dimensions);
    });
    proposeDimensions = vi.fn(() => mocks.dimensions);
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    writes: Uint8Array[] = [];
    writeCallbacks: Array<(() => void) | undefined> = [];
    dispose = vi.fn();
    options: Record<string, unknown> = {};

    constructor() {
      mocks.terminals.push(this);
    }
    loadAddon(addon: { activate(terminal: unknown): void }) { addon.activate(this); }
    open() {}
    onData() {
      return { dispose: vi.fn() };
    }
    selection = "";
    paste = vi.fn();
    focus() {}
    clearSelection() { this.selection = ""; }
    modes = { mouseTrackingMode: "none" };
    keyHandler = (_event: KeyboardEvent) => true;
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    getSelection() {
      return this.selection;
    }
    buffer = {
      active: { baseY: 0, cursorY: 0, viewportY: 0 },
      onBufferChange: () => ({ dispose: vi.fn() }),
    };
    scroll = () => {};
    trim = (_count: number) => {};
    _core = { buffers: { normal: { lines: { onTrim: (listener: (count: number) => void) => {
      this.trim = listener;
      return { dispose: vi.fn() };
    } } } } };
    onScroll(listener: () => void) {
      this.scroll = listener;
      return { dispose: vi.fn() };
    }
    onResize() {
      return { dispose: vi.fn() };
    }
    write(data: string | Uint8Array, callback?: () => void) {
      this.writes.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
      this.writeCallbacks.push(callback);
    }
  },
}));

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];
  private callback: ResizeObserverCallback;
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverMock.instances.push(this);
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const profile = {
  id: "profile-1",
  name: "服务器",
  host: "127.0.0.1",
  port: 22,
  username: "root",
  authMethod: "password" as const,
  hasSecret: true,
};

let root: Root | null = null;
let mountNode: HTMLDivElement;

async function renderTerminal(active = false, side?: "left" | "right") {
  await act(async () => {
    root ??= createRoot(mountNode);
    root.render(
      <TerminalView
        sessionId="local-1"
        profile={profile}
        active={active}
        side={side}
        highlight={false}
        theme="dark"
        fontSize={13}
        gutterFontSize={11}
        onStateChange={vi.fn()}
        onBackendId={vi.fn()}
        onError={vi.fn()}
        onClosed={vi.fn()}
        onActivate={vi.fn()}
        onReconnect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "session_open") return Promise.resolve("backend-1");
    return Promise.resolve(undefined);
  });
  mocks.channels.length = 0;
  mocks.dimensions = { cols: 80, rows: 24 };
  mocks.terminals.length = 0;
  ResizeObserverMock.instances = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 42));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  mountNode = document.createElement("div");
  document.body.appendChild(mountNode);
});

afterEach(async () => {
  if (root) {
    const currentRoot = root;
    root = null;
    await act(async () => currentRoot.unmount());
  }
  mountNode.remove();
  vi.unstubAllGlobals();
});

describe("TerminalView 输出与清理", () => {
  it("可见会话进入或退出分屏时立即调整列数并通知 SSH，不依赖尺寸观察器", async () => {
    await renderTerminal(true);
    mocks.invoke.mockClear();
    mocks.dimensions = { cols: 36, rows: 24 };
    await renderTerminal(true, "left");
    expect(mocks.invoke).toHaveBeenCalledWith("session_resize", { sessionId: "backend-1", cols: 36, rows: 24 });
    mocks.dimensions = { cols: 80, rows: 24 };
    await renderTerminal(true);
    expect(mocks.invoke).toHaveBeenLastCalledWith("session_resize", { sessionId: "backend-1", cols: 80, rows: 24 });
    expect(mocks.terminals).toHaveLength(1);
  });

  it("用 Ctrl+V 粘贴剪贴板，并用右键优先粘贴选区", async () => {
    await renderTerminal(true);
    const terminal = mocks.terminals[0];
    const shortcut = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, cancelable: true });
    const container = mountNode.querySelector(".terminal-host")!;
    const rightClick = () => container.dispatchEvent(new MouseEvent("contextmenu", { button: 2, cancelable: true }));
    const readText = vi.fn().mockResolvedValue("clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });
    try {
      terminal.selection = "selected";
      expect(rightClick()).toBe(false);
      expect(terminal.paste).toHaveBeenCalledWith("selected");
      expect(readText).not.toHaveBeenCalled();
      await act(async () => { rightClick(); });
      expect(terminal.paste).toHaveBeenCalledWith("clipboard");
      terminal.paste.mockClear();
      await act(async () => {
        expect(terminal.keyHandler(shortcut)).toBe(false);
        expect(shortcut.defaultPrevented).toBe(true);
      });
      expect(terminal.paste).toHaveBeenCalledExactlyOnceWith("clipboard");
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("显示完整的多位行号，并在滚动缓冲区淘汰旧行后继续编号", async () => {
    await renderTerminal();
    const terminal = mocks.terminals[0];
    const gutter = () => Array.from(mountNode.querySelectorAll(".term-gutter > div > span:last-child"), (node) => node.textContent);
    const paint = () => {
      const raf = vi.mocked(requestAnimationFrame);
      raf.mock.lastCall?.[0](0);
    };
    terminal.buffer.active.cursorY = 14;
    paint();
    expect(gutter().slice(8, 12)).toEqual(["8", "9", "10", "11"]);

    Object.assign(terminal.buffer.active, { baseY: 5000, cursorY: 23, viewportY: 5000 });
    terminal.scroll();
    paint();
    expect(gutter().at(-1)).toBe("5023");

    terminal.trim(2);
    terminal.scroll();
    paint();
    expect(gutter().slice(-3)).toEqual(["5023", "5024", "5025"]);
  });

  it("先写入完整字节，并只在 xterm 回调后 ACK 对应序号", async () => {
    await renderTerminal();
    const terminal = mocks.terminals[0];
    const channel = mocks.channels[0];
    expect(mocks.invoke).toHaveBeenCalledWith("session_open", expect.objectContaining({
      profileId: "profile-1",
      channel,
    }));

    const bytes = new Uint8Array([0, 255, 65, 66]);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    act(() => channel.onmessage({ type: "output", seq: 19, data: btoa(binary) }));

    expect(terminal.writes[0]).toEqual(bytes);
    expect(mocks.invoke).not.toHaveBeenCalledWith("session_output_ack", expect.anything());

    await act(async () => {
      terminal.writeCallbacks[0]?.();
      await Promise.resolve();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("session_output_ack", { sessionId: "backend-1", seq: 19 });
  });

  it("卸载时释放 xterm、观察器和 RAF，并关闭后端会话", async () => {
    await renderTerminal(true);
    const terminal = mocks.terminals[0];
    const observer = ResizeObserverMock.instances[0];
    act(() => observer.trigger());
    expect(requestAnimationFrame).toHaveBeenCalled();

    const currentRoot = root;
    root = null;
    await act(async () => {
      currentRoot?.unmount();
      await Promise.resolve();
    });

    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
    expect(mocks.invoke).toHaveBeenCalledWith("session_close", { sessionId: "backend-1" });
  });
});
