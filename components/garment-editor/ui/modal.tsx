"use client";

import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");
const panelTransitionDurationMs = 160;

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  maxWidth?: string;
  layerClassName?: string;
  closable?: boolean;
}

/** 全站统一弹窗：black/40 + blur 遮罩、rounded-2xl 面板、Esc 关闭、打开时锁滚动。 */
export default function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  maxWidth = "max-w-lg",
  layerClassName = "z-50",
  closable = true,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useLayoutEffect(() => {
    if (open) return;
    const rememberFocusedElement = (event: FocusEvent) => {
      if (
        event.target instanceof HTMLElement &&
        event.target !== document.body &&
        !dialogRef.current?.contains(event.target)
      ) {
        openerRef.current = event.target;
      }
    };
    const activeElement = document.activeElement;
    if (
      !openerRef.current &&
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      !dialogRef.current?.contains(activeElement)
    ) {
      openerRef.current = activeElement;
    }
    document.addEventListener("focusin", rememberFocusedElement);
    return () => {
      document.removeEventListener("focusin", rememberFocusedElement);
    };
  }, [open]);

  useEffect(() => {
    if (open || !openerRef.current) return;
    const restoreFocusTimer = window.setTimeout(() => {
      openerRef.current?.focus();
      openerRef.current = null;
    }, panelTransitionDurationMs);
    return () => window.clearTimeout(restoreFocusTimer);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && closable) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(focusableSelector)
      ).filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !dialog.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      if (!dialog.contains(document.activeElement)) {
        (dialog.querySelector<HTMLElement>(focusableSelector) ?? dialog).focus();
      }
    });
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, closable]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={`fixed inset-0 flex items-center justify-center p-4 ${layerClassName}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
        >
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={closable ? onClose : undefined}
            aria-hidden="true"
          />
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-describedby={description ? descriptionId : undefined}
            aria-label={title ? undefined : "对话框"}
            tabIndex={-1}
            className={`relative flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ${maxWidth}`}
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={{
              duration: panelTransitionDurationMs / 1000,
              ease: "easeOut",
            }}
          >
            {(title || closable) && (
              <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
                <div className="min-w-0">
                  {title && (
                    <h2
                      id={titleId}
                      className="text-base font-semibold text-ink"
                    >
                      {title}
                    </h2>
                  )}
                  {description && (
                    <p
                      id={descriptionId}
                      className="mt-1 text-sm leading-relaxed text-ink-2"
                    >
                      {description}
                    </p>
                  )}
                </div>
                {closable && (
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="关闭"
                    className="-mr-1 -mt-1 rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-black/5 hover:text-ink"
                  >
                    <X size={18} />
                  </button>
                )}
              </div>
            )}
            {children && (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {children}
              </div>
            )}
            {footer && (
              <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
