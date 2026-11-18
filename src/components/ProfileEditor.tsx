import { open } from "@tauri-apps/plugin-dialog";
import { useState, type FormEvent } from "react";
import { errorMessage } from "../lib/ipc";
import type { AuthMethod, Profile, ProfileSavePayload, ProfileView } from "../types";
import Modal from "./Modal";

interface ProfileEditorProps {
  profile?: ProfileView;
  onSave: (input: ProfileSavePayload) => Promise<void>;
  onCancel: () => void;
}

export function buildProfileSavePayload(
  profile: Profile,
  secret: string,
  saveSecret: boolean,
): ProfileSavePayload {
  return {
    profile: {
      ...profile,
      privateKeyPath: profile.authMethod === "private_key" ? profile.privateKeyPath || null : null,
    },
    secret: secret || null,
    saveSecret,
  };
}

export default function ProfileEditor({ profile, onSave, onCancel }: ProfileEditorProps) {
  const [draft, setDraft] = useState<Profile>(() => ({
    id: profile?.id ?? "",
    name: profile?.name ?? "",
    host: profile?.host ?? "",
    port: profile?.port ?? 22,
    username: profile?.username ?? "",
    authMethod: profile?.authMethod ?? "password",
    privateKeyPath: profile?.privateKeyPath ?? null,
    x11Forwarding: profile?.x11Forwarding ?? false,
  }));
  const [secret, setSecret] = useState("");
  const [saveSecret, setSaveSecret] = useState(profile?.hasSecret ?? false);
  const [saving, setSaving] = useState(false);
  const [choosingFile, setChoosingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof Profile>(key: K, value: Profile[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const choosePrivateKey = async () => {
    setChoosingFile(true);
    setError(null);
    try {
      const selected = await open({ multiple: false, directory: false });
      if (typeof selected === "string") update("privateKeyPath", selected);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setChoosingFile(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (draft.authMethod === "private_key" && !draft.privateKeyPath?.trim()) {
      setError("请选择或填写私钥文件路径。");
      return;
    }
    if (draft.authMethod === "password" && !profile?.hasSecret && !secret) {
      setError("请输入密码。");
      return;
    }
    setSaving(true);
    try {
      const mustSaveSecret = draft.authMethod === "password" || saveSecret;
      await onSave(buildProfileSavePayload(draft, secret, mustSaveSecret));
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  };

  const secretLabel = draft.authMethod === "password" ? "密码" : "私钥口令";
  const secretHint = profile?.hasSecret
    ? `已保存${secretLabel}，留空可保持不变。`
    : secret
      ? `已输入新的${secretLabel}。`
      : `尚未设置${secretLabel}。`;

  return (
    <Modal
      title={profile ? "编辑连接" : "新建连接"}
      description="配置仅用于建立 SSH 连接。密码与私钥口令不会回显。"
      onClose={onCancel}
      closeDisabled={saving}
      width="wide"
    >
      <form onSubmit={submit}>
        <div className="modal-body form-grid">
          <label className="field field-full">
            <span>连接名称</span>
            <input
              value={draft.name}
              onChange={(event) => update("name", event.target.value)}
              placeholder="例如：生产跳板机"
              maxLength={80}
              required
              autoComplete="off"
            />
          </label>
          <label className="field field-host">
            <span>主机</span>
            <input
              value={draft.host}
              onChange={(event) => update("host", event.target.value)}
              placeholder="192.0.2.10 或 example.com"
              required
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field field-port">
            <span>端口</span>
            <input
              type="number"
              value={draft.port}
              onChange={(event) => update("port", Number(event.target.value))}
              min={1}
              max={65535}
              required
            />
          </label>
          <label className="field field-full">
            <span>用户名</span>
            <input
              value={draft.username}
              onChange={(event) => update("username", event.target.value)}
              placeholder="root"
              required
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field field-full">
            <span>认证方式</span>
            <select
              value={draft.authMethod}
              onChange={(event) => update("authMethod", event.target.value as AuthMethod)}
            >
              <option value="password">密码</option>
              <option value="private_key">私钥</option>
            </select>
          </label>

          {draft.authMethod === "private_key" && (
            <div className="field field-full">
              <label htmlFor="private-key-path">私钥路径</label>
              <div className="input-with-button">
                <input
                  id="private-key-path"
                  value={draft.privateKeyPath ?? ""}
                  onChange={(event) => update("privateKeyPath", event.target.value)}
                  placeholder="C:\Users\me\.ssh\id_ed25519"
                  spellCheck={false}
                />
                <button type="button" className="button button-secondary" onClick={choosePrivateKey} disabled={choosingFile || saving}>
                  {choosingFile ? "选择中…" : "浏览…"}
                </button>
              </div>
            </div>
          )}

          <label className="field field-full">
            <span>{secretLabel}</span>
            <input
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder={profile?.hasSecret ? "留空保留已保存的秘密" : `输入${secretLabel}`}
              autoComplete="new-password"
            />
            <small className={profile?.hasSecret && !secret ? "saved-secret" : "field-hint"}>
              {secretHint}
            </small>
          </label>
          <label className="checkbox-field field-full">
            <input
              type="checkbox"
              checked={draft.authMethod === "password" || saveSecret}
              disabled={draft.authMethod === "password"}
              onChange={(event) => setSaveSecret(event.target.checked)}
            />
            <span>
              <strong>保存{secretLabel}</strong>
              <small>{draft.authMethod === "password"
                ? "密码登录要求保存到 Windows 凭据管理器，不以明文写入配置。"
                : saveSecret
                  ? "保存到 Windows 凭据管理器；编辑时留空不会覆盖已有口令。"
                  : "仅适用于无口令私钥；已有口令将在提交后清除。"}</small>
            </span>
          </label>
          <label className="checkbox-field field-full">
            <input type="checkbox" checked={draft.x11Forwarding} onChange={(event) => update("x11Forwarding", event.target.checked)} />
            <span>
              <strong>图形窗口转发（X11）</strong>
              <small>使用 Windows 上的 VcXsrv 显示这台主机的 Linux 图形程序。仅在信任这台主机时开启。</small>
            </span>
          </label>
          {error && <div className="form-error field-full" role="alert">{error}</div>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button button-secondary" onClick={onCancel} disabled={saving}>取消</button>
          <button type="submit" className="button button-primary" disabled={saving || choosingFile}>
            {saving ? "保存中…" : "保存连接"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
