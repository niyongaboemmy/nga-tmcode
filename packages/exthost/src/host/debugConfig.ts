import type { RpcConnection } from "../rpc";

/**
 * `debug.registerDebugConfigurationProvider` and `debug.startDebugging`: an
 * extension's starting points for launch.json (Add Configuration…) and its
 * last word on a configuration before TMCode starts it. The debuggers
 * themselves stay TMCode's (custom debug adapters are not run).
 */

interface Provider {
  provideDebugConfigurations?(folder: unknown, token?: unknown): unknown;
  resolveDebugConfiguration?(folder: unknown, config: Record<string, unknown>, token?: unknown): unknown;
  resolveDebugConfigurationWithSubstitutedVariables?(folder: unknown, config: Record<string, unknown>, token?: unknown): unknown;
}

export class DebugConfigService {
  readonly #providers: { type: string; provider: Provider }[] = [];

  constructor(
    private readonly rpc: RpcConnection,
    private readonly folder: () => unknown,
  ) {
    rpc.register("$provideDebugConfigurations", async () => {
      const out: Record<string, unknown>[] = [];
      for (const { type, provider } of this.#providers) {
        if (!provider.provideDebugConfigurations) continue;
        try {
          const list = (await provider.provideDebugConfigurations(this.folder())) as Record<string, unknown>[] | null | undefined;
          for (const c of list ?? []) if (c && typeof c === "object") out.push({ type, ...c });
        } catch {
          /* a failing provider offers nothing */
        }
      }
      return out;
    });
    rpc.register("$resolveDebugConfiguration", async ([config]) => {
      let c = config as Record<string, unknown> | null | undefined;
      for (const { type, provider } of this.#providers) {
        if (!c) return null;
        if (type !== "*" && type !== c.type) continue;
        if (provider.resolveDebugConfiguration) c = (await provider.resolveDebugConfiguration(this.folder(), c)) as typeof c;
      }
      // undefined/null: the extension stopped the launch (as in VS Code).
      return c ?? null;
    });
  }

  register(type: string, provider: Provider) {
    const entry = { type, provider };
    this.#providers.push(entry);
    return { dispose: () => void this.#providers.splice(this.#providers.indexOf(entry), 1) };
  }

  /** debug.startDebugging: a configuration (or a launch.json name) started by TMCode. */
  start(nameOrConfig: unknown) {
    return this.rpc.request("$main.startDebugging", [nameOrConfig]).then((r) => !!r);
  }
}
