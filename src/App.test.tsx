import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import App from "./App";

const profile = vi.hoisted(() => ({ id: "demo", name: "测试机", host: "192.0.2.1", port: 22, username: "demo", authMethod: "password", hasSecret: true }));
vi.mock("./lib/ipc", () => ({ listProfiles: () => Promise.resolve([profile]), errorMessage: String }));
vi.mock("./components/ProfileList", () => ({ default: ({ onConnect }: any) => <button onClick={() => onConnect(profile)}>打开测试会话</button> }));
vi.mock("./components/FileBrowser", () => ({ default: ({ backendId, workingDirectory }: any) => <output data-files>{backendId}:{workingDirectory}</output> }));
vi.mock("./components/TerminalView", () => ({ default: (props: any) => {
  useEffect(() => {
    props.onBackendId(props.sessionId, props.sessionId);
    props.onStateChange(props.sessionId, "ready");
    props.onDirectoryChange(props.sessionId, "/home/demo");
  }, [props.sessionId]);
  return <section data-terminal={props.sessionId} hidden={!props.active}>
    <button data-focus onClick={() => props.onActivate(props.sessionId)}>选中会话</button>
    <button data-cd onClick={() => props.onDirectoryChange(props.sessionId, "/home/demo/test1")}>目录变化</button>
  </section>;
} }));

it("split file pane follows the clicked session and keeps background directory updates separate", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  const click = async (button: HTMLButtonElement) => { await act(async () => button.click()); };
  try {
    await act(async () => root.render(<App />));
    const connect = () => Array.from(mount.querySelectorAll("button")).find((button) => button.textContent === "打开测试会话")!;
    await click(connect());
    await click(connect());
    await click(Array.from(mount.querySelectorAll("button")).find((button) => button.textContent === "左右分屏")!);
    await click(Array.from(mount.querySelectorAll("button")).find((button) => button.textContent === "文件")!);
    const terminals = mount.querySelectorAll<HTMLElement>("[data-terminal]");
    const first = terminals[0].dataset.terminal!;
    const second = terminals[1].dataset.terminal!;
    expect(mount.querySelector("[data-files]")?.textContent).toBe(`${second}:/home/demo`);
    await click(terminals[0].querySelector("[data-cd]")!);
    expect(mount.querySelector("[data-files]")?.textContent).toBe(`${second}:/home/demo`);
    await click(terminals[0].querySelector("[data-focus]")!);
    expect(mount.querySelector("[data-files]")?.textContent).toBe(`${first}:/home/demo/test1`);
    await click(terminals[1].querySelector("[data-focus]")!);
    expect(mount.querySelector("[data-files]")?.textContent).toBe(`${second}:/home/demo`);
  } finally {
    await act(async () => root.unmount());
    mount.remove();
    vi.unstubAllGlobals();
  }
});
