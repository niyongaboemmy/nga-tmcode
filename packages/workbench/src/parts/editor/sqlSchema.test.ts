import { describe, expect, it } from "vitest";
import { columnFlags, guessDialect, parseSqlSchema, parseSqlSchemaAsync, relationships, type SqlSchema } from "./sqlSchema";

const table = (s: SqlSchema, name: string) => {
  const t = s.tables.find((x) => x.name === name);
  if (!t) throw new Error(`no table ${name}: ${s.tables.map((x) => x.name).join(", ")}`);
  return t;
};
const col = (s: SqlSchema, t: string, c: string) => {
  const x = table(s, t).columns.find((y) => y.name === c);
  if (!x) throw new Error(`no column ${t}.${c}`);
  return x;
};

const MYSQL_DUMP = `-- MySQL dump 10.13  Distrib 9.6.0, for macos26.3 (arm64)
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '';

DROP TABLE IF EXISTS \`AcademicYear\`;
CREATE TABLE \`AcademicYear\` (
  \`academic_year_id\` bigint NOT NULL AUTO_INCREMENT,
  \`name\` varchar(50) NOT NULL COMMENT 'e.g. 2025-2026; it''s unique',
  \`status\` enum('ACTIVE','CLOSED') DEFAULT 'ACTIVE',
  PRIMARY KEY (\`academic_year_id\`),
  UNIQUE KEY \`uq_name\` (\`name\`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COMMENT='School years';

CREATE TABLE \`AcademicCalendar\` (
  \`calendar_id\` bigint NOT NULL AUTO_INCREMENT,
  \`academic_year_id\` bigint NOT NULL,
  \`parent_id\` bigint DEFAULT NULL,
  \`name\` varchar(150) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Optional; name',
  \`price\` decimal(10,2) unsigned NOT NULL DEFAULT '0.00',
  \`updated_at\` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  \`total\` int GENERATED ALWAYS AS ((\`price\` * 2)) VIRTUAL,
  PRIMARY KEY (\`calendar_id\`),
  KEY \`idx_year\` (\`academic_year_id\`),
  FULLTEXT KEY \`ft_name\` (\`name\`),
  KEY \`idx_prefix\` (\`name\`(20)),
  CONSTRAINT \`AcademicCalendar_ibfk_1\` FOREIGN KEY (\`academic_year_id\`) REFERENCES \`AcademicYear\` (\`academic_year_id\`) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT \`self_fk\` FOREIGN KEY (\`parent_id\`) REFERENCES \`AcademicCalendar\` (\`calendar_id\`) ON DELETE SET NULL,
  CONSTRAINT \`chk_price\` CHECK ((\`price\` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

LOCK TABLES \`AcademicCalendar\` WRITE;
/*!40000 ALTER TABLE \`AcademicCalendar\` DISABLE KEYS */;
INSERT INTO \`AcademicCalendar\` VALUES (1,3,NULL,'It\\'s; CREATE TABLE fake (x int);',1.00,'2026-03-04',NULL),(2,3,1,'a \\\\',2.00,NULL,NULL);
/*!40000 ALTER TABLE \`AcademicCalendar\` ENABLE KEYS */;
UNLOCK TABLES;

DELIMITER ;;
CREATE TRIGGER trg BEFORE INSERT ON \`AcademicCalendar\` FOR EACH ROW BEGIN SET NEW.name = 'x'; END ;;
DELIMITER ;

/*!50001 DROP VIEW IF EXISTS \`v_calendars\`*/;
/*!50001 CREATE VIEW \`v_calendars\` AS SELECT
 1 AS \`calendar_id\`,
 1 AS \`year_name\`*/;
/*!50001 DROP VIEW IF EXISTS \`v_calendars\`*/;
/*!50001 CREATE ALGORITHM=UNDEFINED */
/*!50013 DEFINER=\`root\`@\`localhost\` SQL SECURITY DEFINER */
/*!50001 VIEW \`v_calendars\` AS select \`c\`.\`calendar_id\` AS \`calendar_id\`,\`y\`.\`name\` AS \`year_name\` from (\`AcademicCalendar\` \`c\` join \`AcademicYear\` \`y\` on((\`y\`.\`academic_year_id\` = \`c\`.\`academic_year_id\`))) */;
`;

describe("MySQL dumps", () => {
  const s = parseSqlSchema(MYSQL_DUMP);

  it("reads tables, columns, types and keys", () => {
    expect(s.dialect).toBe("mysql");
    expect(s.tables.map((t) => t.name)).toEqual(["AcademicYear", "AcademicCalendar", "v_calendars"]);
    const year = table(s, "AcademicYear");
    expect(year.primaryKey).toEqual(["academic_year_id"]);
    expect(year.comment).toBe("School years");
    expect(year.options).toBe("ENGINE=InnoDB");
    expect(year.line).toBe(7);
    expect(col(s, "AcademicYear", "academic_year_id")).toMatchObject({ type: "bigint", nullable: false, primaryKey: true, autoIncrement: true });
    expect(col(s, "AcademicYear", "name")).toMatchObject({ type: "varchar(50)", nullable: false, comment: "e.g. 2025-2026; it's unique" });
    expect(col(s, "AcademicYear", "status")).toMatchObject({ type: "enum('ACTIVE','CLOSED')", enumValues: ["ACTIVE", "CLOSED"], default: "'ACTIVE'", nullable: true });
    expect(year.indexes.map((i) => [i.kind, i.name, i.columns])).toEqual([
      ["primary", undefined, ["academic_year_id"]],
      ["unique", "uq_name", ["name"]],
    ]);
  });

  it("reads column attributes in any order", () => {
    expect(col(s, "AcademicCalendar", "name")).toMatchObject({ type: "varchar(150)", default: "NULL", comment: "Optional; name" });
    expect(col(s, "AcademicCalendar", "price")).toMatchObject({ type: "decimal(10,2) unsigned", default: "'0.00'", nullable: false });
    expect(col(s, "AcademicCalendar", "updated_at")).toMatchObject({ default: "CURRENT_TIMESTAMP", onUpdate: "CURRENT_TIMESTAMP" });
    expect(col(s, "AcademicCalendar", "total").generated).toBe("(`price` * 2)");
    const cal = table(s, "AcademicCalendar");
    expect(cal.indexes.map((i) => [i.kind, i.name, i.columns])).toEqual([
      ["primary", undefined, ["calendar_id"]],
      ["index", "idx_year", ["academic_year_id"]],
      ["fulltext", "ft_name", ["name"]],
      ["index", "idx_prefix", ["name"]],
    ]);
    expect(cal.checks).toEqual([{ name: "chk_price", expr: "(`price` >= 0)" }]);
  });

  it("reads foreign keys with their rules, including one to the same table", () => {
    const cal = table(s, "AcademicCalendar");
    expect(cal.foreignKeys).toEqual([
      { name: "AcademicCalendar_ibfk_1", columns: ["academic_year_id"], refTable: "AcademicYear", refSchema: undefined, refColumns: ["academic_year_id"], onDelete: "CASCADE", onUpdate: "NO ACTION", target: "academicyear" },
      { name: "self_fk", columns: ["parent_id"], refTable: "AcademicCalendar", refSchema: undefined, refColumns: ["calendar_id"], onDelete: "SET NULL", target: "academiccalendar" },
    ]);
    const rels = relationships(s);
    expect(rels.map((r) => [r.from, r.to, r.mandatory, r.oneToOne])).toEqual([
      ["academiccalendar", "academicyear", true, false],
      ["academiccalendar", "academiccalendar", false, false],
    ]);
  });

  it("skips data, triggers and executable comments, and keeps the real view over mysqldump's placeholder", () => {
    expect(s.tables.some((t) => t.name === "fake")).toBe(false);
    const v = table(s, "v_calendars");
    expect(v.kind).toBe("view");
    expect(v.columns.map((c) => c.name)).toEqual(["calendar_id", "year_name"]);
    expect(v.sources).toEqual(["academiccalendar", "academicyear"]);
    expect(v.definition).toMatch(/^select `c`.`calendar_id` AS `calendar_id`/);
    expect(s.issues).toEqual([]);
    expect(s.skipped).toBeGreaterThan(8);
  });

  it("gives each column its badges", () => {
    const cal = table(s, "AcademicCalendar");
    const flags = (name: string) => columnFlags(cal, cal.columns.find((c) => c.name === name)!);
    expect(flags("calendar_id")).toEqual({ pk: true, fk: false, unique: false, indexed: false, notNull: true, hasDefault: false });
    expect(flags("academic_year_id")).toEqual({ pk: false, fk: true, unique: false, indexed: true, notNull: true, hasDefault: false });
    expect(flags("price")).toMatchObject({ hasDefault: true, notNull: true });
    expect(flags("name")).toMatchObject({ hasDefault: false, indexed: true });
    const year = table(s, "AcademicYear");
    expect(columnFlags(year, year.columns[1]).unique).toBe(true);
  });
});

const PG_DUMP = `--
-- PostgreSQL database dump
--
SET statement_timeout = 0;
SELECT pg_catalog.set_config('search_path', '', false);

CREATE TYPE public.order_status AS ENUM (
    'new',
    'paid',
    'shipped'
);

CREATE FUNCTION public.touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now(); -- not a statement end;
  RETURN NEW;
END;
$$;

CREATE TABLE public.customers (
    id integer NOT NULL,
    email character varying(255) NOT NULL,
    "Full Name" text,
    created_at timestamp(6) with time zone DEFAULT now() NOT NULL,
    tags text[] DEFAULT '{}'::text[]
);

COMMENT ON TABLE public.customers IS 'People who buy';
COMMENT ON COLUMN public.customers.email IS 'Login e-mail';

CREATE SEQUENCE public.customers_id_seq AS integer START WITH 1;
ALTER TABLE public.customers OWNER TO shop;

CREATE TABLE public.orders (
    id bigserial PRIMARY KEY,
    customer_id integer REFERENCES public.customers ON DELETE RESTRICT,
    status public.order_status DEFAULT 'new'::public.order_status NOT NULL,
    total numeric(12,2) CHECK (total >= 0),
    code uuid GENERATED ALWAYS AS IDENTITY,
    CONSTRAINT orders_code_key UNIQUE (code)
);

CREATE TABLE billing.invoices (
    order_id bigint NOT NULL,
    amount double precision
);

COPY public.customers (id, email, "Full Name", created_at, tags) FROM stdin;
1	a@b.c	Ada; CREATE TABLE nope (x int);	2026-01-01	{}
\\.

ALTER TABLE ONLY public.customers ALTER COLUMN id SET DEFAULT nextval('public.customers_id_seq'::regclass);
ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_email_key UNIQUE (email);
ALTER TABLE ONLY billing.invoices
    ADD CONSTRAINT invoices_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX invoices_order_idx ON billing.invoices USING btree (order_id);
CREATE INDEX customers_lower_email ON public.customers USING btree (lower((email)::text));
CREATE MATERIALIZED VIEW public.big_orders AS
 SELECT o.id, c.email AS customer FROM public.orders o JOIN public.customers c ON c.id = o.customer_id WHERE o.total > 100;
`;

describe("pg_dump", () => {
  const s = parseSqlSchema(PG_DUMP);

  it("reads schema-qualified tables, quoted names, types and enums", () => {
    expect(s.dialect).toBe("postgres");
    expect(s.tables.map((t) => t.id)).toEqual(["public.customers", "public.orders", "billing.invoices", "public.big_orders"]);
    expect(table(s, "customers")).toMatchObject({ schema: "public", comment: "People who buy", primaryKey: ["id"] });
    expect(col(s, "customers", "email")).toMatchObject({ type: "character varying(255)", nullable: false, comment: "Login e-mail" });
    expect(col(s, "customers", "Full Name").type).toBe("text");
    expect(col(s, "customers", "created_at")).toMatchObject({ type: "timestamp(6) with time zone", default: "now()", nullable: false });
    expect(col(s, "customers", "tags")).toMatchObject({ type: "text[]", default: "'{}'::text[]" });
    expect(col(s, "customers", "id")).toMatchObject({ autoIncrement: true, primaryKey: true, nullable: false });
    expect(col(s, "orders", "status")).toMatchObject({ type: "public.order_status", enumValues: ["new", "paid", "shipped"], default: "'new'::public.order_status" });
    expect(col(s, "orders", "id")).toMatchObject({ type: "bigserial", autoIncrement: true, primaryKey: true });
    expect(col(s, "orders", "total").check).toBe("total >= 0");
    expect(col(s, "orders", "code").autoIncrement).toBe(true);
    expect(col(s, "invoices", "amount").type).toBe("double precision");
  });

  it("reads constraints added by ALTER TABLE ONLY and CREATE INDEX, and inline REFERENCES to a primary key", () => {
    const orders = table(s, "orders");
    expect(orders.foreignKeys[0]).toMatchObject({ columns: ["customer_id"], refColumns: ["id"], onDelete: "RESTRICT", target: "public.customers" });
    const inv = table(s, "invoices");
    expect(inv.foreignKeys[0]).toMatchObject({ name: "invoices_order_id_fkey", columns: ["order_id"], refColumns: ["id"], onDelete: "CASCADE", onUpdate: "CASCADE", target: "public.orders" });
    expect(inv.indexes[0]).toMatchObject({ name: "invoices_order_idx", unique: true, columns: ["order_id"], using: "btree" });
    expect(table(s, "customers").indexes.map((i) => i.columns[0])).toEqual(["id", "email", "lower((email)::text)"]);
    // The unique index on invoices.order_id makes it one-to-one.
    expect(relationships(s).find((r) => r.from === "billing.invoices")).toMatchObject({ mandatory: true, oneToOne: true });
  });

  it("skips function bodies and COPY data, and reads materialized views", () => {
    expect(s.tables.some((t) => t.name === "nope")).toBe(false);
    const v = table(s, "big_orders");
    expect(v.kind).toBe("view");
    expect(v.columns.map((c) => c.name)).toEqual(["id", "customer"]);
    expect(v.sources).toEqual(["public.orders", "public.customers"]);
    expect(s.issues).toEqual([]);
  });
});

describe("SQLite", () => {
  const s = parseSqlSchema(`PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE "artists" ([ArtistId] INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, born);
CREATE TABLE tracks (
  id INTEGER PRIMARY KEY,
  artist_id INTEGER NOT NULL REFERENCES artists(ArtistId) ON DELETE CASCADE,
  key TEXT, -- a column called key
  title TEXT COLLATE NOCASE DEFAULT ('untitled'),
  FOREIGN KEY (id) REFERENCES artists
) WITHOUT ROWID, STRICT;
INSERT INTO sqlite_sequence VALUES('artists',3);
CREATE INDEX tracks_title ON tracks(title DESC);
COMMIT;`);

  it("reads SQLite's forms", () => {
    expect(s.dialect).toBe("sqlite");
    expect(col(s, "artists", "ArtistId")).toMatchObject({ type: "INTEGER", primaryKey: true, autoIncrement: true });
    expect(col(s, "artists", "name")).toMatchObject({ unique: true, nullable: false });
    expect(col(s, "artists", "born").type).toBe("");
    expect(table(s, "tracks").columns.map((c) => c.name)).toEqual(["id", "artist_id", "key", "title"]);
    expect(col(s, "tracks", "title")).toMatchObject({ type: "TEXT", default: "('untitled')" });
    expect(table(s, "tracks").options).toBe("WITHOUT ROWID STRICT");
    expect(table(s, "tracks").foreignKeys.map((f) => [f.columns, f.refColumns, f.onDelete])).toEqual([
      [["artist_id"], ["ArtistId"], "CASCADE"],
      [["id"], ["ArtistId"], undefined],
    ]);
    expect(table(s, "tracks").indexes.at(-1)).toMatchObject({ name: "tracks_title", columns: ["title"] });
    // id is both the primary key and the foreign key: one-to-one.
    expect(relationships(s).map((r) => r.oneToOne)).toEqual([false, true]);
  });
});

describe("ALTER TABLE and edge cases", () => {
  it("reads phpMyAdmin's keys added after the tables", () => {
    const s = parseSqlSchema(`-- phpMyAdmin SQL Dump
CREATE TABLE \`users\` (\`id\` int(11) NOT NULL, \`email\` varchar(100) NOT NULL);
CREATE TABLE \`posts\` (\`id\` int(11) NOT NULL, \`user_id\` int(11) DEFAULT NULL, \`slug\` varchar(50) NOT NULL);
INSERT INTO \`users\` (\`id\`, \`email\`) VALUES (1, 'a@b.c');
ALTER TABLE \`users\` ADD PRIMARY KEY (\`id\`), ADD UNIQUE KEY \`email\` (\`email\`);
ALTER TABLE \`posts\` ADD PRIMARY KEY (\`id\`), ADD KEY \`user_id\` (\`user_id\`), ADD UNIQUE INDEX (\`slug\`);
ALTER TABLE \`users\` MODIFY \`id\` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;
ALTER TABLE \`posts\` ADD CONSTRAINT \`posts_ibfk_1\` FOREIGN KEY (\`user_id\`) REFERENCES \`users\` (\`id\`) ON DELETE SET NULL;
ALTER TABLE \`posts\` ADD COLUMN \`title\` varchar(200) NOT NULL DEFAULT '' AFTER \`id\`;
ALTER TABLE \`posts\` CHANGE \`slug\` \`permalink\` varchar(80) NOT NULL;
ALTER TABLE \`posts\` ADD FOREIGN KEY (\`id\`) REFERENCES \`ghost\` (\`id\`);`);
    expect(col(s, "users", "id")).toMatchObject({ primaryKey: true, autoIncrement: true, type: "int(11)" });
    expect(table(s, "users").columns.map((c) => c.name)).toEqual(["id", "email"]);
    expect(table(s, "posts").indexes.map((i) => [i.kind, i.columns])).toEqual([
      ["primary", ["id"]],
      ["index", ["user_id"]],
      ["unique", ["slug"]],
    ]);
    expect(table(s, "posts").columns.map((c) => c.name)).toEqual(["id", "user_id", "permalink", "title"]);
    const rel = relationships(s);
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ from: "posts", to: "users", mandatory: false, oneToOne: false });
    expect(rel[0].fk.onDelete).toBe("SET NULL");
    expect(s.issues.map((i) => i.message)).toEqual(["posts: the foreign key to ghost isn't drawn: ghost isn't created in this file."]);
  });

  it("reports what it skipped, and goes on", () => {
    const s = parseSqlSchema(`CREATE TABLE a (id int PRIMARY KEY, CONSTRAINT broken FOREIGN KEY (id));
CREATE TABLE b AS SELECT * FROM a;
CREATE TABLE ;
ALTER TABLE missing ADD CONSTRAINT x PRIMARY KEY (id);
CREATE TABLE c (id int);`);
    expect(s.tables.map((t) => t.name)).toEqual(["a", "b", "c"]);
    expect(s.issues.map((i) => [i.line, i.message])).toEqual([
      [1, 'a: skipped "CONSTRAINT broken FOREIGN KEY (id)" (FOREIGN KEY without REFERENCES)'],
      [2, "b: made from a query (CREATE TABLE … AS), so its columns aren't known."],
      [3, "Couldn't read this statement (no table name)."],
      [4, "ALTER TABLE missing: the table isn't created in this file."],
    ]);
  });

  it("handles comments, odd quoting and SQL Server brackets", () => {
    const s = parseSqlSchema(`/* a block comment with ; inside */
CREATE TABLE IF NOT EXISTS [dbo].[Order Items] ( -- trailing ; comment
  [Id] INT IDENTITY(1,1) NOT NULL,
  "Qty" int CONSTRAINT qty_pos CHECK ("Qty" > 0) CONSTRAINT qty_nn NOT NULL,
  note varchar(20) DEFAULT 'a ''quoted'' ; value',
  CONSTRAINT [PK_Order Items] PRIMARY KEY CLUSTERED ([Id] ASC)
);
create table lower_case (x int references "Order Items" (Id));`);
    const t = table(s, "Order Items");
    expect(t.schema).toBe("dbo");
    expect(col(s, "Order Items", "Id")).toMatchObject({ autoIncrement: true, primaryKey: true });
    expect(col(s, "Order Items", "Qty")).toMatchObject({ check: '"Qty" > 0', nullable: false });
    expect(col(s, "Order Items", "note").default).toBe("'a ''quoted'' ; value'");
    expect(t.indexes[0]).toMatchObject({ kind: "primary", name: "PK_Order Items", columns: ["Id"] });
    expect(table(s, "lower_case").foreignKeys[0].target).toBe("dbo.order items");
  });

  it("guesses the dialect", () => {
    expect(guessDialect("CREATE TABLE `a` (x int)")).toBe("mysql");
    expect(guessDialect("CREATE TABLE a (id serial)")).toBe("postgres");
    expect(guessDialect("CREATE TABLE a (id integer primary key autoincrement)")).toBe("sqlite");
    expect(guessDialect("CREATE TABLE a (id int)")).toBe("generic");
  });

  it("finds no tables in a file of queries", () => {
    const s = parseSqlSchema("SELECT * FROM users WHERE id = 1;\nUPDATE users SET name = 'x';");
    expect(s.tables).toEqual([]);
    expect(s.statements).toBe(2);
    expect(s.skipped).toBe(2);
  });

  it("steps over tens of MB of INSERT data quickly, in slices", async () => {
    const row = "(1,'It\\'s a ; long ''value''',NULL,'2026-01-01 00:00:00',3.14),";
    const insert = `INSERT INTO \`t\` VALUES ${row.repeat(20_000)}(2,'end',NULL,NULL,0);\n`;
    const big = `CREATE TABLE \`t\` (\`id\` int NOT NULL, PRIMARY KEY (\`id\`));\n${insert.repeat(20)}CREATE TABLE \`u\` (\`t_id\` int, FOREIGN KEY (\`t_id\`) REFERENCES \`t\` (\`id\`));\n`;
    expect(big.length).toBeGreaterThan(20_000_000);
    const t0 = performance.now();
    const fractions: number[] = [];
    const s = await parseSqlSchemaAsync(big, (f) => fractions.push(f));
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(s.tables.map((t) => t.name)).toEqual(["t", "u"]);
    expect(relationships(s)).toHaveLength(1);
    expect(fractions.every((f, i) => f > 0 && f <= 1 && (i === 0 || f >= fractions[i - 1]))).toBe(true);
  });
});
