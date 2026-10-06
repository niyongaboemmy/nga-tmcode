/**
 * What the workbench uses from the extension host package: the wire
 * protocol, RPC, and the pure helpers both sides share. The host itself is
 * bundled separately (Node: build.mjs → src-tauri/resources/exthost.cjs;
 * Worker: src/worker/main.ts through Vite).
 */
export * from "./protocol";
export { RpcConnection, RpcError, FrameDecoder, encodeFrame, type RpcMessage } from "./rpc";
export { activationEventsOf, matchesActivationEvent, unsupportedEvents, workspaceContainsPatterns, SUPPORTED_EVENTS } from "./activation";
export { configurationProperties, configurationDefaults, ConfigurationModel, affects, changedKeys, nest, type ConfigurationProperty, type Flat } from "./configuration";
export { matchGlob, globToRegExp } from "./host/glob";
export { API_VERSION } from "./host/extHost";
