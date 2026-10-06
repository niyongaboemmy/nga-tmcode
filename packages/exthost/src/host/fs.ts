import type { Uri } from "../api/uri";
import type { FileStatDTO } from "../protocol";

/**
 * `workspace.fs` as the host implements it: Node reads the disk directly
 * (limited to the workspace, the extension's own folder and its storage);
 * the Web Worker host asks the workbench, whose platform fs is already
 * sandboxed to the workspace.
 */
export interface HostFs {
  stat(uri: Uri): Promise<FileStatDTO>;
  readDirectory(uri: Uri): Promise<[string, number][]>;
  createDirectory(uri: Uri): Promise<void>;
  readFile(uri: Uri): Promise<Uint8Array>;
  writeFile(uri: Uri, content: Uint8Array): Promise<void>;
  delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void>;
  rename(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void>;
  copy(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void>;
}

/** Loads an extension's entry module with `require('vscode')` answered by `api`. */
export interface ModuleLoader {
  load(extensionLocation: string, entry: string, extensionId: string): Promise<ExtensionModule>;
}

export interface ExtensionModule {
  activate?: (context: unknown) => unknown;
  deactivate?: () => unknown;
}
