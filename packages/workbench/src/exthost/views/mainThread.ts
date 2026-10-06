import type { RpcConnection, TreeItemDTO, TreeViewOptionsDTO, ViewMetaDTO, WebviewCreateDTO } from "@tmcode/exthost";
import type { HostKind } from "../state";
import { setViewMeta, useViews } from "./model";
import { disposeTree, disposeTreesOf, refreshTree, registerTree, revealInTree, getTree } from "./trees";
import { createWebview, disposeWebviewsOf, postToWebview, registerWebviewViewProvider, unregisterWebviewViewProvider, webviewOp } from "./webviews";

/**
 * The `$main.*` handlers of tree views and webviews (the host side is
 * packages/exthost/src/host/views.ts). Installed on every host connection;
 * disposeViewsOf undoes what a stopped host registered.
 */
export function installViewsMainThread(kind: HostKind, rpc: RpcConnection) {
  const link = { kind, rpc };
  rpc.register("$main.treeView", ([op, id, data]) => {
    const viewId = String(id);
    switch (op) {
      case "register":
        registerTree(link, viewId, data as TreeViewOptionsDTO);
        return;
      case "dispose":
        if (getTree(viewId)?.link.kind === kind) disposeTree(viewId);
        return;
      case "refresh":
        refreshTree(viewId, data as { items: TreeItemDTO[] } | null);
        return;
      case "update":
        setViewMeta(viewId, data as ViewMetaDTO);
        return;
      case "reveal":
        revealInTree(viewId, data as Parameters<typeof revealInTree>[1]);
        window.dispatchEvent(new CustomEvent("tmcode:show-view", { detail: viewId }));
        return;
    }
  });
  rpc.register("$main.webview", ([op, handle, data]) => {
    if (op === "create") createWebview(link, String(handle), data as WebviewCreateDTO);
    else webviewOp(String(handle), String(op), data);
  });
  rpc.register("$main.webviewPost", ([handle, message]) => postToWebview(String(handle), message));
  rpc.register("$main.webviewView", ([op, id, data]) => {
    if (op === "register") registerWebviewViewProvider(link, String(id), (data ?? {}) as { retainContextWhenHidden?: boolean });
    else unregisterWebviewViewProvider(String(id));
  });
}

/** A host stopped: its trees, webviews and view titles/badges go away. */
export function disposeViewsOf(kind: HostKind) {
  disposeTreesOf(kind);
  disposeWebviewsOf(kind);
  if (Object.keys(useViews.getState().meta).length) useViews.setState({ meta: {} });
}
