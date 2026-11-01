import { describe, expect, it } from "vitest";
import { declaredPackages, scanFiles } from "./scan";

const rules = (files: Record<string, string>) => scanFiles(Object.entries(files).map(([path, text]) => ({ path, text }))).map((f) => `${f.severity}:${f.rule}:${f.path}:${f.line}`);

describe("the pre-publish safety scan (M1)", () => {
  it("finds the mistakes AI-built apps ship most often", () => {
    const found = rules({
      "server.js": [
        "const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz012345';",
        "app.use(cors());",
        "db.query(\"SELECT * FROM users WHERE id = \" + req.params.id);",
        "db.query(`DELETE FROM t WHERE id = ${id}`);",
        "if (password === 'hunter2') ok();",
        "el.innerHTML = userText;",
        "fetch('http://api.example.com/v1/items');",
        "eval(req.body.code);",
      ].join("\n"),
      "app.py": "app.run(debug=True)\ncur.execute(f\"SELECT * FROM t WHERE n = '{name}'\")\nhashlib.md5(pw)",
      ".env": "API_KEY=abc123456",
    });
    expect(found).toEqual(
      expect.arrayContaining([
        "critical:secret-in-code:server.js:1",
        "critical:sql-from-strings:server.js:3",
        "critical:sql-from-strings:server.js:4",
        "critical:plain-password:server.js:5",
        "critical:sql-format:app.py:2",
        "critical:env-not-ignored:.env:1",
        "high:open-cors:server.js:2",
        "high:innerhtml:server.js:6",
        "high:eval:server.js:8",
        "high:weak-hash:app.py:3",
        "medium:debug-on:app.py:1",
        "medium:plain-http:server.js:7",
      ]),
    );
    // Critical first.
    expect(found[0]).toMatch(/^critical:/);
  });

  it("stays quiet on the safe forms", () => {
    expect(
      rules({
        "server.js": "db.query('SELECT * FROM users WHERE id = ?', [id]);\napp.use(cors({ origin: 'https://school.example' }));\nel.textContent = userText;\nel.innerHTML = '<b>Hi</b>';\nfetch('http://localhost:3000/api/items');\n// eval(x) in a comment",
        ".env": "API_KEY=abc123456",
        ".gitignore": "node_modules\n.env\n",
      }),
    ).toEqual([]);
  });

  it("flags data-changing routes without sign-in when the app has sign-in", () => {
    const found = rules({ "routes.js": "router.post('/login', login);\nrouter.post('/tickets', requireAuth, create);\nrouter.delete('/tickets/:id', remove);" });
    expect(found).toEqual(["high:route-without-auth:routes.js:3"]);
  });

  it("reads declared packages for the existence check", () => {
    expect(declaredPackages([{ path: "package.json", text: JSON.stringify({ dependencies: { express: "^4" }, devDependencies: { vitest: "1" } }) }, { path: "requirements.txt", text: "flask[async]>=3\n# comment\n-r other.txt\nrequests==2.31" }])).toEqual([
      { ecosystem: "npm", name: "express" },
      { ecosystem: "npm", name: "vitest" },
      { ecosystem: "pypi", name: "flask" },
      { ecosystem: "pypi", name: "requests" },
    ]);
  });
});
