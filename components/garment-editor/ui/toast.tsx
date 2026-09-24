"use client";

import { AnimatePresence, motion } from "motion/react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

export type ToastType = "success" | "error" | "info";

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast 必须在 <ToastProvider> 内使用");
  return ctx;
}

const iconMap: Record<ToastType, ReactNode> = {
  success: <CheckCircle2 size={17} className="shrink-0 text-brand-600" aria-hidden="true" />,
  error: <AlertCircle size={17} className="shrink-0 text-red-600" aria-hidden="true" />,
  info: <Info size={17} className="shrink-0 text-ink-3" aria-hidden="true" />,
};

/** 全站统一轻提示，替代原生 alert()。由 app/layout.tsx 挂载一次。 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = Date.now() + Math.random();
    setToasts(prev => [...prev.slice(-3), { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3200);
  }, []);

  const value: ToastContextValue = {
    toast,
    success: useCallback((m: string) => toast(m, "success"), [toast]),
    error: useCallback((m: string) => toast(m, "error"), [toast]),
    info: useCallback((m: string) => toast(m, "info"), [toast]),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[60] flex w-[min(92vw,360px)] flex-col gap-2">
        <AnimatePresence initial={false}>
          {toasts.map(item => (
            <motion.div
              key={item.id}
              layout
              initial={{ opacity: 0, x: 32, scale: 0.97 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24, scale: 0.97 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
              className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-border bg-white px-4 py-3 shadow-lg"
              role="status"
            >
              {iconMap[item.type]}
              <p className="min-w-0 flex-1 text-sm leading-snug text-ink">{item.message}</p>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                aria-label="关闭提示"
                className="-mr-1 shrink-0 rounded p-0.5 text-ink-3 transition-colors hover:bg-black/5 hover:text-ink"
              >
                <X size={14} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
