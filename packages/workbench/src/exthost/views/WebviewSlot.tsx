import { useEffect, useRef } from "react";
import { attachSlot, detachSlot, setWebviewLayer, useWebviews } from "./webviews";

/** Where a webview shows (editor area, side bar view): its iframe, in the layer, follows this box. */
export function WebviewSlot({ handle, className = "" }: { handle: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    attachSlot(handle, el);
    return () => detachSlot(handle, el);
  }, [handle]);
  return <div ref={ref} className={`tm-webview-slot ${className}`} data-webview-slot={handle} />;
}

/** The layer every webview iframe lives in (over the workbench, under menus and dialogs). */
export function WebviewLayer() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setWebviewLayer(ref.current);
    return () => setWebviewLayer(null);
  }, []);
  return <div ref={ref} className="tm-webview-layer" aria-hidden={false} />;
}

/** A webview panel as an editor (`window.createWebviewPanel`). */
export function WebviewEditor({ handle }: { handle: string }) {
  const exists = useWebviews((s) => !!s.entries[handle]);
  if (!exists) return <div className="tm-view-hint">This webview is no longer available.</div>;
  return <WebviewSlot handle={handle} className="tm-webview-editor" />;
}

export function webviewTitle(handle: string): string {
  const e = useWebviews.getState().entries[handle];
  return e?.title || e?.viewType || "Webview";
}
