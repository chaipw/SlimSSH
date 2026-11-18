import { Terminal } from "@xterm/xterm";
import { expect, it, vi } from "vitest";

// Only exercise the real terminal buffer; this test never opens a renderer.
vi.hoisted(() => vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null));

it("分屏重新排版历史长日志，新输出自动换行，退出分屏恢复宽行且保留颜色", async () => {
  const term = new Terminal({ cols: 100, rows: 24, allowProposedApi: true });
  const message = "[ERROR] START 中文日志 " + "0123456789abcdef".repeat(3) + " END-OF-LINE";
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  const lines = () => Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)!);
  try {
    await write(`\x1b[31m${message}\x1b[0m\r\n`);
    expect(lines()[0].translateToString(true)).toBe(message);
    term.resize(28, 24);
    const wrapped = lines().filter((line) => line.translateToString(true));
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.map((line) => line.translateToString(true)).join("")).toBe(message);
    expect(wrapped[1].isWrapped).toBe(true);
    expect(wrapped[1].getCell(0)?.isFgPalette()).toBeTruthy();
    expect(wrapped[1].getCell(0)?.getFgColor()).toBe(1);
    await write(`${message}\r\n`);
    expect(lines().map((line) => line.translateToString(true)).join("")).toBe(message.repeat(2));
    term.resize(100, 24);
    expect(lines().slice(0, 2).map((line) => line.translateToString(true))).toEqual([message, message]);
  } finally {
    term.dispose();
  }
});
