import { useState } from "react";
import { errorMessage } from "../lib/ipc";
import type { HostKeyDecision } from "../types";
import Modal from "./Modal";

export type HostKeyPrompt =
  | {
      kind: "required";
      requestId: string;
      host: string;
      port: number;
      algorithm: string;
      fingerprint: string;
    }
  | {
      kind: "mismatch";
      host: string;
      port: number;
      expected: string;
      actual: string;
    };

interface HostKeyDialogProps {
  prompt: HostKeyPrompt;
  onDecision: (decision: HostKeyDecision) => Promise<void>;
  onForget: () => Promise<void>;
  onCloseConnection: () => void;
}

export default function HostKeyDialog({
  prompt,
  onDecision,
  onForget,
  onCloseConnection,
}: HostKeyDialogProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: string, operation: () => Promise<void>) => {
    setBusy(action);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(null);
    }
  };

  const mismatch = prompt.kind === "mismatch";
  return (
    <Modal
      title={mismatch ? "主机密钥已变更" : "验证新主机"}
      description={mismatch ? "服务器身份与已保存记录不一致，请核实后再继续。" : "首次连接此主机。请通过可信渠道核对 SHA256 指纹。"}
      dismissOnOverlay={false}
      width="wide"
    >
      <div className="modal-body">
        <div className={`security-banner${mismatch ? " warning" : ""}`}>
          <span className="security-symbol" aria-hidden="true">{mismatch ? "!" : "#"}</span>
          <div>
            <strong>{prompt.host}:{prompt.port}</strong>
            <p>{mismatch ? "主机重装可能导致变化，也可能存在中间人攻击。不要忽略不明变化。" : "保存后，后续连接将自动校验该主机的身份。"}</p>
          </div>
        </div>

        {prompt.kind === "required" ? (
          <dl className="fingerprint-list">
            <div><dt>密钥算法</dt><dd>{prompt.algorithm}</dd></div>
            <div><dt>SHA256 指纹</dt><dd><code>{prompt.fingerprint}</code></dd></div>
          </dl>
        ) : (
          <dl className="fingerprint-list mismatch-list">
            <div><dt>已保存指纹</dt><dd><code>{prompt.expected}</code></dd></div>
            <div><dt>本次接收指纹</dt><dd><code>{prompt.actual}</code></dd></div>
          </dl>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>

      {prompt.kind === "required" ? (
        <footer className="modal-footer host-key-actions">
          <button type="button" className="button button-danger-ghost" disabled={busy !== null} onClick={() => void run("reject", () => onDecision("reject"))}>
            {busy === "reject" ? "拒绝中…" : "拒绝"}
          </button>
          <div>
            <button type="button" className="button button-secondary" disabled={busy !== null} onClick={() => void run("once", () => onDecision("once"))}>
              {busy === "once" ? "连接中…" : "仅本次信任"}
            </button>
            <button type="button" className="button button-primary" disabled={busy !== null} onClick={() => void run("save", () => onDecision("save"))}>
              {busy === "save" ? "保存中…" : "保存并信任"}
            </button>
          </div>
        </footer>
      ) : (
        <footer className="modal-footer">
          <button type="button" className="button button-secondary" disabled={busy !== null} onClick={onCloseConnection}>关闭连接</button>
          <button type="button" className="button button-warning" disabled={busy !== null} onClick={() => void run("forget", onForget)}>
            {busy === "forget" ? "清除中…" : "清除旧记录并重新连接"}
          </button>
        </footer>
      )}
    </Modal>
  );
}
