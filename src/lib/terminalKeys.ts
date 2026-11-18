export interface KeyLike {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * Ctrl+C 的双重语义：有选区时用于复制，否则交给终端发送中断信号（0x03）。
 * 带 Shift/Alt/Meta 的组合一律不拦截，保持终端默认行为。
 */
export function isCopyShortcut(event: KeyLike, selection: string): boolean {
  return (
    event.type === "keydown" &&
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    (event.key === "c" || event.key === "C") &&
    selection.length > 0
  );
}

export function isPasteShortcut(event: KeyLike): boolean {
  return (
    event.type === "keydown" &&
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === "v"
  );
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    document.execCommand("copy");
  } finally {
    area.remove();
  }
}

export function copySelection(text: string): Promise<void> {
  return writeClipboard(text);
}

export async function readClipboard(): Promise<string> {
  return navigator.clipboard.readText();
}
