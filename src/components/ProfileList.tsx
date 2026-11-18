import { useState } from "react";
import type { ProfileView } from "../types";

interface ProfileListProps {
  profiles: ProfileView[];
  loading: boolean;
  activeProfileIds: Set<string>;
  onNew: () => void;
  onEdit: (profile: ProfileView) => void;
  onDelete: (profile: ProfileView) => void;
  onConnect: (profile: ProfileView) => void;
}

export default function ProfileList({
  profiles,
  loading,
  activeProfileIds,
  onNew,
  onEdit,
  onDelete,
  onConnect,
}: ProfileListProps) {
  const [query, setQuery] = useState("");
  const filter = query.trim().toLowerCase();
  const visibleProfiles = profiles.filter((profile) =>
    profile.name.toLowerCase().includes(filter) || profile.host.toLowerCase().includes(filter),
  );

  return (
    <div className="sidebar-pane" role="region" aria-label="SSH 连接列表">
      <div className="sidebar-heading">
        <div>
          <p className="eyebrow">CONNECTIONS</p>
          <h1>连接</h1>
        </div>
        <button type="button" className="button button-small" onClick={onNew}>
          <span aria-hidden="true">＋</span> 新建
        </button>
      </div>

      <div className="profile-search">
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4" /><path d="m10 10 3 3" /></svg>
        <input
          type="search"
          aria-label="搜索连接"
          placeholder="搜索连接名或 IP"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>

      <div className="profile-list">
        {loading ? (
          <div className="list-placeholder" role="status">正在读取连接配置…</div>
        ) : profiles.length === 0 ? (
          <div className="list-placeholder">
            <span className="placeholder-line" aria-hidden="true" />
            <strong>还没有连接</strong>
            <p>新建主机配置后，即可在此打开安全终端。</p>
            <button type="button" className="text-button" onClick={onNew}>
              创建第一个连接
            </button>
          </div>
        ) : visibleProfiles.length === 0 ? (
          <div className="list-placeholder" role="status">没有找到匹配的连接</div>
        ) : (
          visibleProfiles.map((profile) => {
            const connected = activeProfileIds.has(profile.id);
            return (
              <article className={`profile-item${connected ? " is-connected" : ""}`} key={profile.id}>
                <div className="profile-main">
                  <span className={`connection-dot${connected ? " active" : ""}`} aria-hidden="true" />
                  <span className="profile-copy">
                    <strong>{profile.name}</strong>
                    <span>{profile.username}@{profile.host}</span>
                    <small>{profile.authMethod === "password" ? "密码认证" : "私钥认证"} · {profile.port}</small>
                  </span>
                </div>
                <div className="profile-actions">
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => onConnect(profile)}
                    aria-label={`${connected ? "新开连接" : "连接到"} ${profile.name}`}
                  >
                    {connected ? "新开连接" : "连接"}
                  </button>
                  <button type="button" className="icon-button" onClick={() => onEdit(profile)} aria-label={`编辑 ${profile.name}`} title="编辑">
                    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m13.9 3.4 2.7 2.7-8.8 8.8-3.5.8.8-3.5 8.8-8.8Zm-1.4 1.4-6.6 6.6-.3 1.4 1.4-.3 6.6-6.6-1.1-1.1Z" /></svg>
                  </button>
                  <button type="button" className="icon-button danger-hover" onClick={() => onDelete(profile)} aria-label={`删除 ${profile.name}`} title="删除">
                    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 2.8h6l.7 1.4h3.1v1.4H3.2V4.2h3.1L7 2.8Zm-2.2 4.2h10.4l-.7 10.2H5.5L4.8 7Zm3 2v6h1.4V9H7.8Zm3 0v6h1.4V9h-1.4Z" /></svg>
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}
