import { getPlatform, updateSetting, useWorkbench } from "./store";

/**
 * Whole-window zoom (⌘= / ⌘- / ⌘0), VS Code's `window.zoomLevel`: each level
 * is 20 %. The desktop zooms the webview natively; the browser build zooms the
 * root element with CSS. The editor font has its own zoom commands.
 */

export const MIN_ZOOM = -5;
export const MAX_ZOOM = 8;

export function zoomFactor(level: number) {
  return Math.round(Math.pow(1.2, level) * 1000) / 1000;
}

function apply(level: number) {
  const factor = zoomFactor(level);
  const root = document.documentElement;
  root.dataset.zoomLevel = String(level);
  const platform = getPlatform();
  if (platform.setZoom) platform.setZoom(factor);
  else root.style.zoom = factor === 1 ? "" : String(factor);
}

let wired = false;
export function initWindowZoom() {
  if (wired) return;
  wired = true;
  let last = useWorkbench.getState().settings["window.zoomLevel"] ?? 0;
  apply(last);
  useWorkbench.subscribe((s) => {
    const level = s.settings["window.zoomLevel"] ?? 0;
    if (level !== last) {
      last = level;
      apply(level);
    }
  });
}

export function setZoomLevel(level: number) {
  updateSetting("window.zoomLevel", Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(level * 2) / 2)));
}

export const zoomIn = () => setZoomLevel((useWorkbench.getState().settings["window.zoomLevel"] ?? 0) + 1);
export const zoomOut = () => setZoomLevel((useWorkbench.getState().settings["window.zoomLevel"] ?? 0) - 1);
export const zoomReset = () => setZoomLevel(0);
