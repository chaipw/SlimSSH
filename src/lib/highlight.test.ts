import { describe, expect, it } from "vitest";
import { Highlighter } from "./highlight";

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("Highlighter", () => {
  it("colors timestamps, levels, ips", () => {
    const out = dec(new Highlighter().process(enc("2026-11-16 10:00:00 ERROR connect to 192.0.2.10:50000 failed\n")));
    expect(out).toContain("\x1b[38;5;148m2026-11-16 10:00:00");
    expect(out).toContain("\x1b[38;5;203mERROR");
    expect(out).toContain("\x1b[38;5;111m192.0.2.10:50000");
  });

  it("colors structured values throughout a long database log line", () => {
    const source = "[2026-11-17 10:22:12.971] [ERROR] " + "field=null, ".repeat(250)
      + `Record={scn=2026-11-17 10:21:26:111382, xid='0x6afb.ba26', "enabled":false, offset=-3.25e+2, seq=1794882086, mask=0xff}\n`;
    const out = dec(new Highlighter().process(enc(source)));
    expect(out).toContain("\x1b[38;5;74m[");
    expect(out).toContain("\x1b[38;5;148m2026-11-17 10:21:26:111382");
    expect(out).toContain("\x1b[38;5;186m'0x6afb.ba26'");
    expect(out).toContain('\x1b[38;5;186m"enabled"');
    expect(out).toContain("\x1b[38;5;209mfalse");
    expect(out).toContain("\x1b[38;5;250mnull");
    for (const value of ["-3.25e+2", "1794882086", "0xff"]) {
      expect(out).toContain(`\x1b[38;5;177m${value}\x1b[39m`);
    }
    expect(out.replace(/\x1b\[[0-9;]*m/g, "")).toBe(source);
  });

  it("colors bracketed tag markers", () => {
    const out = dec(new Highlighter().process(enc("[track:1027] done\n")));
    expect(out).toContain("\x1b[38;5;113m[track:\x1b[38;5;177m1027\x1b[38;5;113m]");
  });

  it("uses dark palette in light theme", () => {
    const out = dec(new Highlighter(true).process(enc("[track:1027] ERROR WARN INFO\n")));
    expect(out).toContain("\x1b[38;5;28m[track:\x1b[38;5;90m1027\x1b[38;5;28m]");
    expect(out).toContain("\x1b[38;5;160mERROR");
    expect(out).toContain("\x1b[38;2;147;80;0mWARN");
    expect(out).toContain("\x1b[38;5;23mINFO");
  });

  it("keeps utf-8 bytes intact", () => {
    const source = "日志 严重错误 ERROR 中文继续\n";
    const out = new Highlighter().process(enc(source));
    const text = dec(out);
    expect(text).toContain("日志");
    expect(text).toContain("中文继续");
    expect(text.replace(/\x1b\[[0-9;]*m/g, "")).toBe(source);
  });

  it("passes alternate screen untouched", () => {
    const source = "\x1b[?1049h\x1b[2J\x1b[1;1Htop - 10:00:00 ERROR";
    const out = new Highlighter().process(enc(source));
    expect(dec(out)).toBe(source);
  });

  it("skips chunks with cursor control", () => {
    const source = "\x1b[3;5HERROR here\n";
    const out = new Highlighter().process(enc(source));
    expect(dec(out)).toBe(source);
  });

  it.each([
    [false, 148, 203, 177],
    [true, 28, 160, 90],
  ] as const)("colors Bash command output next to prompt controls (light=%s)", (light, time, error, number) => {
    const command = "\x1b[?2004l\r\r\n";
    const log = "[2026-11-17 11:30:00.123] [ERROR] Record={id=1027}\r\n";
    const prompt = "\x1b]0;ERROR 123\x07\x1b[?2004hdemo@ubuntu:~$ ";
    const source = command + log + prompt;
    const out = dec(new Highlighter(light).process(enc(source)));
    expect(out).toContain(command);
    expect(out).toContain(prompt);
    expect(out).toContain(`\x1b[38;5;${time}m2026-11-17 11:30:00.123`);
    expect(out).toContain(`\x1b[38;5;${error}mERROR`);
    expect(out).toContain(`\x1b[38;5;${number}m1027`);
    expect(out.replace(/\x1b\[[0-9;]*m/g, "")).toBe(source);
  });

  it("keeps trailing escape split across chunks", () => {
    const highlighter = new Highlighter();
    const first = dec(highlighter.process(enc("plain text \x1b[3")));
    const second = dec(highlighter.process(enc("1;42mrest\n")));
    expect(first + second).toBe("plain text \x1b[31;42mrest\n");
  });

  it("tracks alternate-screen entry split across chunks", () => {
    const highlighter = new Highlighter();
    highlighter.process(enc("\x1b[?10"));
    highlighter.process(enc("49h"));
    expect(dec(highlighter.process(enc("ERROR 123")))).toBe("ERROR 123");
    highlighter.process(enc("\x1b[?1049l"));
    expect(dec(highlighter.process(enc("ERROR 123")))).toContain("\x1b[38;5;177m123");
  });
});
