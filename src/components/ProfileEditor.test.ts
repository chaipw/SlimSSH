import { describe, expect, it } from "vitest";
import type { Profile } from "../types";
import { buildProfileSavePayload } from "./ProfileEditor";

const profile: Profile = {
  id: "profile-1",
  name: "测试主机",
  host: "192.0.2.8",
  port: 22,
  username: "ops",
  authMethod: "password",
  privateKeyPath: null,
};

describe("ProfileEditor 秘密提交语义", () => {
  it("编辑时秘密留空且保持保存开关，提交 null 以保留已有秘密", () => {
    const payload = buildProfileSavePayload(profile, "", true);
    expect(payload.secret).toBeNull();
    expect(payload.saveSecret).toBe(true);
  });

  it("输入新秘密时只提交新值，不包含任何旧秘密", () => {
    const payload = buildProfileSavePayload(profile, "new-secret", true);
    expect(payload).toMatchObject({ secret: "new-secret", saveSecret: true });
  });

  it("关闭保存开关并留空时显式清除已有秘密", () => {
    const payload = buildProfileSavePayload(profile, "", false);
    expect(payload.secret).toBeNull();
    expect(payload.saveSecret).toBe(false);
  });

  it("密码认证不会遗留私钥路径", () => {
    const payload = buildProfileSavePayload({ ...profile, privateKeyPath: "C:\\old-key" }, "", true);
    expect(payload.profile.privateKeyPath).toBeNull();
  });
});
