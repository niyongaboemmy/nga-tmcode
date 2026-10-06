import { Disposable } from "./types";

/** `vscode.Event<T>`: subscribe with a listener (and an optional `this` and disposables array). */
export type Event<T> = (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: { dispose(): unknown }[]) => Disposable;

/**
 * `vscode.EventEmitter`. A throwing listener never stops the others (VS Code
 * logs it); `onError` receives such errors so the host can report them.
 */
export class EventEmitter<T> {
  static onListenerError: (e: unknown) => void = (e) => console.error(e);
  #listeners: { fn: (e: T) => unknown; thisArg: unknown }[] = [];
  #disposed = false;
  #event?: Event<T>;

  get event(): Event<T> {
    if (!this.#event) {
      this.#event = (fn, thisArgs, disposables) => {
        if (this.#disposed) return new Disposable(() => {});
        const entry = { fn, thisArg: thisArgs };
        this.#listeners.push(entry);
        const d = new Disposable(() => {
          const i = this.#listeners.indexOf(entry);
          if (i >= 0) this.#listeners.splice(i, 1);
        });
        if (Array.isArray(disposables)) disposables.push(d);
        return d;
      };
    }
    return this.#event;
  }

  fire(data: T) {
    for (const l of [...this.#listeners]) {
      try {
        l.fn.call(l.thisArg, data);
      } catch (e) {
        EventEmitter.onListenerError(e);
      }
    }
  }

  get hasListeners() {
    return this.#listeners.length > 0;
  }

  dispose() {
    this.#listeners = [];
    this.#disposed = true;
  }
}

export interface CancellationToken {
  isCancellationRequested: boolean;
  onCancellationRequested: Event<unknown>;
}

const NONE_EVENT: Event<unknown> = () => new Disposable(() => {});

export const CancellationTokenNone: CancellationToken = Object.freeze({ isCancellationRequested: false, onCancellationRequested: NONE_EVENT });

export class CancellationTokenSource {
  #emitter: EventEmitter<unknown> | undefined;
  #cancelled = false;
  #token: CancellationToken | undefined;

  get token(): CancellationToken {
    if (!this.#token) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      this.#token = {
        get isCancellationRequested() {
          return self.#cancelled;
        },
        get onCancellationRequested(): Event<unknown> {
          if (self.#cancelled) {
            return (fn, thisArg) => {
              const t = setTimeout(() => fn.call(thisArg, undefined), 0);
              return new Disposable(() => clearTimeout(t));
            };
          }
          if (!self.#emitter) self.#emitter = new EventEmitter();
          return self.#emitter.event;
        },
      };
    }
    return this.#token;
  }

  cancel() {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#emitter?.fire(undefined);
    this.#emitter?.dispose();
  }

  dispose(cancel = false) {
    if (cancel) this.cancel();
    this.#emitter?.dispose();
  }
}
