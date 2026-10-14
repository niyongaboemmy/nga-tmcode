import { CancellationTokenSource, type Event } from "../api/events";
import * as T from "../api/types";
import { Uri } from "../api/uri";
import type { RpcConnection } from "../rpc";

/**
 * Documents that live in an extension, not on disk: `registerTextDocumentContentProvider`
 * (read-only, e.g. Blackbox's `blackbox-diff:` original side) and `registerFileSystemProvider`
 * (read/write, e.g. Claude Code's `_claude_fs_right:` proposed file). The workbench knows
 * them by their URI string (a "virtual path") and asks the host for their text
 * (`$readVirtual`) and to save them (`$writeVirtual`); changes the extension announces are
 * pushed to it (`$main.virtualChanged`).
 */

interface ContentProvider {
  provideTextDocumentContent(uri: Uri, token: unknown): string | null | undefined | PromiseLike<string | null | undefined>;
  onDidChange?: Event<Uri>;
}

interface FileChange {
  type: number;
  uri: Uri;
}

interface FsProvider {
  readFile(uri: Uri): Uint8Array | PromiseLike<Uint8Array>;
  writeFile(uri: Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void | PromiseLike<void>;
  stat(uri: Uri): { type: number; ctime: number; mtime: number; size: number; permissions?: number } | PromiseLike<{ type: number; ctime: number; mtime: number; size: number; permissions?: number }>;
  readDirectory?(uri: Uri): [string, number][] | PromiseLike<[string, number][]>;
  createDirectory?(uri: Uri): void | PromiseLike<void>;
  delete?(uri: Uri, options: { recursive: boolean }): void | PromiseLike<void>;
  rename?(oldUri: Uri, newUri: Uri, options: { overwrite: boolean }): void | PromiseLike<void>;
  onDidChangeFile?: Event<FileChange[]>;
}

const RESERVED = new Set(["file", "untitled", "tmcode", "http", "https", "vscode", "tmwebview", "tmpreview"]);
const enc = new TextEncoder();
const dec = new TextDecoder();

export class VirtualDocs {
  readonly #content = new Map<string, { ext: string; provider: ContentProvider }>();
  readonly #fs = new Map<string, { ext: string; provider: FsProvider; readonly: boolean }>();

  constructor(private readonly rpc: RpcConnection) {}

  /** Is `scheme` served by an extension (its documents are virtual)? */
  has(scheme: string) {
    return this.#content.has(scheme) || this.#fs.has(scheme);
  }

  /** "<scheme>:…" strings the workbench uses as paths for these documents. */
  static isVirtualPath(path: string) {
    const m = /^([a-zA-Z][\w+.-]*):/.exec(path);
    return !!m && m[1] !== "untitled" && m[1].length > 1;
  }

  registerContent(ext: string, scheme: string, provider: ContentProvider): T.Disposable {
    if (RESERVED.has(scheme)) throw new Error(`The scheme '${scheme}' is reserved.`);
    this.#content.set(scheme, { ext, provider });
    this.rpc.notify("$main.virtualScheme", [scheme, "content", ext, true]);
    const sub = provider.onDidChange?.((uri) => this.rpc.notify("$main.virtualChanged", [Uri.revive(uri).toString()]));
    return new T.Disposable(() => {
      if (this.#content.get(scheme)?.provider !== provider) return;
      this.#content.delete(scheme);
      sub?.dispose();
      this.rpc.notify("$main.virtualScheme", [scheme, "content", ext, false]);
    });
  }

  registerFs(ext: string, scheme: string, provider: FsProvider, options?: { isReadonly?: boolean | unknown }): T.Disposable {
    if (RESERVED.has(scheme)) throw new Error(`The scheme '${scheme}' is reserved.`);
    this.#fs.set(scheme, { ext, provider, readonly: !!options?.isReadonly });
    this.rpc.notify("$main.virtualScheme", [scheme, "fs", ext, true]);
    const sub = provider.onDidChangeFile?.((changes) => {
      for (const c of changes ?? []) this.rpc.notify("$main.virtualChanged", [Uri.revive(c.uri).toString(), c.type]);
    });
    return new T.Disposable(() => {
      if (this.#fs.get(scheme)?.provider !== provider) return;
      this.#fs.delete(scheme);
      sub?.dispose();
      this.rpc.notify("$main.virtualScheme", [scheme, "fs", ext, false]);
    });
  }

  /** The text of a virtual document, and whether it can be saved. Null when nobody serves it. */
  async read(uriString: string): Promise<{ text: string; readonly: boolean } | null> {
    const uri = Uri.parse(uriString);
    const fs = this.#fs.get(uri.scheme);
    if (fs) return { text: dec.decode(await fs.provider.readFile(uri)), readonly: fs.readonly };
    const c = this.#content.get(uri.scheme);
    if (c) {
      const cts = new CancellationTokenSource();
      const text = await c.provider.provideTextDocumentContent(uri, cts.token);
      if (text === null || text === undefined) return null;
      return { text: String(text), readonly: true };
    }
    return null;
  }

  async write(uriString: string, text: string): Promise<boolean> {
    const uri = Uri.parse(uriString);
    const fs = this.#fs.get(uri.scheme);
    if (!fs || fs.readonly) return false;
    await fs.provider.writeFile(uri, enc.encode(text), { create: true, overwrite: true });
    return true;
  }

  /** `workspace.fs` on a provider's scheme. */
  fsFor(scheme: string): FsProvider | undefined {
    return this.#fs.get(scheme)?.provider;
  }
  contentFor(scheme: string): ContentProvider | undefined {
    return this.#content.get(scheme)?.provider;
  }
}
