import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { FileSystemError, FileType } from "../api/types";
import type { Uri } from "../api/uri";
import type { ExtHost } from "../host/extHost";
import type { HostFs } from "../host/fs";
import type { FileStatDTO } from "../protocol";

/**
 * `workspace.fs` on disk. The API is limited to the open folder, the
 * extension storage folder and (read-only) the installed extensions. This is
 * an API boundary, not a sandbox: extension code runs as the user, as in VS
 * Code, and could use Node's own `fs`.
 */
export class NodeFs implements HostFs {
  constructor(private readonly host: ExtHost) {}

  #roots(write: boolean): string[] {
    const out: string[] = [];
    if (this.host.folder) out.push(this.host.folder.fsPath);
    const storage = this.host.data?.env.storagePath;
    if (storage) out.push(storage);
    if (!write) for (const e of this.host.exts.values()) out.push(e.desc.location);
    return out.map((r) => path.resolve(r));
  }

  #path(uri: Uri, write = false): string {
    if (uri.scheme !== "file") throw FileSystemError.Unavailable(`TMCode cannot read ${uri.scheme}: resources (${uri.toString(true)})`);
    const p = path.resolve(uri.fsPath);
    const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
    const ok = this.#roots(write).some((r) => norm(p) === norm(r) || norm(p).startsWith(norm(r.endsWith(path.sep) ? r : r + path.sep)));
    if (!ok) throw FileSystemError.NoPermissions(`TMCode limits workspace.fs to the open folder (${p})`);
    return p;
  }

  #wrap(uri: Uri, e: unknown): never {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (e instanceof FileSystemError) throw e;
    if (code === "ENOENT") throw FileSystemError.FileNotFound(uri);
    if (code === "EEXIST") throw FileSystemError.FileExists(uri);
    if (code === "ENOTDIR") throw FileSystemError.FileNotADirectory(uri);
    if (code === "EISDIR") throw FileSystemError.FileIsADirectory(uri);
    if (code === "EACCES" || code === "EPERM") throw FileSystemError.NoPermissions(uri);
    throw e;
  }

  async stat(uri: Uri): Promise<FileStatDTO> {
    try {
      const p = this.#path(uri);
      const ls = await fsp.lstat(p);
      const st = ls.isSymbolicLink() ? await fsp.stat(p).catch(() => ls) : ls;
      const type = (st.isDirectory() ? FileType.Directory : st.isFile() ? FileType.File : FileType.Unknown) | (ls.isSymbolicLink() ? FileType.SymbolicLink : 0);
      return { type, ctime: st.ctimeMs, mtime: st.mtimeMs, size: st.size };
    } catch (e) {
      this.#wrap(uri, e);
    }
  }

  async readDirectory(uri: Uri): Promise<[string, number][]> {
    try {
      const entries = await fsp.readdir(this.#path(uri), { withFileTypes: true });
      return entries.map((d) => [d.name, d.isDirectory() ? FileType.Directory : d.isFile() ? FileType.File : d.isSymbolicLink() ? FileType.SymbolicLink | FileType.File : FileType.Unknown]);
    } catch (e) {
      this.#wrap(uri, e);
    }
  }

  async createDirectory(uri: Uri) {
    try {
      await fsp.mkdir(this.#path(uri, true), { recursive: true });
    } catch (e) {
      this.#wrap(uri, e);
    }
  }

  async readFile(uri: Uri): Promise<Uint8Array> {
    try {
      return new Uint8Array(await fsp.readFile(this.#path(uri)));
    } catch (e) {
      this.#wrap(uri, e);
    }
  }

  async writeFile(uri: Uri, content: Uint8Array) {
    try {
      const p = this.#path(uri, true);
      await fsp.mkdir(path.dirname(p), { recursive: true });
      await fsp.writeFile(p, content);
    } catch (e) {
      this.#wrap(uri, e);
    }
  }

  async delete(uri: Uri, options?: { recursive?: boolean }) {
    try {
      await fsp.rm(this.#path(uri, true), { recursive: !!options?.recursive });
    } catch (e) {
      this.#wrap(uri, e);
    }
  }

  async rename(source: Uri, target: Uri, options?: { overwrite?: boolean }) {
    try {
      const to = this.#path(target, true);
      if (!options?.overwrite && (await fsp.stat(to).then(() => true, () => false))) throw FileSystemError.FileExists(target);
      await fsp.rename(this.#path(source, true), to);
    } catch (e) {
      this.#wrap(source, e);
    }
  }

  async copy(source: Uri, target: Uri, options?: { overwrite?: boolean }) {
    try {
      await fsp.cp(this.#path(source), this.#path(target, true), { recursive: true, force: !!options?.overwrite, errorOnExist: !options?.overwrite });
    } catch (e) {
      this.#wrap(source, e);
    }
  }
}
