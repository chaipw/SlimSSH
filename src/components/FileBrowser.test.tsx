import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import FileBrowser from "./FileBrowser";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  transfer: vi.fn(),
  listen: vi.fn(), choose: vi.fn(), preview: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: mocks.listen }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../lib/ipc", () => ({
  errorMessage: String, chooseDownloadPath: mocks.choose, previewFile: mocks.preview,
  sessionListDir: mocks.list,
  sessionTransfer: mocks.transfer,
}));

it("uploads Windows drops only inside the file pane and uses the current remote directory", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  const unlisten = vi.fn();
  mocks.listen.mockResolvedValue(unlisten);
  mocks.list.mockResolvedValue({ path: "/home/demo", entries: [] });
  mocks.transfer.mockResolvedValue(undefined);
  try {
    await act(async () => root.render(<FileBrowser backendId="session-1" connected />));
    const pane = mount.querySelector(".file-browser")!;
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 60, 280, 700));
    const receive = mocks.listen.mock.calls[0][0];
    const paths = ["C:\\local\\one.txt", "C:\\local\\two.txt"];
    const drop = (x: number) => receive({ payload: { type: "drop", paths, position: { toLogical: () => ({ x, y: 300 }) } } });
    await act(async () => drop(500));
    expect(mocks.transfer).not.toHaveBeenCalled();
    await act(async () => drop(170));
    expect(mocks.transfer.mock.calls).toEqual(paths.map((local) => [
      "session-1", { kind: "upload", directory: "/home/demo", local },
    ]));
    expect(mocks.list).toHaveBeenLastCalledWith("session-1", "/home/demo");
    expect(pane.textContent).toContain("已上传 2/2 个文件");
  } finally {
    await act(async () => root.unmount());
    mount.remove();
    vi.unstubAllGlobals();
  }
  expect(unlisten).toHaveBeenCalledOnce();
});

it("selects on click, opens on double click, and saves the right-clicked name", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rootNode = document.createElement("div");
  document.body.append(rootNode);
  const root = createRoot(rootNode);
  const name = "报告 01.tar.gz";
  mocks.list.mockClear().mockResolvedValue({path: "/home/test", entries: [
    {name: "folder", isDir: true}, {name, isDir: false, size: 10}
  ]});
  mocks.choose.mockResolvedValue("C:\\Downloads\\" + name);
  mocks.preview.mockResolvedValue("file contents");
  try {
    await act(async () => root.render(<FileBrowser backendId="test" connected />));
    const [folder, file] = rootNode.querySelectorAll<HTMLButtonElement>(".file-row");
    await act(async () => folder.click());
    expect(folder.getAttribute("aria-pressed")).toBe("true");
    expect(mocks.list).toHaveBeenCalledTimes(1);
    await act(async () => folder.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(mocks.list).toHaveBeenLastCalledWith("test", "/home/test/folder");
    await act(async () => file.click());
    await act(async () => file.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    await act(async () => rootNode.querySelector<HTMLButtonElement>(".file-menu button")!.click());
    expect(mocks.choose).toHaveBeenCalledWith(name);
    expect(mocks.transfer).toHaveBeenLastCalledWith("test", {kind: "download", remote: "/home/test/" + name, local: "C:\\Downloads\\" + name});
    await act(async () => file.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(document.querySelector(".file-preview")?.textContent).toBe("file contents");
  } finally {
    await act(async () => root.unmount());
    rootNode.remove();
    vi.unstubAllGlobals();
  }
});

it("follows confirmed working directories and ignores an older directory response", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const mount = document.createElement("div");
  document.body.append(mount);
  const root = createRoot(mount);
  let finishOld: ((value: unknown) => void) | undefined;
  mocks.list.mockReset().mockImplementation((_id, path) => path === "/home/demo/old"
    ? new Promise((resolve) => { finishOld = resolve; })
    : Promise.resolve({ path, entries: [{ name: "new-file.txt", isDir: false, size: 2 }] }));
  try {
    await act(async () => root.render(<FileBrowser backendId="one" connected workingDirectory="/home/demo/old" />));
    await act(async () => root.render(<FileBrowser backendId="one" connected workingDirectory="/home/demo/test 1" />));
    expect(mocks.list).toHaveBeenLastCalledWith("one", "/home/demo/test 1");
    await act(async () => finishOld?.({ path: "/home/demo/old", entries: [{ name: "stale.txt", isDir: false, size: 1 }] }));
    expect(mount.textContent).toContain("test 1");
    expect(mount.textContent).toContain("new-file.txt");
    expect(mount.textContent).not.toContain("stale.txt");
  } finally {
    await act(async () => root.unmount());
    mount.remove();
    vi.unstubAllGlobals();
  }
});
