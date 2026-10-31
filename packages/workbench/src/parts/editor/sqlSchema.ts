/**
 * A database schema read from SQL source, for the .sql Preview (SqlDiagram.tsx): CREATE TABLE / VIEW / INDEX, CREATE TYPE
 * ... AS ENUM, ALTER TABLE ... ADD / MODIFY / ALTER COLUMN and COMMENT ON, as mysqldump, phpMyAdmin, pg_dump and SQLite write
 * them. Everything else (INSERT and COPY data, SET, triggers, functions) is stepped over without being tokenised, so a dump
 * of tens of MB parses in a fraction of a second, in slices that keep the UI responsive (parseSqlSchemaAsync).
 */

export interface SqlColumn {
  name: string;
  /** As written: "varchar(150)", "bigint unsigned", "timestamp with time zone"; "" when the file gives none (SQLite, views). */
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
  default?: string;
  comment?: string;
  /** ENUM('a','b') / SET(…) members, or a PostgreSQL enum type's labels. */
  enumValues?: string[];
  check?: string;
  /** GENERATED ALWAYS AS (expr): the expression. */
  generated?: string;
  /** MySQL ON UPDATE CURRENT_TIMESTAMP. */
  onUpdate?: string;
}

export interface SqlIndex {
  name?: string;
  columns: string[];
  unique: boolean;
  kind: "primary" | "unique" | "index" | "fulltext" | "spatial";
  using?: string;
}

export interface SqlForeignKey {
  name?: string;
  columns: string[];
  refTable: string;
  refSchema?: string;
  /** Empty in the source means the referenced table's primary key, filled in when the target is known. */
  refColumns: string[];
  onDelete?: string;
  onUpdate?: string;
  /** The referenced table's id, when it is in the file. */
  target?: string;
}

export interface SqlTable {
  /** Lower-case "schema.name" (or "name"): unique in the file. */
  id: string;
  name: string;
  schema?: string;
  kind: "table" | "view";
  columns: SqlColumn[];
  primaryKey: string[];
  indexes: SqlIndex[];
  foreignKeys: SqlForeignKey[];
  checks: { name?: string; expr: string }[];
  comment?: string;
  /** ENGINE=InnoDB, WITHOUT ROWID… */
  options?: string;
  /** 1-based line of its CREATE. */
  line: number;
  /** A view: the ids of the tables and views it reads. */
  sources?: string[];
  /** A view: its SELECT, shortened. */
  definition?: string;
}

export interface SqlIssue {
  line: number;
  message: string;
  /** The start of the statement it is about. */
  text?: string;
}

export type SqlDialect = "mysql" | "postgres" | "sqlite" | "generic";

export interface SqlSchema {
  tables: SqlTable[];
  issues: SqlIssue[];
  dialect: SqlDialect;
  /** Statements in the file, and how many were data or other statements stepped over. */
  statements: number;
  skipped: number;
}

// ───────────────────────── statements ─────────────────────────

const SQ = 39, DQ = 34, BT = 96, DASH = 45, HASH = 35, SLASH = 47, STAR = 42, BSL = 92, DOLLAR = 36, NL = 10;

/** The likely dialect, from the first 256 KB: MySQL strings take backslash escapes, the others don't. */
export function guessDialect(text: string): SqlDialect {
  const head = text.slice(0, 256 * 1024);
  if (/MySQL dump|MariaDB dump|phpMyAdmin|\bENGINE\s*=|\bAUTO_INCREMENT\b|`/i.test(head)) return "mysql";
  if (/PostgreSQL database dump|pg_dump|\bSERIAL\b|\bBIGSERIAL\b|::[a-z]|\bnextval\(|\bOWNER TO\b|\bCREATE EXTENSION\b|\$\$/i.test(head)) return "postgres";
  if (/\bAUTOINCREMENT\b|WITHOUT ROWID|\bPRAGMA\b|sqlite_/i.test(head)) return "sqlite";
  return "generic";
}

/** The index just past a quoted run opening at `i` ('', "", ``), doubled quotes and (MySQL strings) backslash escapes allowed. */
function skipQuoted(s: string, i: number, q: number, backslash: boolean): number {
  const ch = String.fromCharCode(q);
  let j = i + 1;
  for (;;) {
    const k = s.indexOf(ch, j);
    if (k < 0) return s.length;
    if (backslash) {
      let b = 0;
      for (let m = k - 1; m > i && s.charCodeAt(m) === BSL; m--) b++;
      if (b & 1) {
        j = k + 1;
        continue;
      }
    }
    if (s.charCodeAt(k + 1) === q) {
      j = k + 2;
      continue;
    }
    return k + 1;
  }
}

const isWordCode = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === DOLLAR || c > 127;

/** A PostgreSQL dollar quote ($$ or $tag$) opening at `i`: the index past its close, or -1 when it isn't one. */
function skipDollar(s: string, i: number): number {
  if (i > 0 && isWordCode(s.charCodeAt(i - 1))) return -1;
  let j = i + 1;
  while (j < s.length && isWordCode(s.charCodeAt(j)) && s.charCodeAt(j) !== DOLLAR) j++;
  if (s.charCodeAt(j) !== DOLLAR) return -1;
  const c1 = s.charCodeAt(i + 1);
  if (j > i + 1 && c1 >= 48 && c1 <= 57) return -1; // $1 is a parameter
  const tag = s.slice(i, j + 1);
  const end = s.indexOf(tag, j + 1);
  return end < 0 ? s.length : end + tag.length;
}

/** MySQL's executable comments, /*!50001 … *\/ and MariaDB's /*M!100100 … *\/: their content is SQL. */
function conditionalAt(s: string, i: number): number {
  if (s.charCodeAt(i + 2) === 33) return i + 3;
  if (s.charCodeAt(i + 2) === 77 && s.charCodeAt(i + 3) === 33) return i + 4;
  return -1;
}

/** Where the statement starting at `i` ends: the delimiter's index (outside quotes and comments), or the end of the text. */
function statementEnd(s: string, i: number, delim: string, mysql: boolean): number {
  const n = s.length;
  const d0 = delim.charCodeAt(0);
  const single = delim.length === 1;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === d0 && (single || s.startsWith(delim, i))) return i;
    if (c === SQ || c === DQ) i = skipQuoted(s, i, c, mysql);
    else if (c === BT) i = skipQuoted(s, i, c, false);
    else if (c === DASH && s.charCodeAt(i + 1) === DASH) i = lineEnd(s, i);
    else if (c === HASH && mysql) i = lineEnd(s, i);
    else if (c === SLASH && s.charCodeAt(i + 1) === STAR) {
      const k = conditionalAt(s, i);
      if (k > 0) i = k;
      else {
        const e = s.indexOf("*/", i + 2);
        i = e < 0 ? n : e + 2;
      }
    } else if (c === DOLLAR && !mysql) {
      const e = skipDollar(s, i);
      i = e < 0 ? i + 1 : e;
    } else i++;
  }
  return n;
}

function lineEnd(s: string, i: number): number {
  const e = s.indexOf("\n", i);
  return e < 0 ? s.length : e;
}

/** Past whitespace and plain comments (an executable /*! comment is SQL, so it stops there). */
function skipBlank(s: string, i: number, mysql: boolean): number {
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === NL || c === 13 || c === 12 || c === 0xfeff) i++;
    else if (c === DASH && s.charCodeAt(i + 1) === DASH) i = lineEnd(s, i);
    else if (c === HASH && mysql) i = lineEnd(s, i);
    else if (c === SLASH && s.charCodeAt(i + 1) === STAR && conditionalAt(s, i) < 0) {
      const e = s.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
    } else break;
  }
  return i;
}

const INTERESTING = /^(?:\/\*M?!\d*\s*)?(CREATE|ALTER|COMMENT)\b/i;
const COPY_STDIN = /^COPY\b[^;]*\bFROM\s+stdin/i;

// ───────────────────────── tokens ─────────────────────────

/** w: word, q: quoted identifier, s: string, n: number, p: punctuation. */
interface Tok {
  t: "w" | "q" | "s" | "n" | "p";
  /** Identifier / string value, unquoted; punctuation itself. */
  v: string;
  /** Words upper-cased (for keywords), "" otherwise. */
  u: string;
  /** As written. */
  raw: string;
}

function tokenize(s: string, mysql: boolean): Tok[] {
  const out: Tok[] = [];
  const n = s.length;
  let i = 0;
  let cond = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c <= 32 || c === 0xfeff) {
      i++;
      continue;
    }
    if (c === DASH && s.charCodeAt(i + 1) === DASH) {
      i = lineEnd(s, i);
      continue;
    }
    if (c === HASH && mysql) {
      i = lineEnd(s, i);
      continue;
    }
    if (c === SLASH && s.charCodeAt(i + 1) === STAR) {
      const k = conditionalAt(s, i);
      if (k > 0) {
        i = k;
        while (i < n && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) i++;
        cond++;
      } else {
        const e = s.indexOf("*/", i + 2);
        i = e < 0 ? n : e + 2;
      }
      continue;
    }
    if (c === STAR && cond > 0 && s.charCodeAt(i + 1) === SLASH) {
      cond--;
      i += 2;
      continue;
    }
    const start = i;
    if (c === SQ) {
      const prev = out[out.length - 1];
      const escaped = mysql || (!!prev && prev.t === "w" && prev.u === "E" && start > 0 && s.charCodeAt(start - 1) !== 32);
      i = skipQuoted(s, i, c, escaped);
      const raw = s.slice(start, i);
      out.push({ t: "s", v: unquoteString(raw, escaped), u: "", raw });
      continue;
    }
    if (c === DQ) {
      i = skipQuoted(s, i, c, mysql);
      const raw = s.slice(start, i);
      out.push(mysql ? { t: "s", v: unquoteString(raw, true), u: "", raw } : { t: "q", v: raw.slice(1, -1).replace(/""/g, '"'), u: "", raw });
      continue;
    }
    if (c === BT) {
      i = skipQuoted(s, i, c, false);
      const raw = s.slice(start, i);
      out.push({ t: "q", v: raw.slice(1, -1).replace(/``/g, "`"), u: "", raw });
      continue;
    }
    if (c === 91 && !mysql) {
      // [Name] (SQL Server, SQLite); int[] / int[3] stay punctuation.
      const m = /^\[([A-Za-z_][^\]\n]*)\]/.exec(s.slice(i, i + 256));
      if (m) {
        i += m[0].length;
        out.push({ t: "q", v: m[1], u: "", raw: m[0] });
        continue;
      }
    }
    if (c === DOLLAR && !mysql) {
      const e = skipDollar(s, i);
      if (e > 0) {
        i = e;
        const raw = s.slice(start, i);
        const tag = raw.slice(0, raw.indexOf("$", 1) + 1);
        out.push({ t: "s", v: raw.slice(tag.length, raw.length - tag.length), u: "", raw });
        continue;
      }
    }
    if ((c >= 48 && c <= 57) || (c === 46 && s.charCodeAt(i + 1) >= 48 && s.charCodeAt(i + 1) <= 57)) {
      const m = /^(?:0x[0-9a-f]+|\d*\.?\d+(?:e[+-]?\d+)?)/i.exec(s.slice(i, i + 64))!;
      i += m[0].length;
      // 1abc is a word in MySQL (identifiers may start with digits).
      if (i < n && isWordCode(s.charCodeAt(i)) && s.charCodeAt(i) !== DOLLAR) {
        while (i < n && isWordCode(s.charCodeAt(i))) i++;
        const raw = s.slice(start, i);
        out.push({ t: "w", v: raw, u: raw.toUpperCase(), raw });
      } else out.push({ t: "n", v: m[0], u: "", raw: m[0] });
      continue;
    }
    if (isWordCode(c)) {
      while (i < n && isWordCode(s.charCodeAt(i))) i++;
      const raw = s.slice(start, i);
      out.push({ t: "w", v: raw, u: raw.toUpperCase(), raw });
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === "::" || two === "<=" || two === ">=" || two === "<>" || two === "!=" || two === "||" || two === "->") {
      i += 2;
      out.push({ t: "p", v: two, u: "", raw: two });
      continue;
    }
    i++;
    out.push({ t: "p", v: s[start], u: "", raw: s[start] });
  }
  return out;
}

function unquoteString(raw: string, escaped: boolean): string {
  let v = raw.slice(1, raw.endsWith(raw[0]) && raw.length > 1 ? -1 : undefined);
  v = v.split(raw[0] + raw[0]).join(raw[0]);
  if (!escaped) return v;
  return v.replace(/\\(.)/g, (_, ch: string) => ({ n: "\n", t: "\t", r: "\r", "0": "\0", Z: "\x1a" })[ch] ?? ch);
}

/** Tokens back to readable SQL: "DEFAULT nextval('a_id_seq'::regclass)", "CHECK (price > 0)". */
export function tokensText(toks: Tok[]): string {
  let out = "";
  let prev: Tok | null = null;
  for (const t of toks) {
    const glue =
      !prev ||
      prev.v === "(" ||
      prev.v === "." ||
      prev.v === "::" ||
      prev.v === "[" ||
      prev.v === "@" ||
      t.v === ")" ||
      t.v === "," ||
      t.v === "." ||
      t.v === "::" ||
      t.v === "[" ||
      t.v === "]" ||
      t.v === "@" ||
      (t.v === "(" && prev.t === "w" && !KEYWORD_BEFORE_PAREN.has(prev.u));
    if (prev && !glue) out += " ";
    out += t.t === "p" ? t.v : t.raw;
    prev = t;
  }
  return out;
}

const KEYWORD_BEFORE_PAREN = new Set(["KEY", "UNIQUE", "INDEX", "USING", "VALUES", "AND", "OR", "NOT", "IN", "AS", "CHECK", "ON", "WHERE", "THEN", "ELSE", "WHEN", "IS", "SELECT", "FROM", "JOIN", "EXISTS"]);

// ───────────────────────── cursor ─────────────────────────

class Cursor {
  i = 0;
  constructor(readonly t: Tok[]) {}
  get done() {
    return this.i >= this.t.length;
  }
  peek(k = 0): Tok | undefined {
    return this.t[this.i + k];
  }
  /** The upper-cased keyword k tokens ahead ("" if not a word). */
  kw(k = 0): string {
    return this.t[this.i + k]?.u ?? "";
  }
  next(): Tok | undefined {
    return this.t[this.i++];
  }
  /** Consumes the keywords in order when they are all next. */
  accept(...words: string[]): boolean {
    for (let k = 0; k < words.length; k++) if (this.kw(k) !== words[k]) return false;
    this.i += words.length;
    return true;
  }
  punct(p: string): boolean {
    if (this.t[this.i]?.t === "p" && this.t[this.i].v === p) {
      this.i++;
      return true;
    }
    return false;
  }
  isPunct(p: string, k = 0): boolean {
    const t = this.t[this.i + k];
    return !!t && t.t === "p" && t.v === p;
  }
  /** The tokens inside the parenthesis opening here (consumed with it), or null when there is none. */
  group(): Tok[] | null {
    if (!this.isPunct("(")) return null;
    let depth = 0;
    const start = this.i;
    for (; this.i < this.t.length; this.i++) {
      const t = this.t[this.i];
      if (t.t !== "p") continue;
      if (t.v === "(") depth++;
      else if (t.v === ")" && --depth === 0) {
        this.i++;
        return this.t.slice(start + 1, this.i - 1);
      }
    }
    return this.t.slice(start + 1);
  }
  /** A possibly qualified name: [schema.]name (the last two parts of a.b.c). */
  name(): { name: string; schema?: string } | null {
    const parts: string[] = [];
    for (;;) {
      const t = this.peek();
      if (!t || (t.t !== "w" && t.t !== "q" && t.t !== "s")) break;
      parts.push(t.v);
      this.i++;
      if (!this.isPunct(".")) break;
      this.i++;
    }
    if (!parts.length) return null;
    return { name: parts[parts.length - 1], schema: parts.length > 1 ? parts[parts.length - 2] : undefined };
  }
}

/** Items of a list at depth 0: the columns of CREATE TABLE ( … ), the actions of ALTER TABLE. */
function splitTop(toks: Tok[], sep = ","): Tok[][] {
  const items: Tok[][] = [];
  let cur: Tok[] = [];
  let depth = 0;
  for (const t of toks) {
    if (t.t === "p") {
      if (t.v === "(") depth++;
      else if (t.v === ")") depth--;
      else if (t.v === sep && depth === 0) {
        items.push(cur);
        cur = [];
        continue;
      }
    }
    cur.push(t);
  }
  if (cur.length) items.push(cur);
  return items;
}

/** Index / key columns: `name`, `name`(10), name DESC, lower(name) → "name", "name", "name", "lower(name)". */
function indexColumns(toks: Tok[]): string[] {
  return splitTop(toks)
    .map((item) => {
      const first = item[0];
      if (!first) return "";
      if ((first.t === "w" || first.t === "q") && !(item[1] && item[1].t === "p" && item[1].v === "(" && first.t === "w" && item.length > 1 && !/^\d+$/.test(item[2]?.v ?? ""))) return first.v;
      return tokensText(item.filter((t) => t.u !== "ASC" && t.u !== "DESC"));
    })
    .filter(Boolean);
}

// ───────────────────────── the parser ─────────────────────────

const COLUMN_STOP = new Set([
  "NOT", "NULL", "DEFAULT", "PRIMARY", "UNIQUE", "KEY", "REFERENCES", "CHECK", "CONSTRAINT", "AUTO_INCREMENT", "AUTOINCREMENT", "COMMENT", "COLLATE",
  "CHARSET", "GENERATED", "AS", "ON", "IDENTITY", "STORED", "VIRTUAL", "PERSISTENT", "INVISIBLE", "VISIBLE", "SRID", "COLUMN_FORMAT", "STORAGE",
  "ENGINE_ATTRIBUTE", "SECONDARY_ENGINE_ATTRIBUTE", "COMPRESSION", "ENCODE", "FIRST", "AFTER", "SERIAL", "FOREIGN",
]);
/** Words that can follow DEFAULT's value (a value runs until one of these). */
const DEFAULT_STOP = new Set([
  "NOT", "NULL", "PRIMARY", "UNIQUE", "KEY", "REFERENCES", "CHECK", "CONSTRAINT", "AUTO_INCREMENT", "AUTOINCREMENT", "COMMENT", "COLLATE", "CHARSET",
  "CHARACTER", "GENERATED", "ON", "IDENTITY", "INVISIBLE", "VISIBLE", "FIRST", "AFTER", "COLUMN_FORMAT", "STORAGE",
]);
/** PostgreSQL's auto-numbered types. */
const SERIAL_TYPES: Record<string, true> = { SERIAL: true, BIGSERIAL: true, SMALLSERIAL: true, SERIAL4: true, SERIAL8: true, SERIAL2: true };

interface Ctx {
  mysql: boolean;
  tables: Map<string, SqlTable>;
  enums: Map<string, string[]>;
  issues: SqlIssue[];
  line: number;
  head: string;
}

const tableId = (name: string, schema?: string) => (schema ? `${schema}.${name}` : name).toLowerCase();

function lookupTable(ctx: Ctx, name: string, schema?: string): SqlTable | undefined {
  const exact = ctx.tables.get(tableId(name, schema));
  if (exact) return exact;
  const lower = name.toLowerCase();
  for (const t of ctx.tables.values()) if (t.name.toLowerCase() === lower && (!schema || !t.schema || DEFAULT_SCHEMAS.has(schema.toLowerCase()))) return t;
  return undefined;
}

const DEFAULT_SCHEMAS = new Set(["public", "main", "dbo"]);

function statement(ctx: Ctx, toks: Tok[]) {
  const c = new Cursor(toks);
  const first = c.kw();
  if (first === "CREATE") create(ctx, c);
  else if (first === "ALTER") alter(ctx, c);
  else if (first === "COMMENT") commentOn(ctx, c);
}

function create(ctx: Ctx, c: Cursor) {
  c.next();
  // CREATE [OR REPLACE] [TEMPORARY] [ALGORITHM=…] [DEFINER=…] [SQL SECURITY …] TABLE | VIEW | [UNIQUE] INDEX | TYPE
  for (let guard = 0; guard < 24 && !c.done; guard++) {
    const k = c.kw();
    if (k === "TABLE") {
      c.next();
      return createTable(ctx, c);
    }
    if (k === "VIEW") {
      c.next();
      return createView(ctx, c);
    }
    if (k === "INDEX" || ((k === "UNIQUE" || k === "FULLTEXT" || k === "SPATIAL" || k === "BITMAP") && (c.kw(1) === "INDEX" || c.kw(2) === "INDEX"))) return createIndex(ctx, c);
    if (k === "TYPE") {
      c.next();
      return createType(ctx, c);
    }
    if (/^(TRIGGER|FUNCTION|PROCEDURE|SEQUENCE|SCHEMA|DATABASE|EXTENSION|EVENT|DOMAIN|ROLE|USER|RULE|POLICY|AGGREGATE|OPERATOR|CAST|COLLATION|SERVER|PUBLICATION|SUBSCRIPTION|STATISTICS|TABLESPACE|LANGUAGE)$/.test(k)) return;
    c.next();
  }
}

function newTable(ctx: Ctx, n: { name: string; schema?: string }, kind: "table" | "view"): SqlTable {
  const t: SqlTable = { id: tableId(n.name, n.schema), name: n.name, schema: n.schema, kind, columns: [], primaryKey: [], indexes: [], foreignKeys: [], checks: [], line: ctx.line };
  // A later CREATE of the same name replaces the first (DROP + CREATE scripts, mysqldump's placeholder views).
  ctx.tables.delete(t.id);
  ctx.tables.set(t.id, t);
  return t;
}

function createTable(ctx: Ctx, c: Cursor) {
  c.accept("IF", "NOT", "EXISTS");
  const n = c.name();
  if (!n) throw new Error("no table name");
  if (c.kw() === "PARTITION" && c.kw(1) === "OF") return;
  if (c.kw() === "OF") return;
  const t = newTable(ctx, n, "table");
  if (c.accept("LIKE") || (c.isPunct("(") && c.kw(1) === "LIKE")) {
    const like = c.isPunct("(") ? (c.next(), c.next(), c.name()) : c.name();
    const src = like && lookupTable(ctx, like.name, like.schema);
    if (src) Object.assign(t, { columns: src.columns.map((x) => ({ ...x })), primaryKey: [...src.primaryKey], indexes: src.indexes.map((x) => ({ ...x })) });
    return;
  }
  const body = c.group();
  if (!body) {
    if (c.kw() === "AS" || c.kw() === "SELECT") ctx.issues.push({ line: ctx.line, message: `${t.name}: made from a query (CREATE TABLE … AS), so its columns aren't known.`, text: ctx.head });
    else throw new Error("no column list");
    return;
  }
  for (const item of splitTop(body)) {
    if (!item.length) continue;
    try {
      tableItem(ctx, t, item);
    } catch (e) {
      ctx.issues.push({ line: ctx.line, message: `${t.name}: skipped "${tokensText(item).slice(0, 80)}" (${(e as Error).message})`, text: ctx.head });
    }
  }
  tableOptions(t, c);
}

function tableOptions(t: SqlTable, c: Cursor) {
  const opts: string[] = [];
  while (!c.done) {
    const k = c.kw();
    if (k === "COMMENT") {
      c.next();
      c.punct("=");
      const v = c.next();
      if (v?.t === "s") t.comment = v.v;
    } else if (k === "ENGINE" || k === "TYPE") {
      c.next();
      c.punct("=");
      const v = c.next();
      if (v) opts.push(`ENGINE=${v.v}`);
    } else if (k === "WITHOUT" && c.kw(1) === "ROWID") {
      c.i += 2;
      opts.push("WITHOUT ROWID");
    } else if (k === "STRICT") {
      c.next();
      opts.push("STRICT");
    } else if (k === "INHERITS") {
      c.next();
      const g = c.group();
      if (g) opts.push(`INHERITS (${tokensText(g)})`);
    } else if (k === "PARTITION") break;
    else c.next();
  }
  if (opts.length) t.options = opts.join(" ");
}

/** A line inside CREATE TABLE ( … ) or after ALTER TABLE … ADD: a constraint, a key, or a column. */
function tableItem(ctx: Ctx, t: SqlTable, item: Tok[]) {
  const c = new Cursor(item);
  let name: string | undefined;
  if (c.kw() === "CONSTRAINT") {
    c.next();
    if (!/^(PRIMARY|UNIQUE|FOREIGN|CHECK|EXCLUDE)$/.test(c.kw())) name = c.next()?.v;
  }
  const k = item[c.i]?.t === "w" ? c.kw() : "";
  if (k === "PRIMARY" && c.kw(1) === "KEY") {
    c.i += 2;
    const cols = keyColumns(c);
    setPrimaryKey(t, cols, name);
    return;
  }
  if (k === "UNIQUE") {
    c.next();
    if (c.kw() === "KEY" || c.kw() === "INDEX") c.next();
    const idx = keyName(c) ?? name;
    t.indexes.push({ name: idx, columns: keyColumns(c), unique: true, kind: "unique" });
    return;
  }
  if (k === "FOREIGN" && c.kw(1) === "KEY") {
    c.i += 2;
    const idx = keyName(c);
    const cols = indexColumns(c.group() ?? []);
    if (!c.accept("REFERENCES")) throw new Error("FOREIGN KEY without REFERENCES");
    t.foreignKeys.push(references(c, cols, name ?? idx));
    return;
  }
  if (k === "CHECK") {
    c.next();
    t.checks.push({ name, expr: tokensText(c.group() ?? []) });
    return;
  }
  if (k === "EXCLUDE" || k === "PERIOD" || k === "LIKE") return;
  if ((k === "KEY" || k === "INDEX" || k === "FULLTEXT" || k === "SPATIAL") && looksLikeKey(item, c.i)) {
    c.next();
    if (k === "FULLTEXT" || k === "SPATIAL") if (c.kw() === "KEY" || c.kw() === "INDEX") c.next();
    const idx = keyName(c);
    const using = c.accept("USING") ? c.next()?.v : undefined;
    t.indexes.push({ name: idx, columns: keyColumns(c), unique: false, kind: k === "FULLTEXT" ? "fulltext" : k === "SPATIAL" ? "spatial" : "index", using });
    return;
  }
  column(ctx, t, c, name);
}

/** KEY / INDEX opening an index (KEY idx (a), INDEX (a)) rather than a column named key. */
function looksLikeKey(item: Tok[], i: number): boolean {
  const a = item[i + 1];
  if (!a) return false;
  if (a.t === "p" && a.v === "(") return true;
  if (a.u === "KEY" || a.u === "INDEX" || a.u === "USING") return true;
  const b = item[i + 2];
  if (!(b && b.t === "p" && b.v === "(")) return false;
  // KEY idx (a, b) vs key varchar(10): an index lists names, a type numbers.
  const inner = item[i + 3];
  return !!inner && inner.t !== "n";
}

function keyName(c: Cursor): string | undefined {
  const t = c.peek();
  if (t && (t.t === "w" || t.t === "q") && t.u !== "USING" && !c.isPunct("(", 0)) {
    c.next();
    return t.v;
  }
  return undefined;
}

function keyColumns(c: Cursor): string[] {
  // USING BTREE, CLUSTERED…
  while (!c.done && !c.isPunct("(")) c.next();
  return indexColumns(c.group() ?? []);
}

function setPrimaryKey(t: SqlTable, cols: string[], name?: string) {
  t.primaryKey = cols;
  t.indexes = t.indexes.filter((x) => x.kind !== "primary");
  t.indexes.unshift({ name, columns: cols, unique: true, kind: "primary" });
  for (const col of t.columns) if (cols.some((x) => x.toLowerCase() === col.name.toLowerCase())) Object.assign(col, { primaryKey: true, nullable: false });
}

/** REFERENCES t [(cols)] [MATCH …] [ON DELETE …] [ON UPDATE …] [DEFERRABLE …]. */
function references(c: Cursor, columns: string[], name?: string): SqlForeignKey {
  const target = c.name();
  if (!target) throw new Error("REFERENCES without a table");
  const fk: SqlForeignKey = { name, columns, refTable: target.name, refSchema: target.schema, refColumns: c.isPunct("(") ? indexColumns(c.group()!) : [] };
  while (!c.done) {
    if (c.accept("ON", "DELETE")) fk.onDelete = rule(c);
    else if (c.accept("ON", "UPDATE")) fk.onUpdate = rule(c);
    else if (c.accept("MATCH")) c.next();
    else if (c.kw() === "DEFERRABLE" || c.kw() === "NOT" || c.kw() === "INITIALLY") {
      if (c.kw() === "NOT" && c.kw(1) !== "DEFERRABLE") break;
      c.next();
      if (c.kw() === "DEFERRED" || c.kw() === "IMMEDIATE") c.next();
    } else break;
  }
  return fk;
}

function rule(c: Cursor): string {
  if (c.accept("SET", "NULL")) return "SET NULL";
  if (c.accept("SET", "DEFAULT")) return "SET DEFAULT";
  if (c.accept("NO", "ACTION")) return "NO ACTION";
  return c.next()?.u ?? "";
}

/** A column definition: name, type, then constraints in any order. */
function column(ctx: Ctx, t: SqlTable, c: Cursor, constraintName?: string): SqlColumn {
  const nameTok = c.next();
  if (!nameTok || (nameTok.t !== "w" && nameTok.t !== "q" && nameTok.t !== "s")) throw new Error("not a column");
  const col: SqlColumn = { name: nameTok.v, type: "", nullable: true, primaryKey: false, unique: false, autoIncrement: false };
  col.type = columnType(ctx, c, col);
  columnConstraints(t, c, col, constraintName);
  const existing = t.columns.findIndex((x) => x.name.toLowerCase() === col.name.toLowerCase());
  if (existing >= 0) t.columns[existing] = col;
  else t.columns.push(col);
  if (t.primaryKey.some((x) => x.toLowerCase() === col.name.toLowerCase())) Object.assign(col, { primaryKey: true, nullable: false });
  return col;
}

function columnType(ctx: Ctx, c: Cursor, col: SqlColumn): string {
  let type = "";
  for (;;) {
    const tk = c.peek();
    if (!tk) break;
    if (tk.t === "w") {
      if (COLUMN_STOP.has(tk.u) && !(tk.u === "SERIAL" && !type)) break;
      if (tk.u === "CHARACTER" && c.kw(1) === "SET") break;
      c.next();
      type += (type && !type.endsWith(".") ? " " : "") + tk.v;
      continue;
    }
    if (tk.t === "q" && !type) {
      // A quoted type name (pg_dump: public."Status").
      c.next();
      type = tk.v;
      continue;
    }
    if (tk.t === "p" && tk.v === "." && type) {
      c.next();
      type += ".";
      continue;
    }
    if (tk.t === "q" && type.endsWith(".")) {
      c.next();
      type += tk.v;
      continue;
    }
    if (tk.t === "p" && tk.v === "(" && type) {
      const g = c.group()!;
      if (/^(ENUM|SET)$/i.test(type.trim().split(/\s+/).pop()!)) col.enumValues = g.filter((x) => x.t === "s").map((x) => x.v);
      type += `(${splitTop(g).map(tokensText).join(",")})`;
      continue;
    }
    if (tk.t === "p" && tk.v === "[" && type) {
      c.next();
      let dims = "[";
      while (!c.done && !c.isPunct("]")) dims += c.next()!.v;
      c.punct("]");
      type += `${dims}]`;
      continue;
    }
    break;
  }
  const base = type.split(/[\s(]/)[0].toUpperCase();
  if (SERIAL_TYPES[base]) {
    col.autoIncrement = true;
    col.nullable = false;
  }
  if (!col.enumValues) {
    const e = ctx.enums.get(type.toLowerCase()) ?? ctx.enums.get(type.split(".").pop()!.toLowerCase());
    if (e) col.enumValues = e;
  }
  return type;
}

function columnConstraints(t: SqlTable, c: Cursor, col: SqlColumn, constraintName?: string) {
  let cname = constraintName;
  while (!c.done) {
    const tk = c.peek()!;
    const k = tk.t === "w" ? tk.u : "";
    if (k === "CONSTRAINT") {
      c.next();
      cname = c.next()?.v;
    } else if (c.accept("NOT", "NULL")) col.nullable = false;
    else if (k === "NULL") {
      c.next();
      col.nullable = true;
    } else if (k === "DEFAULT") {
      c.next();
      const v = valueTokens(c, DEFAULT_STOP);
      col.default = tokensText(v);
      if (/^nextval\s*\(/i.test(col.default)) col.autoIncrement = true;
    } else if (c.accept("PRIMARY", "KEY") || (k === "KEY" && (c.next(), true))) {
      col.primaryKey = true;
      col.nullable = false;
      if (c.kw() === "ASC" || c.kw() === "DESC") c.next();
      setPrimaryKey(t, [col.name], cname);
      cname = undefined;
    } else if (k === "UNIQUE") {
      c.next();
      if (c.kw() === "KEY" || c.kw() === "INDEX") c.next();
      col.unique = true;
      cname = undefined;
    } else if (k === "REFERENCES") {
      c.next();
      t.foreignKeys.push(references(c, [col.name], cname));
      cname = undefined;
    } else if (k === "CHECK") {
      c.next();
      const expr = tokensText(c.group() ?? []);
      col.check = col.check ? `${col.check} AND ${expr}` : expr;
      cname = undefined;
    } else if (k === "AUTO_INCREMENT" || k === "AUTOINCREMENT") {
      c.next();
      col.autoIncrement = true;
    } else if (k === "IDENTITY") {
      c.next();
      c.group();
      col.autoIncrement = true;
    } else if (k === "GENERATED" || k === "AS") {
      c.next();
      if (k === "GENERATED") {
        if (!c.accept("ALWAYS")) c.accept("BY", "DEFAULT");
        c.accept("ON", "NULL");
        c.accept("AS");
      }
      if (c.accept("IDENTITY")) {
        c.group();
        col.autoIncrement = true;
      } else {
        const g = c.group();
        if (g) col.generated = tokensText(g);
      }
    } else if (k === "COMMENT") {
      c.next();
      const v = c.next();
      if (v?.t === "s") col.comment = v.v;
    } else if (c.accept("ON", "UPDATE")) {
      col.onUpdate = tokensText(valueTokens(c, DEFAULT_STOP));
    } else if (k === "COLLATE" || k === "CHARSET" || k === "SRID" || k === "COLUMN_FORMAT" || k === "STORAGE" || k === "COMPRESSION" || k === "ENCODE") {
      c.next();
      c.punct("=");
      c.next();
    } else if (c.accept("CHARACTER", "SET")) c.next();
    else if (c.accept("ON", "CONFLICT")) c.next();
    else c.next();
  }
}

/** A value (DEFAULT …, ON UPDATE …): at least one token, then up to the next constraint word. */
function valueTokens(c: Cursor, stop: Set<string>): Tok[] {
  const out: Tok[] = [];
  while (!c.done) {
    const tk = c.peek()!;
    if (out.length && tk.t === "w" && stop.has(tk.u) && !(tk.u === "NULL" && out[out.length - 1].u === "IS")) break;
    if (tk.t === "p" && tk.v === "(") {
      const g = c.group()!;
      out.push(tk, ...g, { t: "p", v: ")", u: "", raw: ")" });
      continue;
    }
    out.push(c.next()!);
  }
  return out;
}

function createIndex(ctx: Ctx, c: Cursor) {
  let kind: SqlIndex["kind"] = "index";
  while (c.kw() !== "INDEX" && !c.done) {
    const k = c.next()!.u;
    if (k === "UNIQUE") kind = "unique";
    else if (k === "FULLTEXT") kind = "fulltext";
    else if (k === "SPATIAL") kind = "spatial";
  }
  c.next();
  c.accept("CONCURRENTLY");
  c.accept("IF", "NOT", "EXISTS");
  const name = c.kw() === "ON" ? undefined : c.name()?.name;
  if (!c.accept("ON")) throw new Error("CREATE INDEX without ON");
  c.accept("ONLY");
  const tn = c.name();
  if (!tn) throw new Error("CREATE INDEX without a table");
  const using = c.accept("USING") ? c.next()?.v : undefined;
  const cols = indexColumns(c.group() ?? []);
  const t = lookupTable(ctx, tn.name, tn.schema);
  if (!t) {
    ctx.issues.push({ line: ctx.line, message: `Index ${name ?? ""} is on ${tn.name}, which isn't created in this file.`.replace("  ", " "), text: ctx.head });
    return;
  }
  t.indexes.push({ name, columns: cols, unique: kind === "unique", kind, using });
}

function createType(ctx: Ctx, c: Cursor) {
  const n = c.name();
  if (!n || !c.accept("AS", "ENUM")) return;
  const labels = (c.group() ?? []).filter((x) => x.t === "s").map((x) => x.v);
  ctx.enums.set(n.name.toLowerCase(), labels);
  if (n.schema) ctx.enums.set(`${n.schema}.${n.name}`.toLowerCase(), labels);
}

function createView(ctx: Ctx, c: Cursor) {
  c.accept("IF", "NOT", "EXISTS");
  const n = c.name();
  if (!n) throw new Error("no view name");
  const v = newTable(ctx, n, "view");
  const listed = c.isPunct("(") ? indexColumns(c.group()!) : null;
  while (!c.done && c.kw() !== "AS") c.next();
  c.accept("AS");
  const select = c.t.slice(c.i);
  v.definition = tokensText(select).slice(0, 4000);
  const sources = new Set<string>();
  const names = viewSources(select);
  for (const s of names) sources.add(tableId(s.name, s.schema));
  v.sources = [...sources];
  v.columns = (listed ?? selectColumns(select)).map((name) => ({ name, type: "", nullable: true, primaryKey: false, unique: false, autoIncrement: false }));
}

/** The tables a SELECT reads: names after FROM and JOIN (and FROM a, b), at any depth. */
function viewSources(toks: Tok[]): { name: string; schema?: string }[] {
  const out: { name: string; schema?: string }[] = [];
  const c = new Cursor(toks);
  while (!c.done) {
    const k = c.kw();
    if (k === "FROM" || k === "JOIN") {
      c.next();
      for (;;) {
        // FROM (a JOIN b …) as mysqldump writes joins; FROM (SELECT …) is a subquery, read on its own.
        while (c.isPunct("(") && c.kw(1) !== "SELECT" && c.kw(1) !== "WITH") c.next();
        if (c.isPunct("(")) break;
        const n = c.name();
        if (!n) break;
        out.push(n);
        c.accept("AS");
        const alias = c.peek();
        if (alias && (alias.t === "q" || (alias.t === "w" && !/^(WHERE|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|NATURAL|ON|USING|GROUP|ORDER|LIMIT|UNION|HAVING|WINDOW|OUTER|STRAIGHT_JOIN|LATERAL|OFFSET|FETCH|FOR|EXCEPT|INTERSECT|WITH)$/.test(alias.u)))) c.next();
        if (!c.punct(",")) break;
      }
      continue;
    }
    c.next();
  }
  return out;
}

/** A SELECT's output column names: aliases, else the last part of a column reference. */
function selectColumns(toks: Tok[]): string[] {
  let depth = 0;
  let start = -1;
  let end = toks.length;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === "p") {
      if (t.v === "(") depth++;
      else if (t.v === ")") depth--;
    } else if (depth === 0 && t.u === "SELECT" && start < 0) start = i + 1;
    else if (depth === 0 && t.u === "FROM" && start >= 0) {
      end = i;
      break;
    }
  }
  if (start < 0) return [];
  while (/^(DISTINCT|ALL|DISTINCTROW|SQL_CALC_FOUND_ROWS|TOP)$/.test(toks[start]?.u ?? "")) start++;
  return splitTop(toks.slice(start, end))
    .map((item) => {
      const last = item[item.length - 1];
      if (!last) return "";
      const before = item[item.length - 2];
      if (before?.u === "AS" || (item.length > 1 && (last.t === "q" || last.t === "w") && before && !(before.t === "p" && before.v === "."))) return last.v;
      if (last.t === "p" && last.v === "*") return "*";
      return last.t === "w" || last.t === "q" ? last.v : tokensText(item).slice(0, 40);
    })
    .filter(Boolean);
}

function alter(ctx: Ctx, c: Cursor) {
  c.next();
  if (!c.accept("TABLE")) return;
  c.accept("IF", "EXISTS");
  c.accept("ONLY");
  const n = c.name();
  if (!n) return;
  const t = lookupTable(ctx, n.name, n.schema);
  const actions = splitTop(c.t.slice(c.i));
  if (!t) {
    if (actions.some((a) => a[0]?.u === "ADD")) ctx.issues.push({ line: ctx.line, message: `ALTER TABLE ${n.name}: the table isn't created in this file.`, text: ctx.head });
    return;
  }
  for (const a of actions) {
    try {
      alterAction(ctx, t, a);
    } catch (e) {
      ctx.issues.push({ line: ctx.line, message: `${t.name}: skipped "${tokensText(a).slice(0, 80)}" (${(e as Error).message})`, text: ctx.head });
    }
  }
}

function alterAction(ctx: Ctx, t: SqlTable, a: Tok[]) {
  const c = new Cursor(a);
  const k = c.kw();
  if (k === "ADD") {
    c.next();
    if (c.accept("GENERATED")) return;
    if (c.accept("COLUMN")) {
      c.accept("IF", "NOT", "EXISTS");
      column(ctx, t, c);
      return;
    }
    c.accept("IF", "NOT", "EXISTS");
    // ADD (a int, b int): MySQL's several columns at once.
    if (c.isPunct("(") && c.peek(1)?.t !== "p") {
      for (const item of splitTop(c.group()!)) if (item.length) tableItem(ctx, t, item);
      return;
    }
    tableItem(ctx, t, a.slice(c.i));
    return;
  }
  if (k === "MODIFY" || k === "CHANGE") {
    c.next();
    c.accept("COLUMN");
    c.accept("IF", "EXISTS");
    let old: string | undefined;
    if (k === "CHANGE") old = c.next()?.v;
    const before = t.columns.find((x) => x.name.toLowerCase() === (old ?? c.peek()?.v ?? "").toLowerCase());
    const at = before ? t.columns.indexOf(before) : -1;
    const col = column(ctx, t, c);
    if (before && before.name.toLowerCase() !== col.name.toLowerCase()) {
      // CHANGE old new: the renamed column keeps its place.
      t.columns.splice(t.columns.indexOf(col), 1);
      t.columns.splice(at, 1, col);
    }
    if (before) {
      // Keys declared elsewhere stay: MODIFY restates the type and nullability.
      col.primaryKey ||= before.primaryKey;
      col.unique ||= before.unique;
      col.comment ??= before.comment;
    }
    return;
  }
  if (k === "ALTER") {
    c.next();
    c.accept("COLUMN");
    const col = t.columns.find((x) => x.name.toLowerCase() === (c.peek()?.v ?? "").toLowerCase());
    c.next();
    if (!col) return;
    if (c.accept("SET", "NOT", "NULL")) col.nullable = false;
    else if (c.accept("DROP", "NOT", "NULL")) col.nullable = true;
    else if (c.accept("SET", "DEFAULT")) {
      col.default = tokensText(c.t.slice(c.i));
      if (/^nextval\s*\(/i.test(col.default)) col.autoIncrement = true;
    } else if (c.accept("DROP", "DEFAULT")) col.default = undefined;
    else if (c.accept("ADD", "GENERATED")) col.autoIncrement = true;
    else if (c.accept("SET", "DATA", "TYPE") || c.accept("TYPE")) col.type = columnType(ctx, c, col);
    return;
  }
  if (k === "DROP") {
    c.next();
    if (c.accept("CONSTRAINT") || c.accept("FOREIGN", "KEY") || c.accept("INDEX") || c.accept("KEY")) {
      c.accept("IF", "EXISTS");
      const name = c.next()?.v.toLowerCase();
      t.foreignKeys = t.foreignKeys.filter((f) => f.name?.toLowerCase() !== name);
      t.indexes = t.indexes.filter((x) => x.name?.toLowerCase() !== name);
      t.checks = t.checks.filter((x) => x.name?.toLowerCase() !== name);
    } else if (c.accept("PRIMARY", "KEY")) setPrimaryKey(t, []);
    else {
      c.accept("COLUMN");
      c.accept("IF", "EXISTS");
      const name = c.next()?.v.toLowerCase();
      t.columns = t.columns.filter((x) => x.name.toLowerCase() !== name);
    }
    return;
  }
  if (k === "RENAME" && c.kw(1) === "COLUMN") {
    c.i += 2;
    const from = c.next()?.v.toLowerCase();
    c.accept("TO");
    const to = c.next()?.v;
    const col = t.columns.find((x) => x.name.toLowerCase() === from);
    if (col && to) col.name = to;
    return;
  }
  if (k === "COMMENT") {
    c.next();
    c.punct("=");
    const v = c.next();
    if (v?.t === "s") t.comment = v.v;
  }
}

/** COMMENT ON TABLE t IS '…' / COMMENT ON COLUMN t.c IS '…' (PostgreSQL). */
function commentOn(ctx: Ctx, c: Cursor) {
  c.next();
  if (!c.accept("ON")) return;
  const what = c.next()?.u;
  if (what !== "TABLE" && what !== "COLUMN" && what !== "VIEW") return;
  const parts: string[] = [];
  for (;;) {
    const t = c.next();
    if (!t) return;
    parts.push(t.v);
    if (!c.punct(".")) break;
  }
  if (!c.accept("IS")) return;
  const v = c.next();
  const text = v?.t === "s" ? v.v : undefined;
  if (what === "COLUMN") {
    const colName = parts.pop()!;
    const t = lookupTable(ctx, parts[parts.length - 1], parts[parts.length - 2]);
    const col = t?.columns.find((x) => x.name.toLowerCase() === colName.toLowerCase());
    if (col) col.comment = text;
  } else {
    const t = lookupTable(ctx, parts[parts.length - 1], parts[parts.length - 2]);
    if (t) t.comment = text;
  }
}

/** Foreign keys and view sources pointed at the tables they name; the referenced primary key filled in. */
function resolve(ctx: Ctx) {
  for (const t of ctx.tables.values()) {
    for (const fk of t.foreignKeys) {
      const target = lookupTable(ctx, fk.refTable, fk.refSchema);
      if (!target) {
        ctx.issues.push({ line: t.line, message: `${t.name}: the foreign key to ${fk.refTable} isn't drawn: ${fk.refTable} isn't created in this file.` });
        continue;
      }
      fk.target = target.id;
      if (!fk.refColumns.length) fk.refColumns = [...target.primaryKey];
    }
    if (t.sources) t.sources = [...new Set(t.sources.map((id) => (ctx.tables.has(id) ? id : lookupTable(ctx, id.split(".").pop()!)?.id)).filter((id): id is string => !!id && id !== t.id))];
  }
}

/**
 * The parse, as steps: it yields its position in the text now and then (about every 256 KB), so a caller can pause
 * between steps (parseSqlSchemaAsync) or run them all (parseSqlSchema).
 */
export function* parseSteps(text: string): Generator<number, SqlSchema> {
  const dialect = guessDialect(text);
  const mysql = dialect === "mysql";
  const ctx: Ctx = { mysql, tables: new Map(), enums: new Map(), issues: [], line: 1, head: "" };
  const n = text.length;
  let delim = ";";
  let statements = 0;
  let skipped = 0;
  let line = 1;
  let linePos = 0;
  let lastYield = 0;
  const lineAt = (pos: number) => {
    for (let k = text.indexOf("\n", linePos); k >= 0 && k < pos; k = text.indexOf("\n", k + 1)) line++;
    linePos = pos;
    return line;
  };
  let i = 0;
  while (i < n) {
    i = skipBlank(text, i, mysql);
    if (i >= n) break;
    const c0 = text.charCodeAt(i) | 32;
    if (c0 === 100 && /^delimiter[ \t]/i.test(text.slice(i, i + 10))) {
      const e = lineEnd(text, i);
      const d = text.slice(i + 10, e).trim();
      if (d) delim = d;
      i = e + 1;
      continue;
    }
    const start = i;
    const end = statementEnd(text, i, delim, mysql);
    statements++;
    const head = text.slice(start, Math.min(end, start + 160));
    const m = INTERESTING.exec(head);
    if (m) {
      ctx.line = lineAt(start);
      ctx.head = head.split("\n")[0].slice(0, 120);
      try {
        statement(ctx, tokenize(text.slice(start, end), mysql));
      } catch (e) {
        ctx.issues.push({ line: ctx.line, message: `Couldn't read this statement (${(e as Error).message}).`, text: ctx.head });
      }
    } else {
      skipped++;
      if (!mysql && /^COPY\b/i.test(head) && COPY_STDIN.test(text.slice(start, end))) {
        // pg_dump data: rows follow the statement until a line "\.".
        const e = text.indexOf("\n\\.", end);
        i = e < 0 ? n : e + 3;
        continue;
      }
    }
    i = end + delim.length;
    if (i - lastYield > 256 * 1024) {
      lastYield = i;
      yield i;
    }
  }
  resolve(ctx);
  return { tables: [...ctx.tables.values()], issues: ctx.issues, dialect, statements, skipped };
}

export function parseSqlSchema(text: string): SqlSchema {
  const steps = parseSteps(text);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * The parse in slices of about 12 ms, so a big dump doesn't freeze the window. `onProgress` gets 0…1;
 * `signal.aborted` stops it (the promise then never settles).
 */
export async function parseSqlSchemaAsync(text: string, onProgress?: (fraction: number) => void, signal?: { aborted: boolean }): Promise<SqlSchema> {
  const steps = parseSteps(text);
  let t0 = performance.now();
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (performance.now() - t0 > 12) {
      onProgress?.(r.value / Math.max(1, text.length));
      await new Promise((res) => setTimeout(res, 0));
      if (signal?.aborted) return new Promise(() => {});
      t0 = performance.now();
    }
  }
}

// ───────────────────────── helpers for the diagram ─────────────────────────

export interface ColumnFlags {
  pk: boolean;
  fk: boolean;
  unique: boolean;
  indexed: boolean;
  notNull: boolean;
  hasDefault: boolean;
}

/** What a column's badges show: key, foreign key, unique, indexed, NOT NULL, default. */
export function columnFlags(t: SqlTable, col: SqlColumn): ColumnFlags {
  const name = col.name.toLowerCase();
  const inIndex = (ix: SqlIndex) => ix.columns.some((x) => x.toLowerCase() === name);
  return {
    pk: col.primaryKey,
    fk: t.foreignKeys.some((f) => f.columns.some((x) => x.toLowerCase() === name)),
    unique: col.unique || t.indexes.some((ix) => ix.unique && ix.kind !== "primary" && ix.columns.length === 1 && inIndex(ix)),
    indexed: t.indexes.some((ix) => ix.kind !== "primary" && inIndex(ix)),
    notNull: !col.nullable,
    hasDefault: col.default !== undefined && col.default.toUpperCase() !== "NULL",
  };
}

export interface Relationship {
  id: string;
  from: string;
  to: string;
  fk: SqlForeignKey;
  /** Each child row has a parent (the FK columns are NOT NULL). */
  mandatory: boolean;
  /** At most one child per parent (the FK columns are unique or the primary key). */
  oneToOne: boolean;
}

/** Every drawable foreign key, with its cardinality from nullability and uniqueness. */
export function relationships(schema: SqlSchema): Relationship[] {
  const out: Relationship[] = [];
  for (const t of schema.tables)
    t.foreignKeys.forEach((fk, i) => {
      if (!fk.target) return;
      const cols = fk.columns.map((x) => t.columns.find((c) => c.name.toLowerCase() === x.toLowerCase()));
      const lower = fk.columns.map((x) => x.toLowerCase()).sort().join(",");
      const sameAs = (cols2: string[]) => cols2.map((x) => x.toLowerCase()).sort().join(",") === lower;
      const oneToOne = (t.primaryKey.length > 0 && sameAs(t.primaryKey)) || t.indexes.some((ix) => ix.unique && sameAs(ix.columns)) || (cols.length === 1 && !!cols[0]?.unique);
      out.push({ id: `${t.id}#${i}`, from: t.id, to: fk.target, fk, mandatory: cols.every((c) => c && !c.nullable), oneToOne });
    });
  return out;
}
