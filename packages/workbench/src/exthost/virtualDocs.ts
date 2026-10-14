import type { RpcConnection } from "@tmcode/exthost";
import { reloadVirtual } from "../monaco/documents";
import { schemeOf, virtualIO } from "../util/virtual";
import type { HostKind } from "./state";

/**
 * The workbench side of extensions' documents (content and file system providers): which
 * host serves each scheme, reading and saving through it, and reloading when it says a
 * document changed. See util/virtual.ts and packages/exthost/src/host/virtualDocs.ts.
 */

const owners = new Map<string, { kind: HostKind; rpc: RpcConnection; ext: string; type: "content" | "fs" }>();

function owner(path: string) {
  const s = schemeOf(path);
  const o = s ? owners.get(s) : undefined;
  if (!o) throw new Error(`No extension serves '${s ?? path}' documents (is it still running?).`);
  return o;
}

virtualIO.read = async (path) => {
  const r = await owner(path).rpc.request<{ text: string; readonly: boolean } | null>("$readVirtual", [path]);
  if (!r) throw new Error(`The extension has no document ${path}.`);
  return r;
};
virtualIO.write = (path, text) => owner(path).rpc.request<boolean>("$writeVirtual", [path, text]).then((ok) => !!ok);

export function virtualScheme(kind: HostKind, rpc: RpcConnection, scheme: string, type: "content" | "fs", ext: string, on: boolean) {
  if (on) {
    owners.set(scheme, { kind, rpc, ext, type });
    virtualIO.schemes.add(scheme);
  } else if (owners.get(scheme)?.rpc === rpc) {
    owners.delete(scheme);
    virtualIO.schemes.delete(scheme);
  }
}

export function virtualChanged(uri: string) {
  void reloadVirtual(uri);
}

/** The extension that serves a virtual document (for the activity log and tab titles). */
export function virtualOwner(path: string): string | null {
  const s = schemeOf(path);
  return (s && owners.get(s)?.ext) || null;
}

/** A host stopped: its schemes go with it. */
export function clearVirtualSchemes(kind: HostKind) {
  for (const [s, o] of owners) {
    if (o.kind !== kind) continue;
    owners.delete(s);
    virtualIO.schemes.delete(s);
  }
}
