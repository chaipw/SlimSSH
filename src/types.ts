export type AuthMethod = "password" | "private_key";

export interface Profile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath?: string | null;
  x11Forwarding?: boolean;
}

export interface ProfileView extends Profile {
  hasSecret: boolean;
}

export interface ProfileSavePayload {
  profile: Profile;
  secret: string | null;
  saveSecret: boolean;
}

export type SessionState =
  | "connecting"
  | "verifying_host_key"
  | "authenticating"
  | "ready";

export type HostKeyDecision = "reject" | "once" | "save";

export interface HostKeyRequiredEvent {
  type: "host_key_required";
  request_id: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
}

export interface HostKeyMismatchEvent {
  type: "host_key_mismatch";
  host: string;
  port: number;
  expected: string;
  actual: string;
}

export type SessionEvent =
  | { type: "working_directory"; path: string }
  | { type: "state"; state: SessionState }
  | HostKeyRequiredEvent
  | HostKeyMismatchEvent
  | { type: "output"; seq: number; data: string }
  | { type: "error"; code: string; message: string }
  | { type: "closed"; reason: string };

export interface WorkspaceSession {
  id: string;
  instance: number;
  profile: ProfileView;
  state: SessionState;
  error: string | null;
  closedReason: string | null;
  backendId: string | null;
  workingDirectory: string | null;
}
