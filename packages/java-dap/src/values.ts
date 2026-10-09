// Presents JDWP values as DAP variables: Java-style primitives, quoted strings,
// expandable arrays (chunked), objects (incl. inherited fields), and readable
// views of common java.util collections.
import { formatPrim, quoteString, type Val } from "./expr";
import { BOXES, findField, simpleTypeName, toVal } from "./evaluator";
import { Tag, isPrimitiveTag, type Value } from "./jdwp/packet";
import { ACC_STATIC, type Vm } from "./jdwp/vm";

export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  evaluateName?: string;
  indexedVariables?: number;
  presentationHint?: { kind?: string; attributes?: string[] };
}

export type VarSpec =
  | { kind: "locals"; frameRef: number }
  | { kind: "statics"; classId: bigint }
  | { kind: "object"; id: bigint; evaluateName?: string }
  | { kind: "array"; id: bigint; start: number; count: number; evaluateName?: string };

/** Stable numeric handles for keys (DAP references must be positive integers). */
export class Handles<T> {
  private byKey = new Map<string, number>();
  private items = new Map<number, T>();
  private next = 1;

  get(key: string, make: () => T): number {
    const existing = this.byKey.get(key);
    if (existing !== undefined) return existing;
    const n = this.next++;
    this.byKey.set(key, n);
    this.items.set(n, make());
    return n;
  }
  lookup(n: number): T | undefined {
    return this.items.get(n);
  }
}

const CHUNK = 100;
const MAX_COLLECTION_CHILDREN = 1000;
const PREVIEW_LIMIT = 10;

type Special =
  | { kind: "boxed" }
  | { kind: "enum" }
  | { kind: "builder" }
  | { kind: "list" | "linked" | "hashmap" | "linkedmap" | "treemap" | "hashset" | "treeset" };

const COLLECTIONS: Record<string, Special["kind"]> = {
  "Ljava/util/ArrayList;": "list",
  "Ljava/util/LinkedList;": "linked",
  "Ljava/util/LinkedHashMap;": "linkedmap",
  "Ljava/util/HashMap;": "hashmap",
  "Ljava/util/TreeMap;": "treemap",
  "Ljava/util/HashSet;": "hashset",
  "Ljava/util/TreeSet;": "treeset",
};

export class Inspector {
  constructor(
    private vm: Vm,
    readonly handles: Handles<VarSpec>,
  ) {}

  private async special(classId: bigint): Promise<Special | null> {
    const sig = await this.vm.signature(classId);
    if (BOXES[sig]) return { kind: "boxed" };
    for (const c of await this.vm.hierarchy(classId)) {
      const s = await this.vm.signature(c);
      if (s === "Ljava/lang/Enum;") return { kind: "enum" };
      if (s === "Ljava/lang/AbstractStringBuilder;") return { kind: "builder" };
      const coll = COLLECTIONS[s];
      if (coll) return { kind: coll } as Special;
    }
    return null;
  }

  private async field(obj: bigint, classId: bigint, name: string): Promise<Value | null> {
    const f = await findField(this.vm, classId, name);
    if (!f) return null;
    const [v] = await this.vm.objectValues(obj, [f.id]);
    return v;
  }

  /** Presents a value; `declaredSig` names the static type (used for null). */
  async present(v: Value, evaluateName?: string, declaredSig?: string): Promise<Omit<DapVariable, "name">> {
    if (isPrimitiveTag(v.tag)) {
      const p = toVal(v) as Extract<Val, { k: "prim" }>;
      return { value: formatPrim(p), type: simpleTypeName(String.fromCharCode(v.tag)), variablesReference: 0, evaluateName };
    }
    const id = v.value as bigint;
    if (id === 0n) return { value: "null", type: declaredSig ? simpleTypeName(declaredSig) : undefined, variablesReference: 0, evaluateName };
    if (v.tag === Tag.STRING) return { value: quoteString(await this.vm.stringValue(id)), type: "String", variablesReference: 0, evaluateName };
    const type = await this.vm.objectType(id);
    const sig = await this.vm.signature(type.id);
    const typeName = simpleTypeName(sig);

    if (sig.startsWith("[")) {
      const len = await this.vm.arrayLength(id);
      let value = `${simpleTypeName(sig.slice(1))}[${len}]`;
      const elem = sig.slice(1);
      if (len <= PREVIEW_LIMIT && (elem.length === 1 || elem === "Ljava/lang/String;")) {
        const items = await this.vm.arrayValues(id, 0, len);
        const parts: string[] = [];
        for (const it of items) parts.push((await this.present(it)).value);
        value = `[${parts.join(", ")}]`;
      }
      const ref = len ? this.handles.get(`array:${id}:0:${len}`, () => ({ kind: "array", id, start: 0, count: len, evaluateName })) : 0;
      return { value, type: typeName, variablesReference: ref, indexedVariables: len || undefined, evaluateName };
    }

    const ref = this.handles.get(`obj:${id}`, () => ({ kind: "object", id, evaluateName }));
    const special = await this.special(type.id);
    switch (special?.kind) {
      case "boxed": {
        const inner = await this.field(id, type.id, "value");
        return { value: inner ? formatPrim(toVal(inner) as Extract<Val, { k: "prim" }>) : typeName, type: typeName, variablesReference: 0, evaluateName };
      }
      case "enum": {
        const name = await this.field(id, type.id, "name");
        return { value: name && name.value !== 0n ? await this.vm.stringValue(name.value as bigint) : typeName, type: typeName, variablesReference: ref, evaluateName };
      }
      case "builder":
        return { value: quoteString(await this.builderText(id, type.id)), type: typeName, variablesReference: ref, evaluateName };
      case undefined:
        break;
      default: {
        const size = await this.collectionSize(id, type.id, special!.kind);
        return { value: `${typeName} (size=${size})`, type: typeName, variablesReference: ref, evaluateName };
      }
    }
    return { value: `${typeName} (id=${id})`, type: typeName, variablesReference: ref, evaluateName };
  }

  private async builderText(id: bigint, classId: bigint): Promise<string> {
    const value = await this.field(id, classId, "value");
    const count = await this.field(id, classId, "count");
    const coder = await this.field(id, classId, "coder");
    if (!value || value.value === 0n || !count) return "";
    const n = Number(count.value);
    const utf16 = coder ? Number(coder.value) === 1 : false;
    const raw = await this.vm.arrayValues(value.value as bigint, 0, utf16 ? n * 2 : n);
    if (raw[0]?.tag === Tag.CHAR) return String.fromCharCode(...raw.map((r) => Number(r.value)));
    const bytes = raw.map((r) => Number(r.value) & 0xff);
    if (!utf16) return String.fromCharCode(...bytes);
    let s = "";
    // HotSpot stores UTF16 in the platform byte order (little-endian on x86/ARM).
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    return s;
  }

  private async collectionSize(id: bigint, classId: bigint, kind: Special["kind"]): Promise<number> {
    if (kind === "hashset" || kind === "treeset") {
      const inner = await this.field(id, classId, kind === "hashset" ? "map" : "m");
      if (!inner || inner.value === 0n) return 0;
      const t = await this.vm.objectType(inner.value as bigint);
      return this.collectionSize(inner.value as bigint, t.id, "hashmap");
    }
    const size = await this.field(id, classId, "size");
    return size ? Number(size.value) : 0;
  }

  /** Children for a variables reference (not locals; the session handles those). */
  async children(spec: VarSpec): Promise<DapVariable[]> {
    switch (spec.kind) {
      case "array":
        return this.arrayChildren(spec);
      case "statics":
        return this.staticChildren(spec.classId);
      case "object":
        return this.objectChildren(spec.id, spec.evaluateName);
      default:
        return [];
    }
  }

  private async arrayChildren(spec: Extract<VarSpec, { kind: "array" }>): Promise<DapVariable[]> {
    const { id, start, count } = spec;
    if (count > CHUNK) {
      let chunk = CHUNK;
      while (count / chunk > CHUNK) chunk *= CHUNK;
      const out: DapVariable[] = [];
      for (let s = start; s < start + count; s += chunk) {
        const n = Math.min(chunk, start + count - s);
        const ref = this.handles.get(`array:${id}:${s}:${n}`, () => ({ kind: "array", id, start: s, count: n, evaluateName: spec.evaluateName }));
        out.push({ name: `[${s}..${s + n - 1}]`, value: "", variablesReference: ref, indexedVariables: n });
      }
      return out;
    }
    const sig = await this.vm.signature((await this.vm.objectType(id)).id);
    const values = await this.vm.arrayValues(id, start, count);
    const out: DapVariable[] = [];
    for (let i = 0; i < values.length; i++) {
      const name = `[${start + i}]`;
      out.push({ name, ...(await this.present(values[i], spec.evaluateName ? `${spec.evaluateName}${name}` : undefined, sig.slice(1))) });
    }
    return out;
  }

  private async staticChildren(classId: bigint): Promise<DapVariable[]> {
    const fields = (await this.vm.fields(classId)).filter((f) => f.modifiers & ACC_STATIC && !(f.modifiers & 0xf0000000) && !f.name.startsWith("$"));
    const values = await this.vm.staticValues(classId, fields.map((f) => f.id));
    const owner = simpleTypeName(await this.vm.signature(classId));
    const out: DapVariable[] = [];
    for (let i = 0; i < fields.length; i++) {
      out.push({ name: fields[i].name, ...(await this.present(values[i], `${owner}.${fields[i].name}`, fields[i].signature)), presentationHint: { attributes: ["static"] } });
    }
    return out;
  }

  /** Instance fields (inherited ones too), or a collection's elements. */
  private async objectChildren(id: bigint, evaluateName?: string): Promise<DapVariable[]> {
    const type = await this.vm.objectType(id);
    const special = await this.special(type.id);
    if (special && special.kind !== "boxed" && special.kind !== "enum" && special.kind !== "builder") {
      try {
        return await this.collectionChildren(id, type.id, special.kind, evaluateName);
      } catch {
        // Unexpected JDK internals: fall back to raw fields.
      }
    }
    const hierarchy = await this.vm.hierarchy(type.id);
    const fields = [];
    const seen = new Set<string>();
    for (const c of hierarchy) {
      for (const f of await this.vm.fields(c)) {
        if (f.modifiers & ACC_STATIC) continue;
        const shadowed = seen.has(f.name);
        seen.add(f.name);
        fields.push({ f, label: shadowed ? `${f.name} (${simpleTypeName(await this.vm.signature(c)).split("$").pop()})` : f.name });
      }
    }
    const values = await this.vm.objectValues(id, fields.map((x) => x.f.id));
    const out: DapVariable[] = [];
    for (let i = 0; i < fields.length; i++) {
      const { f, label } = fields[i];
      out.push({ name: label, ...(await this.present(values[i], evaluateName ? `${evaluateName}.${f.name}` : undefined, f.signature)) });
    }
    return out;
  }

  private async collectionChildren(id: bigint, classId: bigint, kind: Special["kind"], evaluateName?: string): Promise<DapVariable[]> {
    const out: DapVariable[] = [];
    const push = async (name: string, v: Value, evalName?: string) => out.push({ name, ...(await this.present(v, evalName)) });
    const objField = async (obj: bigint, name: string): Promise<bigint> => {
      const t = await this.vm.objectType(obj);
      const v = await this.field(obj, t.id, name);
      return v ? (v.value as bigint) : 0n;
    };
    const valueField = async (obj: bigint, name: string): Promise<Value> => {
      const t = await this.vm.objectType(obj);
      return (await this.field(obj, t.id, name)) ?? { tag: Tag.OBJECT, value: 0n };
    };
    const entry = async (key: Value, value: Value) => {
      const k = await this.present(key);
      await push(k.value, value, undefined);
    };

    switch (kind) {
      case "list": {
        const size = Math.min(await this.collectionSize(id, classId, kind), MAX_COLLECTION_CHILDREN);
        const data = await objField(id, "elementData");
        const values = data ? await this.vm.arrayValues(data, 0, size) : [];
        for (let i = 0; i < values.length; i++) await push(`[${i}]`, values[i], evaluateName ? `${evaluateName}.get(${i})` : undefined);
        break;
      }
      case "linked": {
        let node = await objField(id, "first");
        for (let i = 0; node !== 0n && i < MAX_COLLECTION_CHILDREN; i++) {
          await push(`[${i}]`, await valueField(node, "item"), evaluateName ? `${evaluateName}.get(${i})` : undefined);
          node = await objField(node, "next");
        }
        break;
      }
      case "linkedmap": {
        let node = await objField(id, "head");
        for (let i = 0; node !== 0n && i < MAX_COLLECTION_CHILDREN; i++) {
          await entry(await valueField(node, "key"), await valueField(node, "value"));
          node = await objField(node, "after");
        }
        break;
      }
      case "hashmap": {
        const table = await objField(id, "table");
        if (!table) break;
        const buckets = await this.vm.arrayValues(table, 0, await this.vm.arrayLength(table));
        for (const b of buckets) {
          for (let node = b.value as bigint; node !== 0n && out.length < MAX_COLLECTION_CHILDREN; node = await objField(node, "next")) {
            await entry(await valueField(node, "key"), await valueField(node, "value"));
          }
        }
        break;
      }
      case "treemap": {
        const walk = async (node: bigint): Promise<void> => {
          if (node === 0n || out.length >= MAX_COLLECTION_CHILDREN) return;
          await walk(await objField(node, "left"));
          if (out.length < MAX_COLLECTION_CHILDREN) await entry(await valueField(node, "key"), await valueField(node, "value"));
          await walk(await objField(node, "right"));
        };
        await walk(await objField(id, "root"));
        break;
      }
      case "hashset":
      case "treeset": {
        const map = await objField(id, kind === "hashset" ? "map" : "m");
        if (!map) break;
        const mapType = await this.vm.objectType(map);
        const mapKind = (await this.special(mapType.id))?.kind;
        if (mapKind !== "hashmap" && mapKind !== "linkedmap" && mapKind !== "treemap") throw new Error("unknown set backing map");
        // A set shows its elements, not key -> PRESENT entries.
        const keys = await this.setKeys(map, mapKind);
        for (let i = 0; i < keys.length; i++) out.push({ name: `[${i}]`, ...(await this.present(keys[i])) });
        break;
      }
    }
    return out;
  }

  private async setKeys(map: bigint, kind: "hashmap" | "linkedmap" | "treemap"): Promise<Value[]> {
    const keys: Value[] = [];
    const objField = async (obj: bigint, name: string): Promise<Value> => {
      const t = await this.vm.objectType(obj);
      return (await this.field(obj, t.id, name)) ?? { tag: Tag.OBJECT, value: 0n };
    };
    if (kind === "linkedmap") {
      for (let n = (await objField(map, "head")).value as bigint; n !== 0n && keys.length < MAX_COLLECTION_CHILDREN; n = (await objField(n, "after")).value as bigint) keys.push(await objField(n, "key"));
    } else if (kind === "hashmap") {
      const table = (await objField(map, "table")).value as bigint;
      if (table) {
        for (const b of await this.vm.arrayValues(table, 0, await this.vm.arrayLength(table))) {
          for (let n = b.value as bigint; n !== 0n && keys.length < MAX_COLLECTION_CHILDREN; n = (await objField(n, "next")).value as bigint) keys.push(await objField(n, "key"));
        }
      }
    } else {
      const walk = async (n: bigint): Promise<void> => {
        if (n === 0n || keys.length >= MAX_COLLECTION_CHILDREN) return;
        await walk((await objField(n, "left")).value as bigint);
        keys.push(await objField(n, "key"));
        await walk((await objField(n, "right")).value as bigint);
      };
      await walk((await objField(map, "root")).value as bigint);
    }
    return keys;
  }
}
