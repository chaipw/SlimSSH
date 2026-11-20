import { useSyncExternalStore } from "react";
import { errorMessage, sessionTransfer } from "./ipc";

export interface UploadJob {
  id: string;
  backendId: string;
  sessionName: string;
  directory: string;
  local: string;
  name: string;
  state: "queued" | "uploading" | "completed" | "failed";
  transferred: number;
  total: number | null;
  error?: string;
  completedSequence?: number;
}

interface UploadSnapshot {
  jobs: UploadJob[];
  completion: number;
}

let snapshot: UploadSnapshot = { jobs: [], completion: 0 };
let running = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => snapshot;
const emit = () => { for (const listener of listeners) listener(); };

function update(id: string, patch: Partial<UploadJob>) {
  snapshot = { ...snapshot, jobs: snapshot.jobs.map((job) => job.id === id ? { ...job, ...patch } : job) };
  emit();
}

// This worker belongs to the application, not a mounted file pane. Switching
// sessions, hiding the sidebar or changing tabs never discards pending uploads.
async function pump() {
  if (running) return;
  running = true;
  try {
    while (true) {
      const job = snapshot.jobs.find((item) => item.state === "queued");
      if (!job) break;
      update(job.id, { state: "uploading" });
      try {
        await sessionTransfer(job.backendId, { kind: "upload", directory: job.directory, local: job.local }, (progress) => {
          if (snapshot.jobs.find((item) => item.id === job.id)?.state === "uploading") {
            update(job.id, { transferred: progress.transferred, total: progress.total });
          }
        });
        const completed = { ...snapshot.jobs.find((item) => item.id === job.id)!, state: "completed" as const, completedSequence: snapshot.completion + 1 };
        snapshot = {
          jobs: snapshot.jobs.map((item) => item.id === job.id ? completed : item),
          completion: snapshot.completion + 1,
        };
        emit();
      } catch (cause) {
        update(job.id, { state: "failed", error: errorMessage(cause) });
      }
    }
  } finally {
    running = false;
  }
}

export function enqueueUploads(backendId: string, directory: string, files: string[], sessionName: string) {
  const jobs: UploadJob[] = files.map((local) => ({
    id: crypto.randomUUID(), backendId, directory, local, sessionName,
    name: local.split(/[\\/]/).pop() || local,
    state: "queued", transferred: 0, total: null,
  }));
  snapshot = { ...snapshot, jobs: [...snapshot.jobs, ...jobs] };
  emit();
  void pump();
}

export function clearFinishedUploads() {
  snapshot = { ...snapshot, jobs: snapshot.jobs.filter((job) => job.state === "queued" || job.state === "uploading") };
  emit();
}

export function useUploadQueue() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
