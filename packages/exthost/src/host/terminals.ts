import { EventEmitter } from "../api/events";
import { Uri } from "../api/uri";
import type { RpcConnection } from "../rpc";
import type { PathMapper } from "./convert";

/**
 * `window.createTerminal` over TMCode's integrated terminal. The workbench
 * starts a named terminal (cwd inside the workspace, the extension's env) and
 * reports when its shell is ready and when it exits; text sent before the
 * shell is ready is queued there. Pseudoterminals (`pty` option) are not
 * supported.
 *
 * Shell integration, as VS Code's: `terminal.shellIntegration.executeCommand()`
 * runs a command between OSC 633 C/D markers (the workbench writes and parses
 * them), so extensions read its output (`execution.read()`, raw, with the
 * markers, as Blackbox and Cline expect) and its exit code
 * (`onDidEndTerminalShellExecution`).
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

const C = "\x1b]633;C\x07";
const D = (code: number | undefined) => `\x1b]633;D${code === undefined ? "" : `;${code}`}\x07`;

class Execution {
  readonly commandLine: { value: string; isTrusted: boolean; confidence: number };
  readonly #chunks: string[] = [];
  #done = false;
  #wake: (() => void)[] = [];
  exitCode: number | undefined;

  constructor(
    readonly id: number,
    command: string,
    readonly cwd: Uri | undefined,
  ) {
    this.commandLine = { value: command, isTrusted: true, confidence: 2 };
  }

  push(data: string) {
    this.#chunks.push(data);
    this.#wake.splice(0).forEach((w) => w());
  }
  end(code: number | undefined) {
    if (this.#done) return;
    this.exitCode = code;
    this.#chunks.push(D(code));
    this.#done = true;
    this.#wake.splice(0).forEach((w) => w());
  }

  /** The output from the start, raw (escape sequences and the 633 C/D markers included). */
  read(): AsyncIterable<string> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        let i = 0;
        for (;;) {
          while (i < self.#chunks.length) yield self.#chunks[i++];
          if (self.#done) return;
          await new Promise<void>((r) => self.#wake.push(r));
        }
      },
    };
  }
}

export class ExtTerminal {
  processId: Promise<number | undefined>;
  exitStatus: { code: number | undefined; reason: number } | undefined = undefined;
  readonly state = { isInteractedWith: false, shell: undefined as string | undefined };
  #integration: { cwd: Uri | undefined; executeCommand: (a: string, b?: string[]) => Execution } | undefined;
  #resolvePid!: (pid: number | undefined) => void;
  readonly executions = new Map<number, Execution>();

  constructor(
    readonly id: number,
    readonly name: string,
    readonly creationOptions: TerminalOptionsLike,
    private readonly service: TerminalService,
    /** The extension that created it (commands sent to it are its own unless another extension sends them). */
    readonly owner: string | null,
  ) {
    this.processId = new Promise((r) => (this.#resolvePid = r));
  }

  get shellIntegration() {
    return this.#integration;
  }

  sendText(text: string, shouldExecute = true) {
    this.service.rpc.notify("$main.terminal", ["send", this.id, `${text}${shouldExecute ? "\r" : ""}`]);
    if (shouldExecute) this.service.onCommand?.(this, String(text));
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
  ready(pid: number | undefined, shell?: string) {
    this.#resolvePid(pid);
    if (this.#integration || this.exitStatus) return;
    if (shell) this.state.shell = shell;
    const cwd = this.service.cwdUri(this.creationOptions.cwd);
    this.#integration = {
      cwd,
      executeCommand: (commandOrExecutable: string, args?: string[]) => {
        const command = args ? [commandOrExecutable, ...args].map(quoteArg).join(" ") : String(commandOrExecutable);
        const ex = new Execution(this.service.nextExec(), command, cwd);
        this.executions.set(ex.id, ex);
        this.service.rpc.notify("$main.terminal", ["exec", this.id, { exec: ex.id, command }]);
        this.service.onCommand?.(this, command);
        return ex;
      },
    };
    this.service.onDidChangeTerminalShellIntegration.fire({ terminal: this, shellIntegration: this.#integration });
  }
  /** @internal: the workbench's markers for a command run with executeCommand. */
  execEvent(kind: string, value: { exec: number; data?: string; code?: number }) {
    const ex = this.executions.get(value.exec);
    if (!ex || !this.#integration) return;
    if (kind === "execStart") {
      ex.push(C);
      this.service.onDidStartTerminalShellExecution.fire({ terminal: this, shellIntegration: this.#integration, execution: ex });
    } else if (kind === "execData" && value.data) ex.push(value.data);
    else if (kind === "execEnd") {
      ex.end(value.code);
      this.executions.delete(ex.id);
      this.service.onDidEndTerminalShellExecution.fire({ terminal: this, shellIntegration: this.#integration, execution: ex, exitCode: value.code });
    }
  }
}

function quoteArg(a: string) {
  return /^[A-Za-z0-9_\/.,:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`;
}

export class TerminalService {
  readonly onDidOpenTerminal = new EventEmitter<ExtTerminal>();
  readonly onDidCloseTerminal = new EventEmitter<ExtTerminal>();
  readonly onDidChangeActiveTerminal = new EventEmitter<ExtTerminal | undefined>();
  readonly onDidChangeTerminalShellIntegration = new EventEmitter<{ terminal: ExtTerminal; shellIntegration: unknown }>();
  readonly onDidStartTerminalShellExecution = new EventEmitter<{ terminal: ExtTerminal; shellIntegration: unknown; execution: Execution }>();
  readonly onDidEndTerminalShellExecution = new EventEmitter<{ terminal: ExtTerminal; shellIntegration: unknown; execution: Execution; exitCode: number | undefined }>();
  readonly onDidChangeTerminalState = new EventEmitter<ExtTerminal>();
  /** A command sent to a terminal (sendText with Enter, executeCommand): for the activity log. */
  onCommand?: (t: ExtTerminal, command: string) => void;
  readonly #all = new Map<number, ExtTerminal>();
  #active: ExtTerminal | undefined;
  #seq = 0;
  #execSeq = 0;

  constructor(
    readonly rpc: RpcConnection,
    private readonly paths: PathMapper,
    private readonly folder: () => Uri | undefined,
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
  nextExec() {
    return ++this.#execSeq;
  }
  cwdUri(cwd: string | Uri | undefined): Uri | undefined {
    if (cwd) return typeof cwd === "string" ? Uri.file(cwd) : cwd;
    return this.folder();
  }

  create(owner: string | null, nameOrOptions?: string | TerminalOptionsLike, shellPath?: string, shellArgs?: string[] | string): ExtTerminal {
    const opts: TerminalOptionsLike = typeof nameOrOptions === "object" && nameOrOptions ? nameOrOptions : { name: nameOrOptions, shellPath, shellArgs };
    if (opts.pty) throw new Error("Extension pseudoterminals (the 'pty' option) are not supported in TMCode yet.");
    const id = ++this.#seq;
    const name = opts.name || "Extension Terminal";
    let cwd: string | null = null;
    if (opts.cwd) {
      const uri = typeof opts.cwd === "string" ? Uri.file(opts.cwd) : opts.cwd;
      cwd = this.paths.toPath(uri);
    }
    const env = Object.entries(opts.env ?? {})
      .filter(([, v]) => typeof v === "string")
      .map(([name, value]) => ({ name, value: String(value), kind: "replace" as const }));
    const t = new ExtTerminal(id, name, opts, this, owner);
    this.#all.set(id, t);
    this.rpc.notify("$main.terminal", ["create", id, { name, cwd: cwd ?? "", hidden: !!opts.hideFromUser, env, owner }]);
    this.onDidOpenTerminal.fire(t);
    this.setActive(t);
    return t;
  }

  /** From the workbench: "ready" (shell started), "exit", and executeCommand's markers. */
  event(id: number, kind: string, value: unknown) {
    const t = this.#all.get(id);
    if (!t) return;
    if (kind === "ready") {
      const v = value as number | { pid?: number; shell?: string } | undefined;
      if (typeof v === "object" && v) t.ready(v.pid, v.shell);
      else t.ready(typeof v === "number" ? v : undefined);
    } else if (kind === "execStart" || kind === "execData" || kind === "execEnd") t.execEvent(kind, value as { exec: number });
    else if (kind === "exit") {
      t.exitStatus = { code: typeof value === "number" ? value : undefined, reason: 0 };
      t.ready(undefined);
      for (const ex of t.executions.values()) t.execEvent("execEnd", { exec: ex.id, code: undefined });
      this.#all.delete(id);
      if (this.#active === t) this.setActive(this.terminals.at(-1));
      this.onDidCloseTerminal.fire(t);
    }
  }
}
