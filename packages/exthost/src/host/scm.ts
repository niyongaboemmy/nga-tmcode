import { EventEmitter } from "../api/events";
import type { Uri } from "../api/uri";
import type * as T from "../api/types";
import type { RpcConnection } from "../rpc";
import type { CommandCache } from "./convert";
import { command as commandDTO } from "./convert";
import type { ScmGroupDTO, ScmProviderDTO } from "../protocol";

/**
 * `scm.createSourceControl`: an extension's own source control (a Mercurial,
 * Perforce or Jujutsu extension) shown in the Source Control view beside
 * TMCode's git: its input box, its groups of changed files and their
 * commands. The host sends each control's state as one DTO when it changes.
 */

interface ResourceState {
  resourceUri: Uri;
  command?: T.Command;
  decorations?: { tooltip?: string; strikeThrough?: boolean; faded?: boolean };
}

export class ScmService {
  #seq = 0;
  readonly #controls = new Map<number, { input: { value: string; placeholder: string; visible: boolean; enabled: boolean; onChange: EventEmitter<string> }; dto: () => ScmProviderDTO; accept?: T.Command }>();
  #pending = new Set<number>();
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly rpc: RpcConnection,
    private readonly paths: { toPath(uri: Uri): string | null },
    private readonly cache: CommandCache,
  ) {
    rpc.register("$scmInput", ([handle, value]) => {
      const c = this.#controls.get(Number(handle));
      if (c) {
        c.input.value = String(value);
        c.input.onChange.fire(c.input.value);
      }
      return null;
    });
  }

  #changed(handle: number) {
    this.#pending.add(handle);
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      for (const h of this.#pending) {
        const c = this.#controls.get(h);
        if (c) void this.rpc.request("$main.scm", ["upsert", h, c.dto()]).catch(() => undefined);
      }
      this.#pending.clear();
    }, 30);
  }

  create(id: string, label: string, rootUri?: Uri) {
    const handle = ++this.#seq;
    const changed = () => this.#changed(handle);
    const groups: { id: string; label: string; hideWhenEmpty: boolean; resourceStates: ResourceState[] }[] = [];
    const onChange = new EventEmitter<string>();
    const input = {
      value: "",
      placeholder: "",
      visible: true,
      enabled: true,
      onChange,
    };
    let count: number | undefined;
    let acceptInputCommand: T.Command | undefined;
    const self = this;
    const dto = (): ScmProviderDTO => ({
      id,
      label,
      rootPath: rootUri ? (this.paths.toPath(rootUri) ?? "") : "",
      ...(count !== undefined ? { count } : {}),
      input: { value: input.value, placeholder: input.placeholder, visible: input.visible, enabled: input.enabled },
      ...(acceptInputCommand ? { acceptInputCommand: commandDTO(acceptInputCommand, self.cache) } : {}),
      groups: groups.map(
        (g): ScmGroupDTO => ({
          id: g.id,
          label: g.label,
          hideWhenEmpty: g.hideWhenEmpty,
          resources: g.resourceStates.map((r) => ({
            path: this.paths.toPath(r.resourceUri) ?? "",
            uri: r.resourceUri.toString(),
            ...(r.decorations?.tooltip ? { tooltip: String(r.decorations.tooltip) } : {}),
            ...(r.decorations?.strikeThrough ? { strikeThrough: true } : {}),
            ...(r.decorations?.faded ? { faded: true } : {}),
            ...(r.command ? { command: commandDTO(r.command, self.cache) } : {}),
          })),
        }),
      ),
    });
    this.#controls.set(handle, { input, dto });
    changed();
    const inputBox = {
      get value() {
        return input.value;
      },
      set value(v: string) {
        input.value = String(v ?? "");
        changed();
      },
      get placeholder() {
        return input.placeholder;
      },
      set placeholder(v: string) {
        input.placeholder = String(v ?? "");
        changed();
      },
      get visible() {
        return input.visible;
      },
      set visible(v: boolean) {
        input.visible = !!v;
        changed();
      },
      get enabled() {
        return input.enabled;
      },
      set enabled(v: boolean) {
        input.enabled = !!v;
        changed();
      },
      validateInput: undefined as unknown,
      onDidChange: onChange.event,
    };
    return {
      id,
      label,
      rootUri,
      inputBox,
      get count() {
        return count;
      },
      set count(v: number | undefined) {
        count = v;
        changed();
      },
      quickDiffProvider: undefined as unknown,
      commitTemplate: undefined as string | undefined,
      get acceptInputCommand() {
        return acceptInputCommand;
      },
      set acceptInputCommand(v: T.Command | undefined) {
        acceptInputCommand = v;
        changed();
      },
      statusBarCommands: undefined as T.Command[] | undefined,
      createResourceGroup(groupId: string, groupLabel: string) {
        const g = { id: groupId, label: groupLabel, hideWhenEmpty: false, resourceStates: [] as ResourceState[] };
        groups.push(g);
        changed();
        return {
          id: groupId,
          get label() {
            return g.label;
          },
          set label(v: string) {
            g.label = v;
            changed();
          },
          get hideWhenEmpty() {
            return g.hideWhenEmpty;
          },
          set hideWhenEmpty(v: boolean) {
            g.hideWhenEmpty = !!v;
            changed();
          },
          get resourceStates() {
            return g.resourceStates;
          },
          set resourceStates(v: ResourceState[]) {
            g.resourceStates = Array.isArray(v) ? v : [];
            changed();
          },
          dispose() {
            const i = groups.indexOf(g);
            if (i >= 0) groups.splice(i, 1);
            changed();
          },
        };
      },
      dispose: () => {
        this.#controls.delete(handle);
        void this.rpc.request("$main.scm", ["remove", handle]).catch(() => undefined);
      },
    };
  }

  /** The workbench's view of a control (tests). */
  dto(handle: number) {
    return this.#controls.get(handle)?.dto();
  }
}
