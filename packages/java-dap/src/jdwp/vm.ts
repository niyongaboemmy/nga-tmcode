// Typed JDWP commands with the caches a debugger needs (class metadata never changes).
import { JdwpConnection, JdwpError } from "./connection";
import { Reader, type Location, type Value, type Writer } from "./packet";

export const EventKind = {
  SINGLE_STEP: 1,
  BREAKPOINT: 2,
  EXCEPTION: 4,
  THREAD_START: 6,
  THREAD_DEATH: 7,
  CLASS_PREPARE: 8,
  CLASS_UNLOAD: 9,
  VM_START: 90,
  VM_DEATH: 99,
} as const;

export const SuspendPolicy = { NONE: 0, EVENT_THREAD: 1, ALL: 2 } as const;
export const StepDepth = { INTO: 0, OVER: 1, OUT: 2 } as const;
export const StepSize = { MIN: 0, LINE: 1 } as const;
export const ABSENT_INFORMATION = 101;
export const ACC_STATIC = 0x0008;

export type Modifier =
  | { kind: "count"; count: number }
  | { kind: "thread"; thread: bigint }
  | { kind: "classOnly"; refType: bigint }
  | { kind: "classMatch"; pattern: string }
  | { kind: "classExclude"; pattern: string }
  | { kind: "location"; location: Location }
  | { kind: "exception"; refType: bigint; caught: boolean; uncaught: boolean }
  | { kind: "step"; thread: bigint; size: number; depth: number };

export interface FieldInfo {
  id: bigint;
  name: string;
  signature: string;
  modifiers: number;
  /** The class that declares the field. */
  owner: bigint;
}

export interface MethodInfo {
  id: bigint;
  name: string;
  signature: string;
  modifiers: number;
}

export interface LineTable {
  start: bigint;
  end: bigint;
  lines: { index: bigint; line: number }[];
}

export interface LocalVariable {
  codeIndex: bigint;
  name: string;
  signature: string;
  length: number;
  slot: number;
}

export interface VariableTable {
  argCount: number;
  vars: LocalVariable[];
}

export interface ClassRef {
  tag: number;
  id: bigint;
  signature: string;
  status: number;
}

export interface Frame {
  id: bigint;
  location: Location;
}

export type JdwpEvent =
  | { kind: typeof EventKind.VM_START; requestId: number; thread: bigint }
  | { kind: typeof EventKind.VM_DEATH; requestId: number }
  | { kind: typeof EventKind.SINGLE_STEP | typeof EventKind.BREAKPOINT; requestId: number; thread: bigint; location: Location }
  | { kind: typeof EventKind.EXCEPTION; requestId: number; thread: bigint; location: Location; exception: Value; catchLocation: Location | null }
  | { kind: typeof EventKind.THREAD_START | typeof EventKind.THREAD_DEATH; requestId: number; thread: bigint }
  | { kind: typeof EventKind.CLASS_PREPARE; requestId: number; thread: bigint; refTag: number; typeId: bigint; signature: string; status: number }
  | { kind: typeof EventKind.CLASS_UNLOAD; requestId: number; signature: string };

export interface EventSet {
  suspendPolicy: number;
  events: JdwpEvent[];
}

export class Vm {
  private signatures = new Map<bigint, string>();
  private sourceFiles = new Map<bigint, string | null>();
  private fieldCache = new Map<bigint, FieldInfo[]>();
  private methodCache = new Map<bigint, MethodInfo[]>();
  private superCache = new Map<bigint, bigint>();
  private lineTables = new Map<string, LineTable | null>();
  private varTables = new Map<string, VariableTable | null>();
  private objectTypes = new Map<bigint, { tag: number; id: bigint }>();

  constructor(readonly conn: JdwpConnection) {}

  private cmd(set: number, cmd: number, name: string, build?: (w: Writer) => void): Promise<Reader> {
    return this.conn.command(set, cmd, build, name);
  }

  // ── VirtualMachine (1) ──
  async idSizes() {
    const r = await this.cmd(1, 7, "VirtualMachine.IDSizes");
    this.conn.sizes = { field: r.int(), method: r.int(), object: r.int(), refType: r.int(), frame: r.int() };
  }
  async version(): Promise<string> {
    const r = await this.cmd(1, 1, "VirtualMachine.Version");
    const description = r.string();
    r.int();
    r.int();
    const vmVersion = r.string();
    return `${vmVersion} (${description.split("\n")[0]})`;
  }
  async classesBySignature(signature: string): Promise<ClassRef[]> {
    const r = await this.cmd(1, 2, "VirtualMachine.ClassesBySignature", (w) => w.string(signature));
    const n = r.int();
    const out: ClassRef[] = [];
    for (let i = 0; i < n; i++) out.push({ tag: r.ubyte(), id: r.refTypeId(), signature, status: r.int() });
    for (const c of out) this.signatures.set(c.id, signature);
    return out;
  }
  async allClasses(): Promise<ClassRef[]> {
    const r = await this.cmd(1, 3, "VirtualMachine.AllClasses");
    const n = r.int();
    const out: ClassRef[] = [];
    for (let i = 0; i < n; i++) {
      const c = { tag: r.ubyte(), id: r.refTypeId(), signature: r.string(), status: r.int() };
      this.signatures.set(c.id, c.signature);
      out.push(c);
    }
    return out;
  }
  async allThreads(): Promise<bigint[]> {
    const r = await this.cmd(1, 4, "VirtualMachine.AllThreads");
    const n = r.int();
    const out: bigint[] = [];
    for (let i = 0; i < n; i++) out.push(r.objectId());
    return out;
  }
  async dispose() {
    await this.cmd(1, 6, "VirtualMachine.Dispose");
  }
  async suspend() {
    await this.cmd(1, 8, "VirtualMachine.Suspend");
  }
  async resume() {
    await this.cmd(1, 9, "VirtualMachine.Resume");
  }
  async exit(code: number) {
    await this.cmd(1, 10, "VirtualMachine.Exit", (w) => w.int(code));
  }
  async createString(s: string): Promise<bigint> {
    const r = await this.cmd(1, 11, "VirtualMachine.CreateString", (w) => w.string(s));
    return r.objectId();
  }

  // ── ReferenceType (2) ──
  async signature(refType: bigint): Promise<string> {
    const cached = this.signatures.get(refType);
    if (cached) return cached;
    const r = await this.cmd(2, 1, "ReferenceType.Signature", (w) => w.refTypeId(refType));
    const sig = r.string();
    this.signatures.set(refType, sig);
    return sig;
  }
  /** The source file name (e.g. "Main.java"), or null when the class has none. */
  async sourceFile(refType: bigint): Promise<string | null> {
    if (this.sourceFiles.has(refType)) return this.sourceFiles.get(refType)!;
    let name: string | null = null;
    try {
      const r = await this.cmd(2, 7, "ReferenceType.SourceFile", (w) => w.refTypeId(refType));
      name = r.string();
    } catch (e) {
      if (!(e instanceof JdwpError) || e.code !== ABSENT_INFORMATION) throw e;
    }
    this.sourceFiles.set(refType, name);
    return name;
  }
  /** Fields declared by this type (not inherited). */
  async fields(refType: bigint): Promise<FieldInfo[]> {
    const cached = this.fieldCache.get(refType);
    if (cached) return cached;
    const r = await this.cmd(2, 4, "ReferenceType.Fields", (w) => w.refTypeId(refType));
    const n = r.int();
    const out: FieldInfo[] = [];
    for (let i = 0; i < n; i++) out.push({ id: r.fieldId(), name: r.string(), signature: r.string(), modifiers: r.int(), owner: refType });
    this.fieldCache.set(refType, out);
    return out;
  }
  async methods(refType: bigint): Promise<MethodInfo[]> {
    const cached = this.methodCache.get(refType);
    if (cached) return cached;
    const r = await this.cmd(2, 5, "ReferenceType.Methods", (w) => w.refTypeId(refType));
    const n = r.int();
    const out: MethodInfo[] = [];
    for (let i = 0; i < n; i++) out.push({ id: r.methodId(), name: r.string(), signature: r.string(), modifiers: r.int() });
    this.methodCache.set(refType, out);
    return out;
  }
  async method(refType: bigint, methodId: bigint): Promise<MethodInfo | undefined> {
    return (await this.methods(refType)).find((m) => m.id === methodId);
  }
  /** Static field values. */
  async staticValues(refType: bigint, fieldIds: bigint[]): Promise<Value[]> {
    if (!fieldIds.length) return [];
    const r = await this.cmd(2, 6, "ReferenceType.GetValues", (w) => {
      w.refTypeId(refType).int(fieldIds.length);
      for (const f of fieldIds) w.fieldId(f);
    });
    const n = r.int();
    const out: Value[] = [];
    for (let i = 0; i < n; i++) out.push(r.tagged());
    return out;
  }

  // ── ClassType (3) ──
  /** The superclass, or 0n for java.lang.Object, interfaces and arrays. */
  async superclass(classId: bigint): Promise<bigint> {
    const cached = this.superCache.get(classId);
    if (cached !== undefined) return cached;
    let sup = 0n;
    const sig = await this.signature(classId);
    if (!sig.startsWith("[")) {
      try {
        const r = await this.cmd(3, 1, "ClassType.Superclass", (w) => w.refTypeId(classId));
        sup = r.refTypeId();
      } catch {
        sup = 0n; // an interface
      }
    }
    this.superCache.set(classId, sup);
    return sup;
  }
  /** The class and its superclasses, most derived first. */
  async hierarchy(classId: bigint): Promise<bigint[]> {
    const out: bigint[] = [];
    for (let c = classId; c !== 0n; c = await this.superclass(c)) out.push(c);
    return out;
  }
  async setStaticValue(classId: bigint, field: bigint, value: Value) {
    await this.cmd(3, 2, "ClassType.SetValues", (w) => w.refTypeId(classId).int(1).fieldId(field).untagged(value));
  }
  async invokeStatic(classId: bigint, thread: bigint, methodId: bigint, args: Value[], options = 1): Promise<{ value: Value; exception: Value }> {
    const r = await this.cmd(3, 3, "ClassType.InvokeMethod", (w) => {
      w.refTypeId(classId).objectId(thread).methodId(methodId).int(args.length);
      for (const a of args) w.tagged(a);
      w.int(options);
    });
    return { value: r.tagged(), exception: r.tagged() };
  }

  // ── Method (6) ──
  async lineTable(classId: bigint, methodId: bigint): Promise<LineTable | null> {
    const key = `${classId}:${methodId}`;
    if (this.lineTables.has(key)) return this.lineTables.get(key)!;
    let table: LineTable | null = null;
    try {
      const r = await this.cmd(6, 1, "Method.LineTable", (w) => w.refTypeId(classId).methodId(methodId));
      const start = r.long();
      const end = r.long();
      const n = r.int();
      const lines: LineTable["lines"] = [];
      for (let i = 0; i < n; i++) lines.push({ index: r.long(), line: r.int() });
      lines.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
      table = { start, end, lines };
    } catch (e) {
      if (!(e instanceof JdwpError)) throw e; // native/abstract methods or no line info
    }
    this.lineTables.set(key, table);
    return table;
  }
  async lineOf(loc: Location): Promise<number> {
    const t = await this.lineTable(loc.classId, loc.methodId);
    if (!t) return 0;
    let line = 0;
    for (const l of t.lines) {
      if (l.index <= loc.index) line = l.line;
      else break;
    }
    return line;
  }
  /** Local variables (needs classes compiled with -g); null when absent. */
  async variableTable(classId: bigint, methodId: bigint): Promise<VariableTable | null> {
    const key = `${classId}:${methodId}`;
    if (this.varTables.has(key)) return this.varTables.get(key)!;
    let table: VariableTable | null = null;
    try {
      const r = await this.cmd(6, 2, "Method.VariableTable", (w) => w.refTypeId(classId).methodId(methodId));
      const argCount = r.int();
      const n = r.int();
      const vars: LocalVariable[] = [];
      for (let i = 0; i < n; i++) vars.push({ codeIndex: r.long(), name: r.string(), signature: r.string(), length: r.int(), slot: r.int() });
      table = { argCount, vars };
    } catch (e) {
      if (!(e instanceof JdwpError)) throw e;
    }
    this.varTables.set(key, table);
    return table;
  }

  // ── ObjectReference (9) ──
  async objectType(obj: bigint): Promise<{ tag: number; id: bigint }> {
    const cached = this.objectTypes.get(obj);
    if (cached) return cached;
    const r = await this.cmd(9, 1, "ObjectReference.ReferenceType", (w) => w.objectId(obj));
    const t = { tag: r.ubyte(), id: r.refTypeId() };
    this.objectTypes.set(obj, t);
    return t;
  }
  async objectValues(obj: bigint, fieldIds: bigint[]): Promise<Value[]> {
    if (!fieldIds.length) return [];
    const r = await this.cmd(9, 2, "ObjectReference.GetValues", (w) => {
      w.objectId(obj).int(fieldIds.length);
      for (const f of fieldIds) w.fieldId(f);
    });
    const n = r.int();
    const out: Value[] = [];
    for (let i = 0; i < n; i++) out.push(r.tagged());
    return out;
  }
  async setObjectValue(obj: bigint, field: bigint, value: Value) {
    await this.cmd(9, 3, "ObjectReference.SetValues", (w) => w.objectId(obj).int(1).fieldId(field).untagged(value));
  }
  async invokeMethod(obj: bigint, thread: bigint, classId: bigint, methodId: bigint, args: Value[], options = 1): Promise<{ value: Value; exception: Value }> {
    const r = await this.cmd(9, 6, "ObjectReference.InvokeMethod", (w) => {
      w.objectId(obj).objectId(thread).refTypeId(classId).methodId(methodId).int(args.length);
      for (const a of args) w.tagged(a);
      w.int(options);
    });
    return { value: r.tagged(), exception: r.tagged() };
  }

  // ── StringReference (10) ──
  async stringValue(obj: bigint): Promise<string> {
    const r = await this.cmd(10, 1, "StringReference.Value", (w) => w.objectId(obj));
    return r.string();
  }

  // ── ThreadReference (11) ──
  async threadName(thread: bigint): Promise<string> {
    const r = await this.cmd(11, 1, "ThreadReference.Name", (w) => w.objectId(thread));
    return r.string();
  }
  async resumeThread(thread: bigint) {
    await this.cmd(11, 3, "ThreadReference.Resume", (w) => w.objectId(thread));
  }
  async frames(thread: bigint, start: number, length: number): Promise<Frame[]> {
    const r = await this.cmd(11, 6, "ThreadReference.Frames", (w) => w.objectId(thread).int(start).int(length));
    const n = r.int();
    const out: Frame[] = [];
    for (let i = 0; i < n; i++) out.push({ id: r.frameId(), location: r.location() });
    return out;
  }
  async frameCount(thread: bigint): Promise<number> {
    const r = await this.cmd(11, 7, "ThreadReference.FrameCount", (w) => w.objectId(thread));
    return r.int();
  }

  // ── ArrayReference (13) ──
  async arrayLength(arr: bigint): Promise<number> {
    const r = await this.cmd(13, 1, "ArrayReference.Length", (w) => w.objectId(arr));
    return r.int();
  }
  async arrayValues(arr: bigint, first: number, length: number): Promise<Value[]> {
    if (length <= 0) return [];
    const r = await this.cmd(13, 2, "ArrayReference.GetValues", (w) => w.objectId(arr).int(first).int(length));
    const tag = r.ubyte();
    const n = r.int();
    const out: Value[] = [];
    const primitive = tag !== 76 && tag !== 91 && tag !== 115 && tag !== 116 && tag !== 103 && tag !== 108 && tag !== 99;
    for (let i = 0; i < n; i++) out.push(primitive ? r.untagged(tag) : r.tagged());
    return out;
  }
  async setArrayValue(arr: bigint, index: number, value: Value) {
    await this.cmd(13, 3, "ArrayReference.SetValues", (w) => w.objectId(arr).int(index).int(1).untagged(value));
  }

  // ── EventRequest (15) ──
  async setRequest(kind: number, suspendPolicy: number, modifiers: Modifier[]): Promise<number> {
    const r = await this.cmd(15, 1, "EventRequest.Set", (w) => {
      w.byte(kind).byte(suspendPolicy).int(modifiers.length);
      for (const m of modifiers) {
        switch (m.kind) {
          case "count":
            w.byte(1).int(m.count);
            break;
          case "thread":
            w.byte(3).objectId(m.thread);
            break;
          case "classOnly":
            w.byte(4).refTypeId(m.refType);
            break;
          case "classMatch":
            w.byte(5).string(m.pattern);
            break;
          case "classExclude":
            w.byte(6).string(m.pattern);
            break;
          case "location":
            w.byte(7).location(m.location);
            break;
          case "exception":
            w.byte(8).refTypeId(m.refType).bool(m.caught).bool(m.uncaught);
            break;
          case "step":
            w.byte(10).objectId(m.thread).int(m.size).int(m.depth);
            break;
        }
      }
    });
    return r.int();
  }
  async clearRequest(kind: number, requestId: number) {
    await this.cmd(15, 2, "EventRequest.Clear", (w) => w.byte(kind).int(requestId));
  }

  // ── StackFrame (16) ──
  async frameValues(thread: bigint, frame: bigint, slots: { slot: number; tag: number }[]): Promise<Value[]> {
    if (!slots.length) return [];
    const r = await this.cmd(16, 1, "StackFrame.GetValues", (w) => {
      w.objectId(thread).frameId(frame).int(slots.length);
      for (const s of slots) w.int(s.slot).byte(s.tag);
    });
    const n = r.int();
    const out: Value[] = [];
    for (let i = 0; i < n; i++) out.push(r.tagged());
    return out;
  }
  async setFrameValue(thread: bigint, frame: bigint, slot: number, value: Value) {
    await this.cmd(16, 2, "StackFrame.SetValues", (w) => w.objectId(thread).frameId(frame).int(1).int(slot).tagged(value));
  }
  /** `this` in the frame, or 0n in static/native methods. */
  async thisObject(thread: bigint, frame: bigint): Promise<Value> {
    const r = await this.cmd(16, 3, "StackFrame.ThisObject", (w) => w.objectId(thread).frameId(frame));
    return r.tagged();
  }
}

/** Decodes one Event.Composite packet. */
export function parseEventSet(r: Reader): EventSet {
  const suspendPolicy = r.ubyte();
  const n = r.int();
  const events: JdwpEvent[] = [];
  for (let i = 0; i < n; i++) {
    const kind = r.ubyte();
    const requestId = r.int();
    switch (kind) {
      case EventKind.VM_START:
        events.push({ kind, requestId, thread: r.objectId() });
        break;
      case EventKind.VM_DEATH:
        events.push({ kind, requestId });
        break;
      case EventKind.SINGLE_STEP:
      case EventKind.BREAKPOINT:
        events.push({ kind, requestId, thread: r.objectId(), location: r.location() });
        break;
      case EventKind.EXCEPTION: {
        const thread = r.objectId();
        const location = r.location();
        const exception = r.tagged();
        const catchLocation = r.location();
        events.push({ kind, requestId, thread, location, exception, catchLocation: catchLocation.classId === 0n ? null : catchLocation });
        break;
      }
      case EventKind.THREAD_START:
      case EventKind.THREAD_DEATH:
        events.push({ kind, requestId, thread: r.objectId() });
        break;
      case EventKind.CLASS_PREPARE:
        events.push({ kind, requestId, thread: r.objectId(), refTag: r.ubyte(), typeId: r.refTypeId(), signature: r.string(), status: r.int() });
        break;
      case EventKind.CLASS_UNLOAD:
        events.push({ kind, requestId, signature: r.string() });
        break;
      default:
        // We never request other kinds; stop parsing (their layout differs).
        return { suspendPolicy, events };
    }
  }
  return { suspendPolicy, events };
}
