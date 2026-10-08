import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import { freshDatabase, queryPlan, runScript, schemaOf, setSqlWasmPath } from "./engine";

beforeAll(() => setSqlWasmPath(createRequire(import.meta.url).resolve("sql.js/dist/sql-wasm.wasm")));

describe("SQL engine (sql.js)", () => {
  it("runs statements one by one with rows, changes and errors at their line", async () => {
    const db = await freshDatabase();
    const res = runScript(
      db,
      "CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT NOT NULL, grade INT);\nINSERT INTO students (name, grade) VALUES ('Ada', 90), ('Ben', 72);\nSELECT name, grade FROM students ORDER BY grade DESC;\nSELECT nope FROM students;\nSELECT 1;",
    );
    expect(res.map((r) => r.kind)).toEqual(["ok", "change", "rows", "error"]);
    expect(res[1].changes).toBe(2);
    expect(res[2].columns).toEqual(["name", "grade"]);
    expect(res[2].rows).toEqual([
      ["Ada", 90],
      ["Ben", 72],
    ]);
    expect(res[3].line).toBe(4);
    expect(res[3].error).toMatch(/no such column: nope/);
  });

  it("continues after an error when asked", async () => {
    const db = await freshDatabase();
    expect(runScript(db, "SELECT x; SELECT 2;", { continueOnError: true }).map((r) => r.kind)).toEqual(["error", "rows"]);
  });

  it("lists the schema with columns and row counts, and explains a query", async () => {
    const db = await freshDatabase();
    runScript(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL); INSERT INTO t (v) VALUES ('a'); CREATE VIEW vt AS SELECT v FROM t;");
    const schema = schemaOf(db);
    expect(schema.map((t) => [t.name, t.type, t.rows])).toEqual([
      ["t", "table", 1],
      ["vt", "view", 1],
    ]);
    expect(schema[0].columns[0]).toMatchObject({ name: "id", pk: true });
    expect(schema[0].columns[1]).toMatchObject({ name: "v", notnull: true });
    expect(queryPlan(db, "SELECT * FROM t WHERE id = 1").join("\n")).toMatch(/SEARCH t USING INTEGER PRIMARY KEY/);
  });

  it("enforces foreign keys", async () => {
    const db = await freshDatabase();
    const res = runScript(db, "CREATE TABLE a (id INTEGER PRIMARY KEY); CREATE TABLE b (a_id INT REFERENCES a(id)); INSERT INTO b VALUES (9);");
    expect(res[2].error).toMatch(/FOREIGN KEY constraint failed/);
  });
});
