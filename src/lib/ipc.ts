import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  HostKeyDecision,
  ProfileSavePayload,
  ProfileView,
  SessionEvent,
} from "../types";

export function listProfiles(): Promise<ProfileView[]> {
  return invoke<ProfileView[]>("profile_list");
}

export function saveProfile(input: ProfileSavePayload): Promise<void> {
  return invoke<void>("profile_save", { input });
}

export function deleteProfile(profileId: string): Promise<void> {
  return invoke<void>("profile_delete", { profileId });
}

export function createSessionChannel(
  onEvent: (event: SessionEvent) => void,
): Channel<SessionEvent> {
  const channel = new Channel<SessionEvent>();
  channel.onmessage = onEvent;
  return channel;
}

export function openSession(
  profileId: string,
  cols: number,
  rows: number,
  channel: Channel<SessionEvent>,
): Promise<string> {
  return invoke<string>("session_open", {
    profileId,
    cols,
    rows,
    channel,
  });
}

export function sessionInput(sessionId: string, data: string): Promise<void> {
  return invoke<void>("session_input", { sessionId, data });
}

export interface RemoteEntry {
  name: string;
  isDir: boolean;
  size: number;
}

export function sessionListDir(sessionId: string, path: string): Promise<{ path: string; entries: RemoteEntry[] }> {
  return invoke("session_list_dir", { sessionId, path });
}

export function sessionTransfer(
  sessionId: string,
  transfer: { kind: "download"; remote: string; local: string } | { kind: "upload"; directory: string; local: string },
  onProgress?: (progress: TransferProgress) => void,
): Promise<void> {
  const progress = new Channel<TransferProgress>();
  progress.onmessage = onProgress ?? (() => undefined);
  return invoke("session_transfer", { sessionId, transfer, progress });
}

export interface TransferProgress {
  transferred: number;
  total: number;
}

export function previewFile(sessionId: string, path: string): Promise<string> {
  return invoke("preview_file", { sessionId, path });
}

export function chooseDownloadPath(fileName: string): Promise<string | null> {
  return invoke("choose_download_path", { fileName });
}

export function sessionResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke<void>("session_resize", { sessionId, cols, rows });
}

export function sessionOutputAck(
  sessionId: string,
  seq: number,
): Promise<void> {
  return invoke<void>("session_output_ack", { sessionId, seq });
}

export function hostKeyDecision(
  sessionId: string,
  requestId: string,
  decision: HostKeyDecision,
): Promise<void> {
  return invoke<void>("host_key_decision", { sessionId, requestId, decision });
}

export function knownHostsForget(host: string, port: number): Promise<void> {
  return invoke<void>("known_hosts_forget", { host, port });
}

export function sessionClose(sessionId: string): Promise<void> {
  return invoke<void>("session_close", { sessionId });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return "操作失败，请重试。";
}
