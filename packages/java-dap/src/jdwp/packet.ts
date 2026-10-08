// JDWP packet encoding: big-endian, IDs sized per VirtualMachine.IDSizes.
// https://docs.oracle.com/en/java/javase/21/docs/specs/jdwp/jdwp-spec.html

export interface IdSizes {
  field: number;
  method: number;
  object: number;
  refType: number;
  frame: number;
}

export const DEFAULT_ID_SIZES: IdSizes = { field: 8, method: 8, object: 8, refType: 8, frame: 8 };

/** A code location: type tag (1 class, 2 interface, 3 array), class, method, bytecode index. */
export interface Location {
  tag: number;
  classId: bigint;
  methodId: bigint;
  index: bigint;
}

/** A JDWP value. Object-like tags carry an object ID (bigint, 0n = null); `J` is a bigint too. */
export interface Value {
  tag: number;
  value: number | bigint | boolean;
}

export const Tag = {
  ARRAY: 91, // '['
  BYTE: 66, // 'B'
  CHAR: 67, // 'C'
  OBJECT: 76, // 'L'
  FLOAT: 70, // 'F'
  DOUBLE: 68, // 'D'
  INT: 73, // 'I'
  LONG: 74, // 'J'
  SHORT: 83, // 'S'
  VOID: 86, // 'V'
  BOOLEAN: 90, // 'Z'
  STRING: 115, // 's'
  THREAD: 116, // 't'
  THREAD_GROUP: 103, // 'g'
  CLASS_LOADER: 108, // 'l'
  CLASS_OBJECT: 99, // 'c'
} as const;

const PRIMITIVE_TAGS = new Set<number>([Tag.BYTE, Tag.CHAR, Tag.FLOAT, Tag.DOUBLE, Tag.INT, Tag.LONG, Tag.SHORT, Tag.BOOLEAN, Tag.VOID]);

export function isPrimitiveTag(tag: number): boolean {
  return PRIMITIVE_TAGS.has(tag);
}

/** The value tag for a JNI type signature ("I", "Ljava/lang/String;", "[I" ...). */
export function tagForSignature(sig: string): number {
  const c = sig.charCodeAt(0);
  if (sig === "Ljava/lang/String;") return Tag.STRING;
  return c;
}

export class Writer {
  private parts: Buffer[] = [];
  constructor(private sizes: IdSizes) {}

  byte(v: number) {
    const b = Buffer.alloc(1);
    b.writeInt8(v > 127 ? v - 256 : v);
    this.parts.push(b);
    return this;
  }
  bool(v: boolean) {
    return this.byte(v ? 1 : 0);
  }
  int(v: number) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v | 0);
    this.parts.push(b);
    return this;
  }
  long(v: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt.asIntN(64, v));
    this.parts.push(b);
    return this;
  }
  string(s: string) {
    const bytes = Buffer.from(s, "utf8");
    this.int(bytes.length);
    this.parts.push(bytes);
    return this;
  }
  id(size: number, v: bigint) {
    const b = Buffer.alloc(size);
    let x = BigInt.asUintN(size * 8, v);
    for (let i = size - 1; i >= 0; i--) {
      b[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    this.parts.push(b);
    return this;
  }
  objectId(v: bigint) {
    return this.id(this.sizes.object, v);
  }
  refTypeId(v: bigint) {
    return this.id(this.sizes.refType, v);
  }
  methodId(v: bigint) {
    return this.id(this.sizes.method, v);
  }
  fieldId(v: bigint) {
    return this.id(this.sizes.field, v);
  }
  frameId(v: bigint) {
    return this.id(this.sizes.frame, v);
  }
  location(loc: Location) {
    this.byte(loc.tag);
    this.refTypeId(loc.classId);
    this.methodId(loc.methodId);
    return this.long(loc.index);
  }
  /** A value without its tag (the receiver knows the type). */
  untagged(v: Value) {
    switch (v.tag) {
      case Tag.BYTE:
        return this.byte(Number(v.value));
      case Tag.BOOLEAN:
        return this.bool(Boolean(v.value));
      case Tag.CHAR:
      case Tag.SHORT: {
        const b = Buffer.alloc(2);
        b.writeUInt16BE(Number(v.value) & 0xffff);
        this.parts.push(b);
        return this;
      }
      case Tag.INT:
        return this.int(Number(v.value));
      case Tag.LONG:
        return this.long(BigInt(v.value as bigint | number));
      case Tag.FLOAT: {
        const b = Buffer.alloc(4);
        b.writeFloatBE(Number(v.value));
        this.parts.push(b);
        return this;
      }
      case Tag.DOUBLE: {
        const b = Buffer.alloc(8);
        b.writeDoubleBE(Number(v.value));
        this.parts.push(b);
        return this;
      }
      case Tag.VOID:
        return this;
      default:
        return this.objectId(BigInt(v.value as bigint));
    }
  }
  tagged(v: Value) {
    this.byte(v.tag);
    return this.untagged(v);
  }
  bytes(): Buffer {
    return Buffer.concat(this.parts);
  }
}

export class Reader {
  pos = 0;
  constructor(
    private buf: Buffer,
    private sizes: IdSizes,
  ) {}

  byte(): number {
    return this.buf.readInt8(this.pos++);
  }
  ubyte(): number {
    return this.buf.readUInt8(this.pos++);
  }
  bool(): boolean {
    return this.ubyte() !== 0;
  }
  short(): number {
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  char(): number {
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  int(): number {
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  long(): bigint {
    const v = this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return v;
  }
  float(): number {
    const v = this.buf.readFloatBE(this.pos);
    this.pos += 4;
    return v;
  }
  double(): number {
    const v = this.buf.readDoubleBE(this.pos);
    this.pos += 8;
    return v;
  }
  string(): string {
    const n = this.int();
    const s = this.buf.toString("utf8", this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  id(size: number): bigint {
    let v = 0n;
    for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(this.buf[this.pos + i]);
    this.pos += size;
    return v;
  }
  objectId() {
    return this.id(this.sizes.object);
  }
  refTypeId() {
    return this.id(this.sizes.refType);
  }
  methodId() {
    return this.id(this.sizes.method);
  }
  fieldId() {
    return this.id(this.sizes.field);
  }
  frameId() {
    return this.id(this.sizes.frame);
  }
  location(): Location {
    const tag = this.ubyte();
    const classId = this.refTypeId();
    const methodId = this.methodId();
    const index = this.long();
    return { tag, classId, methodId, index };
  }
  untagged(tag: number): Value {
    switch (tag) {
      case Tag.BYTE:
        return { tag, value: this.byte() };
      case Tag.BOOLEAN:
        return { tag, value: this.bool() };
      case Tag.CHAR:
        return { tag, value: this.char() };
      case Tag.SHORT:
        return { tag, value: this.short() };
      case Tag.INT:
        return { tag, value: this.int() };
      case Tag.LONG:
        return { tag, value: this.long() };
      case Tag.FLOAT:
        return { tag, value: this.float() };
      case Tag.DOUBLE:
        return { tag, value: this.double() };
      case Tag.VOID:
        return { tag, value: 0 };
      default:
        return { tag, value: this.objectId() };
    }
  }
  tagged(): Value {
    return this.untagged(this.ubyte());
  }
  get remaining() {
    return this.buf.length - this.pos;
  }
}
