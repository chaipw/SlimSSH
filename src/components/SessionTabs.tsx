import { useRef, useState, type PointerEvent } from "react";
import type { SessionState } from "../types";

export interface SessionTabItem {
  id: string;
  name: string;
  detail: string;
  state: SessionState;
  error: boolean;
  closed: boolean;
}

interface SessionTabsProps {
  sessions: SessionTabItem[];
  activeId: string | null;
  label: string;
  onMove: (source: string, target: string) => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

export default function SessionTabs({ sessions, activeId, label, onMove, onSelect, onClose }: SessionTabsProps) {
  const drag = useRef<{ id: string; pointer: number; startX: number; lastX: number; moved: boolean } | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);

  const finishDrag = () => {
    drag.current = null;
    setDraggedId(null);
  };

  const moveTab = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    if (!current.moved && Math.abs(event.clientX - current.startX) < 5) return;
    current.moved = true;
    setDraggedId(current.id);
    const direction = Math.sign(event.clientX - current.lastX);
    current.lastX = event.clientX;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-session-tab]");
    if (!target || !event.currentTarget.contains(target)) return;
    const destination = target.dataset.sessionTab;
    const from = sessions.findIndex((session) => session.id === current.id);
    const to = sessions.findIndex((session) => session.id === destination);
    if (destination && from >= 0 && to >= 0 && direction === Math.sign(to - from) && from !== to) {
      onMove(current.id, destination);
    }
  };

  return (
    <div className="session-tabs" role="tablist" aria-label={label}
      onPointerDown={(event) => {
        if (sessions.length < 2) return;
        if (event.button !== 0 || drag.current) return;
        const element = event.target as HTMLElement;
        const tab = element.closest<HTMLElement>("[data-session-tab]");
        const id = tab?.dataset.sessionTab;
        if (!id || element.closest(".tab-close")) return;
        drag.current = { id, pointer: event.pointerId, startX: event.clientX, lastX: event.clientX, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={moveTab}
      onPointerUp={(event) => {
        const current = drag.current;
        if (!current || current.pointer !== event.pointerId) return;
        moveTab(event);
        if (!current.moved) onSelect(current.id);
        finishDrag();
      }}
      onLostPointerCapture={finishDrag}
      onPointerCancel={finishDrag}>
      {sessions.map((session) => {
        const active = session.id === activeId;
        const status = session.closed ? "已断开" : session.error ? "异常" : session.state === "ready" ? "已连接" : "连接中";
        return (
          <div className={`session-tab${active ? " active" : ""}${draggedId === session.id ? " is-dragging" : ""}`} key={session.id} data-session-tab={session.id}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="tab-select"
              onClick={(event) => { if (sessions.length < 2 || event.detail === 0) onSelect(session.id); }}
              title={session.detail}
            >
              <span className={`tab-status${session.error || session.closed ? " amber" : session.state === "ready" ? " cyan" : ""}`} aria-hidden="true" />
              <span>{session.name}</span>
              <small>{status}</small>
            </button>
            <button type="button" className="tab-close" onClick={() => onClose(session.id)} aria-label={`关闭 ${session.name} 终端`} title="关闭终端">
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
