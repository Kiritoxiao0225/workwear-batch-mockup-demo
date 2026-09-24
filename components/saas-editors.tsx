"use client";
import { useEffect, useRef, useState } from "react";
import { BatchArtworkEditorHost } from "./batch-artwork-editor-host";
export function SaasEditors({
  target,
  onClose,
  onSaved,
}: {
  target: { type: "artwork" | "mockup"; id: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null),
    [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready && target)
      frame.current?.contentWindow?.postMessage(
        target.type === "artwork"
          ? { type: "saas-open-artwork", jobId: target.id }
          : { type: "saas-open-mockup", caseId: target.id },
        location.origin,
      );
  }, [target, ready]);
  useEffect(() => {
    const receive = (e: MessageEvent) => {
      if (
        e.origin !== location.origin ||
        e.source !== frame.current?.contentWindow
      )
        return;
      if (e.data?.type === "saas-editor-ready") setReady(true);
      if (e.data?.type === "saas-editor-saved") onSaved();
      if (e.data?.type === "saas-editor-close") onClose();
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onClose, onSaved]);
  const visible = target?.type === "mockup";
  return (
    <>
      <div
        className={visible ? "saas-editor-overlay" : "saas-editor-hidden"}
        aria-hidden={!visible}
      >
        <div className="saas-editor-toolbar">
          <b>上衣效果图 · 选择款色与调整位置</b>
          <button
            className="button"
            onClick={() =>
              frame.current?.contentWindow?.postMessage(
                { type: "saas-close" },
                location.origin,
              )
            }
          >
            完成并关闭
          </button>
        </div>
        <iframe
          ref={frame}
          src="/api/batch/saas-editors"
          title="效果图位置编辑器"
          allow="clipboard-write"
        />
      </div>
      <BatchArtworkEditorHost frame={frame} />
    </>
  );
}
