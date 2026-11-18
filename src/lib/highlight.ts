const RESET_FG = "\x1b[39m";
const MAX_CHUNK = 65_536;
const MAX_PENDING = 64;

interface Rule {
  group: string;
  pattern: string;
  color: string;
  lightColor?: string;
  render?: (value: string, light: boolean) => string;
}

const TAG_GREEN = "\x1b[38;5;113m";
const TAG_PURPLE = "\x1b[38;5;177m";
const TAG_GREEN_LIGHT = "\x1b[38;5;28m";
const TAG_PURPLE_LIGHT = "\x1b[38;5;90m";

/** 形如 [track:1027] 的标记：括号与冒号用绿色，数字用紫色 */
function paintTag(value: string, light: boolean): string {
  const green = light ? TAG_GREEN_LIGHT : TAG_GREEN;
  const purple = light ? TAG_PURPLE_LIGHT : TAG_PURPLE;
  const colon = value.lastIndexOf(":");
  if (colon <= 0) return value;
  const head = value.slice(0, colon + 1);
  const tail = value.slice(colon + 1);
  const close = tail.endsWith("]") ? "]" : "";
  const digits = close ? tail.slice(0, -1) : tail;
  return `${green}${head}${purple}${digits}${green}${close}`;
}

const RULES: Rule[] = [
  {
    group: "tag",
    pattern: String.raw`\[[A-Za-z_][\w.\-]{0,40}:\d+\]`,
    color: "",
    render: paintTag,
  },
  { group: "ts", pattern: String.raw`\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:[.,:]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)?\b`, color: "\x1b[38;5;148m", lightColor: "\x1b[38;5;28m" },
  { group: "clock", pattern: String.raw`\b\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?\b`, color: "\x1b[38;5;245m", lightColor: "\x1b[38;5;240m" },
  { group: "fatal", pattern: String.raw`\b(?:FATAL|CRITICAL|PANIC|EMERG(?:ENCY)?)\b`, color: "\x1b[38;5;210m", lightColor: "\x1b[38;5;124m" },
  {
    group: "error",
    pattern: String.raw`\b(?:ERROR|ERR|SEVERE|EXCEPTION|FAILED|FAILURE|DENIED|REFUSED|TIMEOUT|TIMED\s+OUT|REJECTED|ABORTED|UNREACHABLE|BROKEN\s+PIPE)\b`,
    color: "\x1b[38;5;203m",
    lightColor: "\x1b[38;5;160m",
  },
  { group: "exception", pattern: String.raw`\b[A-Za-z_][\w.]{0,60}(?:Exception|Error)\b`, color: "\x1b[38;5;210m", lightColor: "\x1b[38;5;160m" },
  { group: "warn", pattern: String.raw`\b(?:WARN(?:ING)?|DEPRECATED|RETRY(?:ING)?)\b`, color: "\x1b[38;5;221m", lightColor: "\x1b[38;2;147;80;0m" },
  { group: "ok", pattern: String.raw`\b(?:OK|SUCCESS|SUCCESSFUL|PASSED|DONE|READY|STARTED|CONNECTED|LISTENING)\b`, color: "\x1b[38;5;114m", lightColor: "\x1b[38;5;28m" },
  { group: "info", pattern: String.raw`\b(?:INFO|NOTICE)\b`, color: "\x1b[38;5;116m", lightColor: "\x1b[38;5;23m" },
  { group: "debug", pattern: String.raw`\b(?:DEBUG|TRACE|VERBOSE)\b`, color: "\x1b[38;5;245m", lightColor: "\x1b[38;5;240m" },
  { group: "url", pattern: String.raw`https?:\/\/[^\s"'<>)]+`, color: "\x1b[38;5;117m", lightColor: "\x1b[38;5;25m" },
  { group: "ip", pattern: String.raw`\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b`, color: "\x1b[38;5;111m", lightColor: "\x1b[38;5;25m" },
  { group: "quote", pattern: String.raw`"[^"\r\n]{0,512}"|(?<![\w'])'[^'\r\n]{0,512}'`, color: "\x1b[38;5;186m", lightColor: "\x1b[38;5;94m" },
  { group: "boolean", pattern: String.raw`\b(?:true|false)\b`, color: "\x1b[38;5;209m", lightColor: "\x1b[38;5;124m" },
  { group: "nil", pattern: String.raw`\bnull\b`, color: "\x1b[38;5;250m", lightColor: "\x1b[38;5;240m" },
  { group: "number", pattern: String.raw`(?<![\w.])[-+]?(?:0x[\da-f]+|(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?)(?![\w.])`, color: "\x1b[38;5;177m", lightColor: "\x1b[38;5;90m" },
  { group: "bracket", pattern: String.raw`[\[\]{}()]`, color: "\x1b[38;5;74m", lightColor: "\x1b[38;5;24m" },
];

const COMBINED = new RegExp(RULES.map((rule) => `(?<${rule.group}>${rule.pattern})`).join("|"), "gi");
// Bash can send these prompt controls in the same SSH packet as command output.
const INLINE_CONTROL = /(?<sgr>\x1b\[[0-9;]*m)|\x1b\[\?2004[hl]|\x1b\][012];[^\x00-\x1f]*(?:\x07|\x1b\\)/g;
const ALT_SCREEN = /\x1b\[\?(?:47|1049|1047)([hl])/g;
function isIncompleteEscape(tail: string): boolean {
  if (!tail.startsWith("\x1b") || tail.length > MAX_PENDING) return false;
  if (tail.length === 1) return true;
  if (tail[1] !== "[") return false;
  for (let index = 2; index < tail.length; index += 1) {
    const code = tail.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return false;
    if (code < 0x20 || code > 0x3f) return false;
  }
  return true;
}
function decodeLatin1(bytes: Uint8Array): string {
  let text = "";
  const step = 8_192;
  for (let offset = 0; offset < bytes.length; offset += step) {
    const end = Math.min(offset + step, bytes.length);
    text += String.fromCharCode(...bytes.subarray(offset, end));
  }
  return text;
}

function encodeLatin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function applyRules(text: string, restore: string, light: boolean): string {
  if (!text.trim()) return text;
  const suffix = RESET_FG + restore;
  return text.replace(COMBINED, (value, ...rest) => {
    const groups = rest[rest.length - 1] as Record<string, string | undefined>;
    for (const rule of RULES) {
      if (groups[rule.group]) {
        if (rule.render) return `${rule.render(value, light)}${suffix}`;
        const color = light && rule.lightColor ? rule.lightColor : rule.color;
        return `${color}${value}${suffix}`;
      }
    }
    return value;
  });
}

function highlightLine(line: string, light: boolean): string {
  let out = "";
  let last = 0;
  let restore = "";
  let match: RegExpExecArray | null;
  INLINE_CONTROL.lastIndex = 0;
  while ((match = INLINE_CONTROL.exec(line)) !== null) {
    out += applyRules(line.slice(last, match.index), restore, light);
    out += match[0];
    if (match.groups?.sgr) {
      restore = match[0] === "\x1b[0m" || match[0] === "\x1b[m" ? "" : (restore + match[0]).slice(-120);
    }
    last = match.index + match[0].length;
  }
  out += applyRules(line.slice(last), restore, light);
  return out;
}

/**
 * 在写入终端前对纯文本日志着色。
 * 以 latin1 逐字节视图处理，保证中文等多字节内容不会被截断或改写。
 * 任何含非常规转义或状态不确定的块都整块原样返回，绝不延迟或丢弃字节。
 */
export class Highlighter {
  private altScreen = false;
  private pendingEscape = "";
  private light: boolean;

  constructor(light = false) {
    this.light = light;
  }

  setTheme(light: boolean): void {
    this.light = light;
  }

  reset(): void {
    this.altScreen = false;
    this.pendingEscape = "";
  }

  process(bytes: Uint8Array): Uint8Array {
    if (!bytes.length) return bytes;
    if (bytes.length > MAX_CHUNK) return bytes;

    const continuation = this.pendingEscape;
    const input = continuation + decodeLatin1(bytes);
    const escapeIndex = input.lastIndexOf("\x1b");
    const tail = escapeIndex === -1 ? "" : input.slice(escapeIndex);
    this.pendingEscape = isIncompleteEscape(tail) ? tail : "";

    ALT_SCREEN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ALT_SCREEN.exec(input)) !== null) {
      this.altScreen = match[1] === "h";
    }
    if (this.altScreen || continuation) return bytes;

    if (input.replace(INLINE_CONTROL, "").includes("\x1b")) return bytes;

    const painted = input
      .split("\n")
      .map((line, index, lines) => (index === lines.length - 1 ? highlightLine(line, this.light) : highlightLine(line, this.light) + "\n"))
      .join("");
    return encodeLatin1(painted);
  }
}
