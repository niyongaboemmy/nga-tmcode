// Evaluates parsed expressions (expr.ts) against a suspended frame over JDWP.
import { EvalError, arith, bool, compare, formatPrim, int, negate, parse, type Node, type PrimType, type Val } from "./expr";
import { Tag, isPrimitiveTag, type Value } from "./jdwp/packet";
import { ACC_STATIC, type FieldInfo, type Frame, type LocalVariable, type Vm } from "./jdwp/vm";

export interface EvalContext {
  vm: Vm;
  thread: bigint;
  /** The frame to evaluate in (re-fetched after method invocations). */
  frame(): Promise<Frame>;
  /** Frame IDs become invalid once the thread ran (method invocation). */
  invalidateFrames(): void;
  /** Breakpoints hit while invoking a method must not stop the program. */
  setInvoking(on: boolean): void;
}

export const BOXES: Record<string, PrimType> = {
  "Ljava/lang/Integer;": "I",
  "Ljava/lang/Long;": "J",
  "Ljava/lang/Short;": "S",
  "Ljava/lang/Byte;": "B",
  "Ljava/lang/Character;": "C",
  "Ljava/lang/Float;": "F",
  "Ljava/lang/Double;": "D",
  "Ljava/lang/Boolean;": "Z",
};

export const toVal = (v: Value): Val =>
  isPrimitiveTag(v.tag) ? { k: "prim", t: String.fromCharCode(v.tag) as PrimType, v: v.value } : { k: "obj", id: v.value as bigint, tag: v.tag };

/** Local variables visible at the frame's location (needs -g), ordered by declaration. */
export async function visibleLocals(vm: Vm, frame: Frame): Promise<LocalVariable[] | null> {
  const table = await vm.variableTable(frame.location.classId, frame.location.methodId);
  if (!table) return null;
  const idx = frame.location.index;
  return table.vars
    .filter((v) => v.codeIndex <= idx && idx < v.codeIndex + BigInt(v.length))
    .sort((a, b) => (a.codeIndex === b.codeIndex ? a.slot - b.slot : a.codeIndex < b.codeIndex ? -1 : 1));
}

/** Finds a field by name in a class and its superclasses. */
export async function findField(vm: Vm, classId: bigint, name: string): Promise<FieldInfo | undefined> {
  for (const c of await vm.hierarchy(classId)) {
    const f = (await vm.fields(c)).find((x) => x.name === name);
    if (f) return f;
  }
  return undefined;
}

/** "Ljava/util/ArrayList;" -> "ArrayList", "[I" -> "int[]". */
export function simpleTypeName(sig: string): string {
  if (sig.startsWith("[")) return simpleTypeName(sig.slice(1)) + "[]";
  const prim: Record<string, string> = { I: "int", J: "long", S: "short", B: "byte", C: "char", F: "float", D: "double", Z: "boolean", V: "void" };
  if (prim[sig]) return prim[sig];
  const name = sig.replace(/^L/, "").replace(/;$/, "");
  return name.slice(name.lastIndexOf("/") + 1);
}

/** "Lcom/example/App$Inner;" -> "com.example.App$Inner". */
export function qualifiedTypeName(sig: string): string {
  if (sig.startsWith("[")) return qualifiedTypeName(sig.slice(1)) + "[]";
  if (sig.length === 1) return simpleTypeName(sig);
  return sig.replace(/^L/, "").replace(/;$/, "").replace(/\//g, ".");
}

/** Parameter signatures of a method signature "(I[Ljava/lang/String;)V". */
export function paramSignatures(methodSig: string): string[] {
  const out: string[] = [];
  let i = 1;
  while (methodSig[i] !== ")") {
    let j = i;
    while (methodSig[j] === "[") j++;
    if (methodSig[j] === "L") j = methodSig.indexOf(";", j);
    out.push(methodSig.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

const WIDEN: Record<string, string> = { B: "SIJFD", S: "IJFD", C: "IJFD", I: "JFD", J: "FD", F: "D" };

export class Evaluator {
  constructor(private ctx: EvalContext) {}

  private get vm() {
    return this.ctx.vm;
  }

  async evaluate(src: string): Promise<Val> {
    return this.eval(parse(src));
  }

  async eval(n: Node): Promise<Val> {
    switch (n.t) {
      case "lit":
        return n.v;
      case "this": {
        const t = await this.thisObject();
        if (t === 0n) throw new EvalError("'this' is not available in a static method");
        return { k: "obj", id: t, tag: Tag.OBJECT };
      }
      case "name":
        return this.name(n.name);
      case "field":
        return this.field(n);
      case "index":
        return this.index(await this.eval(n.obj), await this.eval(n.index));
      case "call":
        return this.call(n);
      case "unary": {
        const v = await this.eval(n.e);
        if (n.op === "!") return bool(!(await this.truth(v)));
        return negate(await this.unbox(v), n.op as "-" | "+");
      }
      case "cond":
        return (await this.truth(await this.eval(n.c))) ? this.eval(n.a) : this.eval(n.b);
      case "binary":
        return this.binary(n.op, n.l, n.r);
    }
  }

  // ── names ──

  private async name(name: string): Promise<Val> {
    const frame = await this.ctx.frame();
    const locals = await visibleLocals(this.vm, frame);
    const local = locals?.find((v) => v.name === name);
    if (local) {
      const [value] = await this.vm.frameValues(this.ctx.thread, frame.id, [{ slot: local.slot, tag: local.signature.charCodeAt(0) }]);
      return toVal(value);
    }
    const self = await this.thisObject();
    if (self !== 0n) {
      const type = await this.vm.objectType(self);
      const f = await findField(this.vm, type.id, name);
      if (f) return this.readField(self, f);
    }
    // Static fields of the current class and its enclosing classes.
    let sig = await this.vm.signature(frame.location.classId);
    for (;;) {
      const [cls] = await this.vm.classesBySignature(sig);
      if (cls) {
        const f = await findField(this.vm, cls.id, name);
        if (f && f.modifiers & ACC_STATIC) return this.readField(0n, f);
      }
      const dollar = sig.lastIndexOf("$");
      if (dollar < 0) break;
      sig = sig.slice(0, dollar) + ";";
    }
    const cls = await this.resolveClass(name);
    if (cls) return cls;
    if (!locals) throw new EvalError(`cannot find symbol: ${name} (compile with javac -g to see local variables)`);
    throw new EvalError(`cannot find symbol: ${name}`);
  }

  private async thisObject(): Promise<bigint> {
    const frame = await this.ctx.frame();
    const v = await this.vm.thisObject(this.ctx.thread, frame.id);
    return v.value as bigint;
  }

  /** Resolves a (simple or qualified) class name to a loaded class. */
  async resolveClass(name: string): Promise<Val | null> {
    const frame = await this.ctx.frame();
    const here = await this.vm.signature(frame.location.classId);
    const pkg = here.slice(1, Math.max(1, here.lastIndexOf("/") + 1));
    const internal = name.replace(/\./g, "/");
    const candidates = name.includes(".") ? [internal] : [pkg + internal, "java/lang/" + internal, internal, `${here.slice(1, -1).split("$")[0]}$${internal}`];
    for (const c of candidates) {
      const sig = `L${c};`;
      const [cls] = await this.vm.classesBySignature(sig);
      if (cls) return { k: "class", id: cls.id, sig };
    }
    return null;
  }

  private async readField(obj: bigint, f: FieldInfo): Promise<Val> {
    const [v] = f.modifiers & ACC_STATIC ? await this.vm.staticValues(f.owner, [f.id]) : await this.vm.objectValues(obj, [f.id]);
    return toVal(v);
  }

  private async field(n: Extract<Node, { t: "field" }>): Promise<Val> {
    let target: Val;
    try {
      target = await this.eval(n.obj);
    } catch (e) {
      // `java.lang.Math.PI`, `com.example.Util.COUNT`: a qualified class name.
      const q = qualified(n.obj);
      const cls = q && e instanceof EvalError ? await this.resolveClass(q) : null;
      if (!cls) throw e;
      target = cls;
    }
    if (target.k === "class") {
      const f = await findField(this.vm, target.id, n.name);
      if (f && f.modifiers & ACC_STATIC) return this.readField(0n, f);
      const nested = await this.vm.classesBySignature(`${target.sig.slice(0, -1)}$${n.name};`);
      if (nested[0]) return { k: "class", id: nested[0].id, sig: nested[0].signature };
      throw new EvalError(`cannot find symbol: ${n.name} in ${qualifiedTypeName(target.sig)}`);
    }
    if (target.k === "str") {
      if (n.name === "length") throw new EvalError("use length() on a String");
      throw new EvalError(`cannot find symbol: ${n.name}`);
    }
    if (target.k === "prim") throw new EvalError(`${formatPrim(target)} is a primitive and has no field ${n.name}`);
    if (target.k === "void") throw new EvalError("a void result has no fields");
    if (target.id === 0n) throw new EvalError(`java.lang.NullPointerException: cannot read field "${n.name}" because "${describe(n.obj)}" is null`);
    if (target.tag === Tag.ARRAY) {
      if (n.name === "length") return int(await this.vm.arrayLength(target.id));
      throw new EvalError(`arrays have no field ${n.name}`);
    }
    const type = await this.vm.objectType(target.id);
    const f = await findField(this.vm, type.id, n.name);
    if (!f) throw new EvalError(`cannot find symbol: ${n.name} in ${simpleTypeName(await this.vm.signature(type.id))}`);
    return this.readField(target.id, f);
  }

  private async index(arr: Val, idx: Val): Promise<Val> {
    if (arr.k !== "obj" || arr.tag !== Tag.ARRAY) {
      if (arr.k === "obj" && arr.id === 0n) throw new EvalError("java.lang.NullPointerException: the array is null");
      throw new EvalError("array required for [ ]");
    }
    const i = await this.unbox(idx);
    if (i.t === "J" || i.t === "F" || i.t === "D" || i.t === "Z") throw new EvalError("array index must be an int");
    const n = Number(i.v);
    const len = await this.vm.arrayLength(arr.id);
    if (n < 0 || n >= len) throw new EvalError(`java.lang.ArrayIndexOutOfBoundsException: Index ${n} out of bounds for length ${len}`);
    const [v] = await this.vm.arrayValues(arr.id, n, 1);
    return toVal(v);
  }

  // ── method calls ──

  private async call(n: Extract<Node, { t: "call" }>): Promise<Val> {
    let target: Val | null = null;
    if (n.obj) {
      try {
        target = await this.eval(n.obj);
      } catch (e) {
        const q = qualified(n.obj);
        const cls = q && e instanceof EvalError ? await this.resolveClass(q) : null;
        if (!cls) throw e;
        target = cls;
      }
    }
    const args: Val[] = [];
    for (const a of n.args) args.push(await this.eval(a));

    let objectId = 0n;
    let classId: bigint;
    if (!target) {
      const self = await this.thisObject();
      const frame = await this.ctx.frame();
      objectId = self;
      classId = self !== 0n ? (await this.vm.objectType(self)).id : frame.location.classId;
    } else if (target.k === "class") {
      classId = target.id;
    } else if (target.k === "prim" || target.k === "void") {
      throw new EvalError(`${target.k === "prim" ? formatPrim(target) : "void"} is not an object; cannot call ${n.name}()`);
    } else {
      if (target.k === "str") target = { k: "obj", id: await this.vm.createString(target.v), tag: Tag.STRING };
      if (target.id === 0n) throw new EvalError(`java.lang.NullPointerException: cannot invoke ${n.name}() because "${describe(n.obj!)}" is null`);
      objectId = target.id;
      classId = (await this.vm.objectType(target.id)).id;
    }
    return this.invoke(objectId, classId, n.name, args, !target || target.k !== "class");
  }

  /** Invokes `name` on an object (or statically on classId when objectId is 0n). */
  async invoke(objectId: bigint, classId: bigint, name: string, args: Val[], allowInstance = true): Promise<Val> {
    let chosen: { owner: bigint; id: bigint; signature: string; modifiers: number } | undefined;
    let fallback: typeof chosen;
    for (const c of await this.vm.hierarchy(classId)) {
      for (const m of await this.vm.methods(c)) {
        if (m.name !== name) continue;
        const params = paramSignatures(m.signature);
        if (params.length !== args.length) continue;
        if (objectId === 0n && !(m.modifiers & ACC_STATIC)) continue;
        if (!allowInstance && !(m.modifiers & ACC_STATIC)) continue;
        const cand = { owner: c, ...m };
        if (params.every((p, i) => this.accepts(p, args[i]))) {
          chosen = cand;
          break;
        }
        fallback ??= cand;
      }
      if (chosen) break;
    }
    chosen ??= fallback;
    if (!chosen) throw new EvalError(`cannot find method ${name}(${args.length === 0 ? "" : "…"}) with ${args.length} argument(s) in ${simpleTypeName(await this.vm.signature(classId))}`);
    const params = paramSignatures(chosen.signature);
    const values: Value[] = [];
    for (let i = 0; i < args.length; i++) values.push(await this.coerce(args[i], params[i]));
    this.ctx.setInvoking(true);
    let result: { value: Value; exception: Value };
    try {
      result =
        chosen.modifiers & ACC_STATIC
          ? await this.vm.invokeStatic(chosen.owner, this.ctx.thread, chosen.id, values)
          : await this.vm.invokeMethod(objectId, this.ctx.thread, chosen.owner, chosen.id, values);
    } catch (e) {
      throw new EvalError(`cannot call ${name}(): ${(e as Error).message}${/THREAD_NOT_SUSPENDED|INVALID_THREAD/.test(String(e)) ? " (method calls need a program stopped at a breakpoint or step)" : ""}`);
    } finally {
      this.ctx.setInvoking(false);
      this.ctx.invalidateFrames();
    }
    if (result.exception.value !== 0n) {
      const ex = result.exception.value as bigint;
      throw new EvalError(`${name}() threw ${await this.describeThrowable(ex)}`);
    }
    if (result.value.tag === Tag.VOID) return { k: "void" };
    return toVal(result.value);
  }

  async describeThrowable(ex: bigint): Promise<string> {
    const type = await this.vm.objectType(ex);
    const name = qualifiedTypeName(await this.vm.signature(type.id));
    const f = await findField(this.vm, type.id, "detailMessage");
    if (!f) return name;
    const [m] = await this.vm.objectValues(ex, [f.id]);
    return m.value === 0n ? name : `${name}: ${await this.vm.stringValue(m.value as bigint)}`;
  }

  private accepts(param: string, arg: Val): boolean {
    if (arg.k === "prim") {
      if (param.length === 1) return param === arg.t || (WIDEN[arg.t] ?? "").includes(param);
      return param === "Ljava/lang/Object;" || BOXES[param] === arg.t || param === "Ljava/lang/Number;";
    }
    if (param.length === 1) return false;
    if (arg.k === "str") return param === "Ljava/lang/String;" || param === "Ljava/lang/Object;" || param === "Ljava/lang/CharSequence;";
    return true;
  }

  /** Converts an evaluator value into a JDWP value for a parameter/variable of type `sig`. */
  async coerce(v: Val, sig: string): Promise<Value> {
    if (sig.length === 1) {
      const p = await this.unbox(v);
      const t = sig as PrimType;
      if (t === "Z") {
        if (p.t !== "Z") throw new EvalError("incompatible types: a number cannot be converted to boolean");
        return { tag: Tag.BOOLEAN, value: p.v };
      }
      if (p.t === "Z") throw new EvalError("incompatible types: boolean cannot be converted to a number");
      const num = typeof p.v === "bigint" ? Number(p.v) : Number(p.v);
      switch (t) {
        case "J":
          return { tag: Tag.LONG, value: typeof p.v === "bigint" ? p.v : BigInt(Math.trunc(num)) };
        case "F":
          return { tag: Tag.FLOAT, value: Math.fround(num) };
        case "D":
          return { tag: Tag.DOUBLE, value: num };
        case "I":
          return { tag: Tag.INT, value: Math.trunc(num) | 0 };
        case "S":
          return { tag: Tag.SHORT, value: (Math.trunc(num) << 16) >> 16 };
        case "B":
          return { tag: Tag.BYTE, value: (Math.trunc(num) << 24) >> 24 };
        case "C":
          return { tag: Tag.CHAR, value: Math.trunc(num) & 0xffff };
      }
    }
    if (v.k === "str") return { tag: Tag.STRING, value: await this.vm.createString(v.v) };
    if (v.k === "obj") return { tag: v.tag, value: v.id };
    if (v.k === "class" || v.k === "void") throw new EvalError(v.k === "void" ? "a void result is not a value" : "a class name is not a value");
    // Autobox a primitive for an object parameter.
    const boxSig = Object.keys(BOXES).find((k) => BOXES[k] === v.t)!;
    const [cls] = await this.vm.classesBySignature(boxSig);
    if (!cls) throw new EvalError(`cannot box ${formatPrim(v)}`);
    const boxed = await this.invoke(0n, cls.id, "valueOf", [v], false);
    if (boxed.k !== "obj") throw new EvalError(`cannot box ${formatPrim(v)}`);
    return { tag: Tag.OBJECT, value: boxed.id };
  }

  // ── operators ──

  private async binary(op: string, l: Node, r: Node): Promise<Val> {
    if (op === "&&") return bool((await this.truth(await this.eval(l))) && (await this.truth(await this.eval(r))));
    if (op === "||") return bool((await this.truth(await this.eval(l))) || (await this.truth(await this.eval(r))));
    const a = await this.eval(l);
    const b = await this.eval(r);
    if (op === "+" && ((await this.isString(a)) || (await this.isString(b)))) {
      return { k: "str", v: (await this.javaString(a)) + (await this.javaString(b)) };
    }
    if (op === "==" || op === "!=") {
      const eq = await this.equals(a, b);
      return bool(op === "==" ? eq : !eq);
    }
    if (["<", ">", "<=", ">="].includes(op)) return compare(op, await this.unbox(a), await this.unbox(b));
    return arith(op, await this.unbox(a), await this.unbox(b));
  }

  private async equals(a: Val, b: Val): Promise<boolean> {
    if (a.k === "prim" || b.k === "prim") {
      const r = compare("==", await this.unbox(a), await this.unbox(b));
      return r.k === "prim" && r.v === true;
    }
    if (a.k === "class" || b.k === "class" || a.k === "void" || b.k === "void") throw new EvalError("not a value");
    const aNull = a.k === "obj" && a.id === 0n;
    const bNull = b.k === "obj" && b.id === 0n;
    if (aNull || bNull) return aNull && bNull;
    // Strings compare by contents (what students mean by `name == "Bob"`).
    if ((await this.isString(a)) && (await this.isString(b))) return (await this.javaString(a)) === (await this.javaString(b));
    return a.k === "obj" && b.k === "obj" && a.id === b.id;
  }

  async truth(v: Val): Promise<boolean> {
    const p = await this.unbox(v);
    if (p.t !== "Z") throw new EvalError(`incompatible types: ${formatPrim(p)} is not a boolean`);
    return p.v === true;
  }

  private async isString(v: Val): Promise<boolean> {
    return v.k === "str" || (v.k === "obj" && v.id !== 0n && v.tag === Tag.STRING);
  }

  async unbox(v: Val): Promise<Extract<Val, { k: "prim" }>> {
    if (v.k === "prim") return v;
    if (v.k === "obj" && v.id !== 0n) {
      const type = await this.vm.objectType(v.id);
      const sig = await this.vm.signature(type.id);
      const t = BOXES[sig];
      if (t) {
        const f = await findField(this.vm, type.id, "value");
        if (f) {
          const [x] = await this.vm.objectValues(v.id, [f.id]);
          return toVal(x) as Extract<Val, { k: "prim" }>;
        }
      }
      throw new EvalError(`bad operand: ${simpleTypeName(sig)} is not a number or boolean`);
    }
    if (v.k === "obj") throw new EvalError("java.lang.NullPointerException: null in an arithmetic or boolean expression");
    throw new EvalError(v.k === "str" ? "bad operand: a String is not a number" : "not a value");
  }

  /** String conversion as in `"" + v` (calls toString() on objects). */
  async javaString(v: Val): Promise<string> {
    if (v.k === "prim") return formatPrim(v, false);
    if (v.k === "str") return v.v;
    if (v.k === "class") return `class ${qualifiedTypeName(v.sig)}`;
    if (v.k === "void") throw new EvalError("a void result is not a value");
    if (v.id === 0n) return "null";
    if (v.tag === Tag.STRING) return this.vm.stringValue(v.id);
    const type = await this.vm.objectType(v.id);
    const s = await this.invoke(v.id, type.id, "toString", []);
    return s.k === "obj" && s.id !== 0n ? this.vm.stringValue(s.id) : "null";
  }
}

function qualified(n: Node): string | null {
  if (n.t === "name") return n.name;
  if (n.t === "field") {
    const q = qualified(n.obj);
    return q ? `${q}.${n.name}` : null;
  }
  return null;
}

function describe(n: Node): string {
  switch (n.t) {
    case "name":
      return n.name;
    case "this":
      return "this";
    case "field":
      return `${describe(n.obj)}.${n.name}`;
    case "index":
      return `${describe(n.obj)}[…]`;
    case "call":
      return `${n.obj ? describe(n.obj) + "." : ""}${n.name}(…)`;
    default:
      return "the value";
  }
}
