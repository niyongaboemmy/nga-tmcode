import { EventEmitter } from "../api/events";
import { Uri } from "../api/uri";
import type { RpcConnection } from "../rpc";
import type { PathMapper } from "./convert";

/**
 * `window.createTerminal` over TMCode's integrated terminal. The workbench
 * starts a named terminal (cwd inside the workspace) and reports when its
 * shell is ready and when it exits; text sent before the shell is ready is
 * queued there. Pseudoterminals (`pty` option) are not supported.
 */

export interface TerminalOptionsLike {
  name?: string;
  cwd?: string | Uri;
  shellPath?: string;
  shellArgs?: string[] | string;
  env?: Record<string, string | null | undefined>;
  hideFromUser?: boolean;
  pty?: unknown;
}

export class ExtTerminal {
  processId: Promise<number | undefined>;
  exitStatus: { code: number | undefined; reason: number } | undefined = undefined;
  readonly state = { isInteractedWith: false, shell: undefined as string | undefined };
  readonly shellIntegration = undefined;
  #resolvePid!: (pid: number | undefined) => void;

  constructor(
    readonly id: number,
    readonly name: string,
    readonly creationOptions: TerminalOptionsLike,
    private readonly service: TerminalService,
  ) {
    this.processId = new Promise((r) => (this.#resolvePid = r));
  }

  sendText(text: string, shouldExecute = true) {
    this.service.rpc.notify("$main.terminal", ["send", this.id, `${text}${shouldExecute ? "\r" : ""}`]);
  }
  show(_preserveFocus?: boolean) {
    this.service.rpc.notify("$main.terminal", ["show", this.id]);
    this.service.setActive(this);
  }
  hide() {
    /* the Panel decides what is visible */
  }
  dispose() {
    this.service.rpc.notify("$main.terminal", ["dispose", this.id]);
  }
  /** @internal */
  ready(pid: number | undefined) {
    this.#resolvePid(pid);
  }
}

export class TerminalService {
  readonly onDidOpenTerminal = new EventEmitter<ExtTerminal>();
  readonly onDidCloseTerminal = new EventEmitter<ExtTerminal>();
  readonly onDidChangeActiveTerminal = new EventEmitter<ExtTerminal | undefined>();
  readonly #all = new Map<number, ExtTerminal>();
  #active: ExtTerminal | undefined;
  #seq = 0;

  constructor(
    readonly rpc: RpcConnection,
    private readonly paths: PathMapper,
  ) {}

  get terminals() {
    return [...this.#all.values()];
  }
  get activeTerminal() {
    return this.#active;
  }
  setActive(t: ExtTerminal | undefined) {
    if (this.#active === t) return;
    this.#active = t;
    this.onDidChangeActiveTerminal.fire(t);
  }

  create(nameOrOptions?: string | TerminalOptionsLike, shellPath?: string, shellArgs?: string[] | string): ExtTerminal {
    const opts: TerminalOptionsLike = typeof nameOrOptions === "object" && nameOrOptions ? nameOrOptions : { name: nameOrOptions, shellPath, shellArgs };
    if (opts.pty) throw new Error("Extension pseudoterminals (the 'pty' option) are not supported in TMCode yet.");
    const id = ++this.#seq;
    const name = opts.name || "Extension Terminal";
    let cwd: string | null = null;
    if (opts.cwd) {
      const uri = typeof opts.cwd === "string" ? Uri.file(opts.cwd) : opts.cwd;
      cwd = this.paths.toPath(uri);
    }
    const t = new ExtTerminal(id, name, opts, this);
    this.#all.set(id, t);
    this.rpc.notify("$main.terminal", ["create", id, { name, cwd: cwd ?? "", hidden: !!opts.hideFromUser }]);
    this.onDidOpenTerminal.fire(t);
    this.setActive(t);
    return t;
  }

  /** From the workbench: "ready" (shell started) or "exit". */
  event(id: number, kind: string, value: unknown) {
    const t = this.#all.get(id);
    if (!t) return;
    if (kind === "ready") t.ready(typeof value === "number" ? value : undefined);
    if (kind === "exit") {
      t.exitStatus = { code: typeof value === "number" ? value : undefined, reason: 0 };
      t.ready(undefined);
      this.#all.delete(id);
      if (this.#active === t) this.setActive(this.terminals.at(-1));
      this.onDidCloseTerminal.fire(t);
    }
  }
}
