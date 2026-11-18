import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  title: string;
  description?: string;
  children: ReactNode;
  onClose?: () => void;
  closeDisabled?: boolean;
  dismissOnOverlay?: boolean;
  width?: "narrow" | "normal" | "wide";
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export default function Modal({
  title,
  description,
  children,
  onClose,
  closeDisabled = false,
  dismissOnOverlay = true,
  width = "normal",
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const disabledRef = useRef(closeDisabled);
  closeRef.current = onClose;
  disabledRef.current = closeDisabled;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const firstControl = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (firstControl ?? panel)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (closeRef.current && !disabledRef.current) {
          event.preventDefault();
          closeRef.current();
        }
        return;
      }
      if (event.key !== "Tab" || !panel) return;

      const controls = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (controls.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (
          dismissOnOverlay &&
          event.target === event.currentTarget &&
          onClose &&
          !closeDisabled
        ) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        className={`modal-panel modal-${width}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="modal-header">
          <div>
            <p className="eyebrow">SLIMSSH</p>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          {onClose && (
            <button
              type="button"
              className="icon-button"
              onClick={onClose}
              disabled={closeDisabled}
              aria-label="关闭对话框"
            >
              ×
            </button>
          )}
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
