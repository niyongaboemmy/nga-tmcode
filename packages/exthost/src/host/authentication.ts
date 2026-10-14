import { EventEmitter } from "../api/events";
import * as T from "../api/types";
import type { ExtHost } from "./extHost";

/**
 * `vscode.authentication`: providers extensions register (Windsurf/Codeium registers its own),
 * and `getSession` for any extension that asks one of them. As in VS Code, a new sign-in asks
 * the user first ("<extension> wants to sign in using <provider>"). VS Code's built-in GitHub
 * and Microsoft providers don't exist in TMCode: asking them silently gives no session, asking
 * them to sign in says so. The workbench is told about providers and accounts (Accounts menu).
 */

interface Session {
  id: string;
  accessToken: string;
  account: { id: string; label: string };
  scopes: readonly string[];
}

interface Provider {
  onDidChangeSessions: (listener: (e: { added?: Session[]; removed?: Session[]; changed?: Session[] }) => unknown) => { dispose(): unknown };
  getSessions(scopes: readonly string[] | undefined, options?: unknown): Thenable<readonly Session[]> | readonly Session[];
  createSession(scopes: readonly string[], options?: unknown): Thenable<Session> | Session;
  removeSession(sessionId: string): Thenable<void> | void;
}

type Thenable<T> = PromiseLike<T>;

interface ExtLike {
  desc: { id: string; displayName?: string };
}

const sameScopes = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join(" ") === [...b].sort().join(" ");

export class Authentication {
  readonly onDidChangeSessions = new EventEmitter<{ provider: { id: string; label: string } }>();
  readonly #providers = new Map<string, { label: string; provider: Provider; ext: string; multiple: boolean }>();
  /** Extensions the user allowed to use a provider's sessions ("<provider>|<extension>"). */
  readonly #allowed = new Set<string>();

  constructor(private readonly host: ExtHost) {}

  async #publish(id: string) {
    const p = this.#providers.get(id);
    let accounts: string[] = [];
    if (p) accounts = [...new Set((await Promise.resolve(p.provider.getSessions(undefined)).catch(() => [] as Session[])).map((s) => s.account.label))];
    this.host.rpc.notify("$main.authProvider", [id, p ? p.label : null, accounts]);
  }

  register(ext: ExtLike, id: string, label: string, provider: Provider, options?: { supportsMultipleAccounts?: boolean }) {
    if (this.#providers.has(id)) throw new Error(`An authentication provider with id '${id}' is already registered.`);
    this.#providers.set(id, { label: String(label), provider, ext: ext.desc.id, multiple: !!options?.supportsMultipleAccounts });
    const sub = provider.onDidChangeSessions?.(() => {
      this.onDidChangeSessions.fire({ provider: { id, label } });
      void this.#publish(id);
    });
    void this.#publish(id);
    return new T.Disposable(() => {
      if (this.#providers.get(id)?.provider !== provider) return;
      this.#providers.delete(id);
      sub?.dispose();
      void this.#publish(id);
    });
  }

  async getSession(ext: ExtLike, providerId: string, scopes: readonly string[], options: { createIfNone?: boolean | object; forceNewSession?: boolean | object; silent?: boolean; clearSessionPreference?: boolean } = {}): Promise<Session | undefined> {
    const p = this.#providers.get(providerId);
    const wantsNew = !!options.createIfNone || !!options.forceNewSession;
    if (!p) {
      if (wantsNew) throw new Error(`TMCode has no '${providerId}' sign-in. ${providerId === "github" || providerId === "microsoft" ? "VS Code's built-in GitHub and Microsoft accounts aren't available in TMCode." : "Install the extension that provides it."}`);
      return undefined;
    }
    const sessions = (await Promise.resolve(p.provider.getSessions(scopes))).filter((s) => sameScopes(s.scopes, scopes) || !scopes.length);
    const key = `${providerId}|${ext.desc.id}`;
    const own = p.ext === ext.desc.id;
    if (sessions.length && !options.forceNewSession) {
      if (own || this.#allowed.has(key)) return sessions[0];
      if (options.silent || !wantsNew) return undefined;
      if (!(await this.#consent(ext, p.label, false))) throw new T.CancellationError();
      this.#allowed.add(key);
      return sessions[0];
    }
    if (!wantsNew) return undefined;
    if (!own && !(await this.#consent(ext, p.label, true))) throw new T.CancellationError();
    this.#allowed.add(key);
    const s = await Promise.resolve(p.provider.createSession(scopes, {}));
    void this.#publish(providerId);
    return s;
  }

  async #consent(ext: ExtLike, provider: string, signIn: boolean) {
    const name = ext.desc.displayName || ext.desc.id;
    const pick = await this.host.rpc.request<number | null>("$main.showMessage", [
      "info",
      signIn ? `The extension '${name}' wants to sign in using ${provider}.` : `The extension '${name}' wants to use your ${provider} account.`,
      { modal: true, detail: "Only allow extensions you trust." },
      ["Allow"],
    ]);
    return pick === 0;
  }

  async getAccounts(providerId: string) {
    const p = this.#providers.get(providerId);
    if (!p) return [];
    const sessions = await Promise.resolve(p.provider.getSessions(undefined));
    const seen = new Map<string, { id: string; label: string }>();
    for (const s of sessions) seen.set(s.account.id, s.account);
    return [...seen.values()];
  }

  /** Accounts menu: sign out of a provider's account. */
  async signOut(providerId: string, account: string) {
    const p = this.#providers.get(providerId);
    if (!p) return false;
    for (const s of await Promise.resolve(p.provider.getSessions(undefined))) if (s.account.label === account) await Promise.resolve(p.provider.removeSession(s.id));
    void this.#publish(providerId);
    return true;
  }

  api(ext: ExtLike) {
    return {
      registerAuthenticationProvider: (id: string, label: string, provider: Provider, options?: { supportsMultipleAccounts?: boolean }) => this.register(ext, String(id), String(label), provider, options),
      getSession: (providerId: string, scopes: readonly string[], options?: { createIfNone?: boolean; forceNewSession?: boolean; silent?: boolean }) => this.getSession(ext, String(providerId), scopes ?? [], options),
      getAccounts: (providerId: string) => this.getAccounts(String(providerId)),
      onDidChangeSessions: this.onDidChangeSessions.event,
    };
  }
}
