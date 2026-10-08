import { describe, expect, it } from "vitest";
import { splitSql, statementAt } from "./split";

describe("splitSql", () => {
  it("splits statements and keeps their lines", () => {
    const s = splitSql("CREATE TABLE t(a);\n\n-- seed\nINSERT INTO t VALUES (1);\nSELECT * FROM t");
    expect(s.map((x) => [x.text, x.line])).toEqual([
      ["CREATE TABLE t(a)", 1],
      ["INSERT INTO t VALUES (1)", 4],
      ["SELECT * FROM t", 5],
    ]);
  });

  it("ignores semicolons in strings, identifiers and comments", () => {
    const s = splitSql("INSERT INTO t VALUES ('a;b', 'it''s;');\n/* x; y */ SELECT \"c;d\", [e;f] FROM t; -- end;");
    expect(s).toHaveLength(2);
    expect(s[0].text).toBe("INSERT INTO t VALUES ('a;b', 'it''s;')");
    expect(s[1].text).toContain('SELECT "c;d", [e;f] FROM t');
  });

  it("keeps a trigger body together", () => {
    const s = splitSql("CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n  UPDATE t SET a = 1;\n  DELETE FROM u;\nEND;\nSELECT 1;");
    expect(s).toHaveLength(2);
    expect(s[0].text).toMatch(/^CREATE TRIGGER[\s\S]*END$/);
  });

  it("does not treat BEGIN TRANSACTION as a body", () => {
    expect(splitSql("BEGIN TRANSACTION; INSERT INTO t VALUES (1); COMMIT;")).toHaveLength(3);
  });

  it("drops comment-only pieces", () => {
    expect(splitSql("-- only a comment\n;\n/* x */;")).toHaveLength(0);
  });

  it("finds the statement at a cursor", () => {
    const script = "SELECT 1;\nSELECT 2;\n";
    expect(statementAt(script, 3)?.text).toBe("SELECT 1");
    expect(statementAt(script, 13)?.text).toBe("SELECT 2");
  });
});
