/**
 * `workspace.getConfiguration`: the defaults every extension declares in
 * `contributes.configuration` (and `contributes.configurationDefaults`),
 * TMCode's own editor settings under their VS Code names, and the user's
 * overrides (stored with TMCode's settings). Values are flat dotted keys
 * ("prettier.tabWidth"); sections are views over them. Object values merge
 * (user over default), everything else replaces, as in VS Code.
 */

export type Flat = Record<string, unknown>;

export interface ConfigurationProperty {
  key: string;
  type?: string | string[];
  default?: unknown;
  description?: string;
  markdownDescription?: string;
  enum?: unknown[];
  enumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
  /** Section title (the extension's display name or its configuration title). */
  title: string;
  order?: number;
  deprecationMessage?: string;
  scope?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function typeDefault(type: unknown): unknown {
  const t = Array.isArray(type) ? type[0] : type;
  switch (t) {
    case "boolean":
      return false;
    case "number":
    case "integer":
      return 0;
    case "string":
      return "";
    case "array":
      return [];
    case "object":
      return {};
    default:
      return null;
  }
}

/** The properties of one manifest's contributes.configuration (an object or an array of them). */
export function configurationProperties(contributes: unknown, fallbackTitle: string, localize: (s: unknown) => string = (s) => (typeof s === "string" ? s : "")): ConfigurationProperty[] {
  const c = isObj(contributes) ? contributes.configuration : undefined;
  const blocks = Array.isArray(c) ? c : c ? [c] : [];
  const out: ConfigurationProperty[] = [];
  for (const block of blocks) {
    if (!isObj(block) || !isObj(block.properties)) continue;
    const title = localize(block.title) || fallbackTitle;
    for (const [key, raw] of Object.entries(block.properties)) {
      if (!isObj(raw)) continue;
      out.push({
        key,
        title,
        type: raw.type as string | string[] | undefined,
        default: "default" in raw ? raw.default : typeDefault(raw.type),
        description: localize(raw.description) || undefined,
        markdownDescription: localize(raw.markdownDescription) || undefined,
        enum: Array.isArray(raw.enum) ? raw.enum : undefined,
        enumDescriptions: Array.isArray(raw.enumDescriptions) ? raw.enumDescriptions.map((d) => localize(d)) : Array.isArray(raw.markdownEnumDescriptions) ? raw.markdownEnumDescriptions.map((d) => localize(d)) : undefined,
        minimum: typeof raw.minimum === "number" ? raw.minimum : undefined,
        maximum: typeof raw.maximum === "number" ? raw.maximum : undefined,
        order: typeof raw.order === "number" ? raw.order : undefined,
        deprecationMessage: typeof raw.deprecationMessage === "string" ? raw.deprecationMessage : typeof raw.markdownDeprecationMessage === "string" ? raw.markdownDeprecationMessage : undefined,
        scope: typeof raw.scope === "string" ? raw.scope : undefined,
      });
    }
  }
  return out;
}

/** contributes.configurationDefaults: plain keys and "[language]" blocks. */
export function configurationDefaults(contributes: unknown): Flat {
  const d = isObj(contributes) && isObj(contributes.configurationDefaults) ? contributes.configurationDefaults : {};
  return { ...d };
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

function deepClone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Flat dotted keys → a nested object ("a.b": 1 → {a: {b: 1}}). Later keys win over earlier prefixes. */
export function nest(flat: Flat): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const key of Object.keys(flat).sort((a, b) => a.length - b.length)) {
    if (key.startsWith("[")) continue;
    const parts = key.split(".");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!isObj(node[p])) node[p] = {};
      node = node[p] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1];
    node[last] = deepMerge(node[last], deepClone(flat[key]));
  }
  return root;
}

function lookup(tree: Record<string, unknown>, section: string | undefined): unknown {
  if (!section) return tree;
  let node: unknown = tree;
  for (const p of section.split(".")) {
    if (!isObj(node)) return undefined;
    node = node[p];
  }
  return node;
}

export interface InspectResult<T> {
  key: string;
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
  defaultLanguageValue?: T;
  globalLanguageValue?: T;
  languageIds?: string[];
}

/** One layered configuration: defaults ⊕ user, with optional "[language]" overrides. */
export class ConfigurationModel {
  #defaultsTree: Record<string, unknown> = {};
  #userTree: Record<string, unknown> = {};
  #merged: Record<string, unknown> = {};
  #langCache = new Map<string, Record<string, unknown>>();

  constructor(
    private defaults: Flat,
    private user: Flat,
  ) {
    this.#rebuild();
  }

  #rebuild() {
    this.#defaultsTree = nest(this.defaults);
    this.#userTree = nest(this.user);
    this.#merged = deepMerge(this.#defaultsTree, this.#userTree) as Record<string, unknown>;
    this.#langCache.clear();
  }

  setDefaults(defaults: Flat) {
    this.defaults = defaults;
    this.#rebuild();
  }

  setUser(user: Flat) {
    this.user = user;
    this.#rebuild();
  }

  get userValues(): Flat {
    return this.user;
  }

  #forLanguage(languageId?: string): Record<string, unknown> {
    if (!languageId) return this.#merged;
    const key = `[${languageId}]`;
    let hit = this.#langCache.get(languageId);
    if (!hit) {
      const d = isObj(this.defaults[key]) ? nest(this.defaults[key] as Flat) : {};
      const u = isObj(this.user[key]) ? nest(this.user[key] as Flat) : {};
      hit = deepMerge(deepMerge(this.#merged, d), u) as Record<string, unknown>;
      this.#langCache.set(languageId, hit);
    }
    return hit;
  }

  /** The value at a full dotted key. */
  getValue(key: string | undefined, languageId?: string): unknown {
    return deepClone(lookup(this.#forLanguage(languageId), key));
  }

  inspect<T>(key: string, languageId?: string): InspectResult<T> {
    const def = lookup(this.#defaultsTree, key) as T | undefined;
    const glob = lookup(this.#userTree, key) as T | undefined;
    const out: InspectResult<T> = { key, defaultValue: deepClone(def), globalValue: deepClone(glob) };
    if (languageId) {
      const k = `[${languageId}]`;
      if (isObj(this.defaults[k])) out.defaultLanguageValue = deepClone(lookup(nest(this.defaults[k] as Flat), key) as T);
      if (isObj(this.user[k])) out.globalLanguageValue = deepClone(lookup(nest(this.user[k] as Flat), key) as T);
      out.languageIds = [languageId];
    }
    return out;
  }
}

/** Did a change of `changedKeys` affect `section` (VS Code's affectsConfiguration)? */
export function affects(changedKeys: readonly string[], section: string): boolean {
  return changedKeys.some((k) => {
    const key = k.replace(/^\[[^\]]+\]\.?/, "");
    return !key || key === section || key.startsWith(section + ".") || section.startsWith(key + ".");
  });
}

/** Keys whose value differs between two flat maps. */
export function changedKeys(before: Flat, after: Flat): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}
