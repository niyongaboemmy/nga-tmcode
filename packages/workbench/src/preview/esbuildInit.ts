/// <reference path="../vendor.d.ts" />
import * as esbuild from "esbuild-wasm";
import wasmURL from "esbuild-wasm/esbuild.wasm?url";

/** esbuild-wasm may only be initialised once per page: the React preview and the JavaScript Console share it. */
let ready: Promise<void> | null = null;
export function ensureEsbuild() {
  ready ??= esbuild.initialize({ wasmURL, worker: true });
  return ready;
}

export { esbuild };
