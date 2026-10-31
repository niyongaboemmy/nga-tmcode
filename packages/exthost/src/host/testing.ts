import { CancellationTokenSource } from "../api/events";
import { TestRunRequest } from "../api/moreTypes";
import type { Uri } from "../api/uri";
import type { RpcConnection } from "../rpc";
import type { TestControllerDTO, TestItemDTO, TestStateDTO } from "../protocol";

/**
 * `tests.createTestController`: an extension's tests (Jest, pytest, Go, Java
 * test extensions) in TMCode's Testing view. The host keeps the items and
 * sends the tree when it changes; the workbench asks to run tests
 * ($runTests) and the extension's TestRun reports each result back.
 */

interface Item {
  id: string;
  label: string;
  uri?: Uri;
  range?: { start: { line: number } };
  description?: string;
  children: Collection;
  parent?: Item;
  canResolveChildren: boolean;
  busy: boolean;
  error?: unknown;
  tags: unknown[];
  sortText?: string;
}

class Collection {
  readonly #items = new Map<string, Item>();
  constructor(
    private readonly owner: Item | undefined,
    private readonly changed: () => void,
  ) {}
  get size() {
    return this.#items.size;
  }
  add(item: Item) {
    item.parent = this.owner;
    this.#items.set(item.id, item);
    this.changed();
  }
  delete(id: string) {
    this.#items.delete(id);
    this.changed();
  }
  replace(items: readonly Item[]) {
    this.#items.clear();
    for (const i of items) {
      i.parent = this.owner;
      this.#items.set(i.id, i);
    }
    this.changed();
  }
  get(id: string) {
    return this.#items.get(id);
  }
  forEach(fn: (item: Item, collection: Collection) => void) {
    for (const i of this.#items.values()) fn(i, this);
  }
  [Symbol.iterator]() {
    return [...this.#items.entries()][Symbol.iterator]();
  }
  values() {
    return [...this.#items.values()];
  }
}

export class TestingService {
  #seq = 0;
  readonly #controllers = new Map<number, { label: string; id: string; root: Collection; profiles: { kind: number; isDefault: boolean; run: (req: unknown, token: unknown) => unknown }[] }>();
  #timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly rpc: RpcConnection,
    private readonly paths: { toPath(uri: Uri): string | null },
  ) {
    rpc.register("$runTests", ([handle, ids]) => this.run(Number(handle), Array.isArray(ids) ? ids.map(String) : null));
  }

  #dto(handle: number): TestControllerDTO | null {
    const c = this.#controllers.get(handle);
    if (!c) return null;
    const conv = (i: Item): TestItemDTO => ({
      id: i.id,
      label: i.label,
      ...(i.description ? { description: i.description } : {}),
      ...(i.uri ? { path: this.paths.toPath(i.uri) ?? undefined } : {}),
      ...(i.range ? { line: i.range.start.line } : {}),
      children: i.children.values().map(conv),
    });
    return { id: c.id, label: c.label, canRun: c.profiles.some((p) => p.kind === 1), items: c.root.values().map(conv) };
  }

  #changed(handle: number) {
    if (this.#timers.has(handle)) return;
    this.#timers.set(
      handle,
      setTimeout(() => {
        this.#timers.delete(handle);
        const dto = this.#dto(handle);
        if (dto) void this.rpc.request("$main.tests", ["upsert", handle, dto]).catch(() => undefined);
      }, 50),
    );
  }

  /** Every item of a controller, by id. */
  #find(handle: number, id: string): Item | undefined {
    const walk = (col: Collection): Item | undefined => {
      for (const i of col.values()) {
        if (i.id === id) return i;
        const hit = walk(i.children);
        if (hit) return hit;
      }
      return undefined;
    };
    const c = this.#controllers.get(handle);
    return c ? walk(c.root) : undefined;
  }

  async run(handle: number, ids: string[] | null) {
    const c = this.#controllers.get(handle);
    const profile = c?.profiles.find((p) => p.kind === 1 && p.isDefault) ?? c?.profiles.find((p) => p.kind === 1);
    if (!c || !profile) return false;
    const include = ids ? ids.map((id) => this.#find(handle, id)).filter((i): i is Item => !!i) : undefined;
    const token = new CancellationTokenSource().token;
    await Promise.resolve(profile.run(new TestRunRequest(include, undefined, profile), token));
    return true;
  }

  create(id: string, label: string) {
    const handle = ++this.#seq;
    const changed = () => this.#changed(handle);
    const root = new Collection(undefined, changed);
    const entry = { id, label, root, profiles: [] as { kind: number; isDefault: boolean; run: (req: unknown, token: unknown) => unknown }[] };
    this.#controllers.set(handle, entry);
    changed();
    const rpc = this.rpc;
    const report = (item: Item, state: TestStateDTO, message?: unknown, duration?: number) =>
      void rpc.request("$main.testState", [handle, item.id, state, message === undefined ? null : messageText(message), duration ?? null]).catch(() => undefined);
    return {
      id,
      label,
      items: root,
      createTestItem(itemId: string, itemLabel: string, uri?: Uri): Item {
        const item: Item = { id: itemId, label: itemLabel, uri, children: undefined as unknown as Collection, canResolveChildren: false, busy: false, tags: [] };
        item.children = new Collection(item, changed);
        return new Proxy(item, {
          set(t, p, v) {
            (t as unknown as Record<string | symbol, unknown>)[p] = v;
            if (p === "label" || p === "range" || p === "description" || p === "uri") changed();
            return true;
          },
        });
      },
      createRunProfile(profileLabel: string, kind: number, runHandler: (req: unknown, token: unknown) => unknown, isDefault = false) {
        const p = { label: profileLabel, kind, isDefault, run: runHandler, configureHandler: undefined as unknown, tag: undefined as unknown, supportsContinuousRun: false, dispose: () => entry.profiles.splice(entry.profiles.indexOf(p), 1) };
        entry.profiles.push(p);
        changed();
        return p;
      },
      createTestRun(_request: unknown, name?: string) {
        void rpc.request("$main.testRun", [handle, "start", name ?? label]).catch(() => undefined);
        return {
          name,
          token: new CancellationTokenSource().token,
          isPersisted: true,
          enqueued: (i: Item) => report(i, "queued"),
          started: (i: Item) => report(i, "running"),
          passed: (i: Item, duration?: number) => report(i, "passed", undefined, duration),
          failed: (i: Item, message: unknown, duration?: number) => report(i, "failed", message, duration),
          errored: (i: Item, message: unknown, duration?: number) => report(i, "errored", message, duration),
          skipped: (i: Item) => report(i, "skipped"),
          appendOutput: (text: string) => void rpc.request("$main.testRun", [handle, "output", String(text)]).catch(() => undefined),
          addCoverage: () => undefined,
          end: () => void rpc.request("$main.testRun", [handle, "end"]).catch(() => undefined),
        };
      },
      resolveHandler: undefined as unknown,
      refreshHandler: undefined as unknown,
      invalidateTestResults: () => undefined,
      dispose: () => {
        this.#controllers.delete(handle);
        void rpc.request("$main.tests", ["remove", handle]).catch(() => undefined);
      },
    };
  }
}

/** A TestMessage (or several) as plain text. */
function messageText(m: unknown): string {
  const one = (x: unknown): string => {
    if (typeof x === "string") return x;
    const msg = (x as { message?: unknown })?.message;
    const text = typeof msg === "string" ? msg : (msg as { value?: string })?.value ?? "";
    const e = x as { expectedOutput?: string; actualOutput?: string };
    return e.expectedOutput !== undefined ? `${text}\nExpected: ${e.expectedOutput}\nActual: ${e.actualOutput ?? ""}` : text;
  };
  return Array.isArray(m) ? m.map(one).join("\n") : one(m);
}
