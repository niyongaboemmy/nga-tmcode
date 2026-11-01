import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { PRACTICE_POLICY } from "@tmcode/protocol";
import { setActivityFolder, useActivityLog } from "../activity/log";
import { MemoryFileSystem } from "../platform/memory";
import type { ApiRequest, Platform } from "../platform/types";
import { initWorkbench, resetWorkbenchForTests, setPolicy } from "../state/store";
import { useExam } from "../exam/state";
import { permission, toolDefs } from "./agent/tools";
import { codeLikeText, allowAiCopy } from "./copyGuard";
import { directChat, directRoute, parseAnswer, toAnthropic, useLocalAi } from "./direct";
import { aiGate, aiUiHidden } from "./gate";
import { useLayerInputs } from "./layerState";
import { chat, useAi, type AiStatus } from "./service";
import { verifySticky } from "./sticky";

const status = (extra: Partial<AiStatus>): AiStatus => ({ enabled: true, exam: false, default_mode: "free", modes: [], models: [], you: { chat: { used: 0, limit: 9 }, complete: { used: 0, limit: 9 } }, pools: {}, openrouter: null, ...extra });
const learning = status({ allowed: true, reason: "ALLOWED_BY_TEACHER", mode: "hints", layer: "learning", features: { assist: true, complete: false }, thirdPartyExtensions: false });

function platform(answer: (r: ApiRequest) => { status: number; body: string }, keys: Record<string, string> = {}) {
  const sent: ApiRequest[] = [];
  const memory = new Map<string, unknown>();
  const p = {
    kind: "web",
    os: "mac",
    version: "test",
    fs: new MemoryFileSystem({}),
    store: { get: async (k: string) => memory.get(k), set: async (k: string, v: unknown) => void memory.set(k, v) },
    http: { request: async (r: ApiRequest) => (sent.push(r), { status_text: "", headers: [], binary: false, size: 0, truncated: false, ms: 1, ...answer(r) }) },
    aiKeys: { get: async (k: string) => keys[k] ?? null, set: async () => {}, delete: async () => {} },
    async openFolder() {
      return null;
    },
    async reopenFolder() {
      return null;
    },
  } as unknown as Platform;
  return { p, sent };
}

beforeEach(() => {
  resetWorkbenchForTests();
  setPolicy(PRACTICE_POLICY);
  useExam.setState({ quiz: null });
  useAi.setState({ status: null, denied: null, statusFor: null, project: { id: null, assessment: false }, mode: "free" });
  useLayerInputs.setState({ signedIn: null, device: null, sticky: null, choice: null, choseGuided: false });
  setActivityFolder("/ws");
});

describe("Learning keeps the agent read-only", () => {
  it("only the looking tools, and every change refused", () => {
    expect(toolDefs("auto", true, true, "learning").map((t) => t.function.name)).toEqual(["list_files", "read_file", "search", "get_problems", "repo_map", "find_symbol", "explore", "ask_user"]);
    expect(permission("auto", "read_file", {}, "learning")).toBe("allow");
    for (const t of ["edit_file", "write_file", "delete_file", "rename_file", "run_command", "propose_grade"]) expect(permission("auto", t, { command: "npm test" }, "learning")).toBe("refuse");
    expect(permission("auto", "edit_file", {}, "industrial")).toBe("allow");
  });
});

describe("the copy guard", () => {
  it("blocks code-looking text in Learning and logs the attempt; prose and Industrial copy freely", async () => {
    const { p } = platform(() => ({ status: 200, body: "{}" }));
    await initWorkbench(p);
    useAi.setState({ status: learning });
    expect(codeLikeText("total += price * qty")).toBe(true);
    expect(codeLikeText("Think about what the loop does.")).toBe(false);
    expect(allowAiCopy("Think about what the loop does.")).toBe(true);
    expect(allowAiCopy("for n in numbers:\n    total += n")).toBe(false);
    expect(useActivityLog.getState().events.some((e) => e.action === "copy-blocked")).toBe(true);
    useAi.setState({ status: status({ allowed: true, reason: "ALLOWED_BY_ROLE", layer: "industrial", features: { assist: true, complete: true } }) });
    expect(allowAiCopy("total += 1")).toBe(true);
  });
});

describe("A5: no AI UI in an Exam-layer exam", () => {
  it("hidden only in an exam session whose layer is Exam", () => {
    expect(aiUiHidden({ layer: "exam" }, true)).toBe(true);
    expect(aiUiHidden({ layer: "exam" }, false)).toBe(false);
    expect(aiUiHidden({ layer: "learning" }, true)).toBe(false);
  });
});

describe("own AI that never passes NGA (A7)", () => {
  it("parses OpenAI- and Anthropic-shaped answers, tool calls included", () => {
    expect(parseAnswer("openai", { model: "m1", choices: [{ message: { content: "hi", tool_calls: [{ id: "t", function: { name: "read_file", arguments: '{"path":"a"}' } }] } }] }, "m")).toEqual({
      text: "hi",
      model: "m1",
      tool_calls: [{ id: "t", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
    });
    expect(parseAnswer("anthropic", { model: "c", content: [{ type: "text", text: "a" }, { type: "tool_use", id: "u", name: "search", input: { query: "x" } }] }, "m")).toEqual({
      text: "a",
      model: "c",
      tool_calls: [{ id: "u", type: "function", function: { name: "search", arguments: '{"query":"x"}' } }],
    });
  });

  it("turns tool traffic into Anthropic's blocks, merging consecutive turns", () => {
    const out = toAnthropic([
      { role: "user", content: "q" },
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] },
      { role: "tool", tool_call_id: "1", content: "file" },
    ]);
    expect(out).toEqual([
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "1", name: "read_file", input: { path: "a" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "file" }] },
    ]);
  });

  it("signed out, an own-key question goes straight to the provider with the keychain key", async () => {
    const { p, sent } = platform(() => ({ status: 200, body: JSON.stringify({ model: "gpt-4.1-mini", choices: [{ message: { content: "Hello!" } }] }) }), { openai: "sk-user" });
    await initWorkbench(p);
    useLayerInputs.setState({ signedIn: false });
    useAi.setState({ mode: "byok:openai/gpt-4.1-mini" });
    const got = await new Promise<{ text: string; model: string }>((resolve, reject) => {
      let text = "";
      void chat([{ role: "user", content: "hi" }], undefined, { meta: () => {}, delta: (t) => (text += t), done: (d) => resolve({ text, model: d.model }), error: reject });
    });
    expect(got).toEqual({ text: "Hello!", model: "gpt-4.1-mini" });
    expect(sent[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(sent[0].headers).toContainEqual(["Authorization", "Bearer sk-user"]);
    expect(aiGate()).toMatchObject({ layer: "industrial", profile: "open" });
  });

  it("signed out without an own AI: a clear refusal, not NGA", async () => {
    const { p, sent } = platform(() => ({ status: 200, body: "{}" }));
    await initWorkbench(p);
    useLayerInputs.setState({ signedIn: false });
    await expect(chat([{ role: "user", content: "hi" }], undefined, { meta() {}, delta() {}, done() {}, error() {} })).rejects.toMatchObject({ code: "SIGNED_OUT" });
    expect(sent).toHaveLength(0);
  });

  it("a local model in Learning: the client filter cuts code and tools that change files", async () => {
    const { p } = platform(() => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: "Try:\n```py\nbiggest = n\n```\nWhat next?", tool_calls: [{ id: "w", function: { name: "write_file", arguments: "{}" } }] } }] }) }));
    await initWorkbench(p);
    useLocalAi.setState({ url: "http://localhost:11434/v1" });
    const route = (await directRoute("local:qwen2.5-coder"))!;
    expect(route).toMatchObject({ url: "http://localhost:11434/v1/chat/completions", model: "qwen2.5-coder", kind: "openai" });
    const done = await new Promise<{ text: string; d: any }>((resolve, reject) => {
      let text = "";
      void directChat(route, [{ role: "user", content: "fix it" }], undefined, { meta() {}, delta: (t) => (text += t), done: (d) => resolve({ text, d }), error: reject }, undefined, "learning");
    });
    expect(done.text).not.toMatch(/biggest = n/);
    expect(done.text).toMatch(/TMCode removed 1 line/);
    expect(done.d).toMatchObject({ layer: "learning", filtered: { removed: 1 } });
    expect(done.d.tool_calls).toBeUndefined();
  });

  it("a provider's refusal says what to do", async () => {
    const { p } = platform(() => ({ status: 401, body: JSON.stringify({ error: { message: "bad key" } }) }), { anthropic: "sk-ant-x" });
    await initWorkbench(p);
    const route = (await directRoute("byok:anthropic/claude-sonnet-4-5"))!;
    expect(route.headers).toContainEqual(["x-api-key", "sk-ant-x"]);
    const err = await new Promise<{ code: string; message: string }>((resolve) => void directChat(route, [{ role: "user", content: "x" }], undefined, { meta() {}, delta() {}, done() {}, error: resolve }, undefined, "industrial"));
    expect(err).toMatchObject({ code: "BYOK_REJECTED" });
    expect(err.message).toMatch(/bad key/);
  });
});

describe("the sticky signed layer (A9)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keys = { k9: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  const token = (claims: Record<string, unknown>) => {
    const c = Buffer.from(JSON.stringify({ v: 1, project_id: 5, ai_mode: "hints", own_tools: false, iat: "2026-11-01T00:00:00Z", exp: "2099-01-01T00:00:00Z", kid: "k9", ...claims })).toString("base64url");
    return { claims: c, sig: sign(null, Buffer.from(c, "ascii"), privateKey).toString("base64url") };
  };

  it("accepts Task Mentor's signature for the right project", async () => {
    expect(await verifySticky(token({}), 5, keys)).toEqual({ ok: true, sticky: { layer: "learning", ownTools: false, projectId: 5, exp: "2099-01-01T00:00:00Z" } });
  });

  it("refuses an edited, foreign, expired or unknown-key token", async () => {
    const t = token({});
    const edited = { ...t, claims: Buffer.from(Buffer.from(t.claims, "base64url").toString().replace('"hints"', '"full"')).toString("base64url") };
    expect(await verifySticky(edited, 5, keys)).toEqual({ ok: false, why: "signature" });
    expect(await verifySticky(token({}), 6, keys)).toEqual({ ok: false, why: "project" });
    expect(await verifySticky(token({ exp: "2020-01-01T00:00:00Z" }), 5, keys)).toEqual({ ok: false, why: "expired" });
    expect(await verifySticky(token({ kid: "nope" }), 5, keys)).toEqual({ ok: false, why: "signature" });
    expect(await verifySticky({ junk: 1 }, 5, keys)).toEqual({ ok: false, why: "malformed" });
  });
});

describe("codebase understanding (G7)", () => {
  it("maps definitions ranked by use and finds where a name is defined and used", async () => {
    const { p } = platform(() => ({ status: 200, body: "{}" }));
    (p as unknown as { fs: MemoryFileSystem }).fs = new MemoryFileSystem({
      "src/cart.js": "export function total(items) {\n  return items.reduce((a, b) => a + b.price, 0);\n}\nexport class Cart {}\n",
      "src/app.js": "import { total } from './cart.js';\nconsole.log(total([]));\nconsole.log(total([{ price: 2 }]));\n",
      "util.py": "def helper():\n    pass\n\nclass Thing:\n    def go(self):\n        pass\n",
      ".env": "SECRET=1\n",
    });
    await initWorkbench(p);
    const { repoMap, findSymbol, symbolsOf } = await import("./agent/codebase");
    expect(symbolsOf("util.py", "def helper():\n    pass\nclass Thing:\n    def go(self):\n")).toEqual([
      { name: "helper", kind: "function", line: 1 },
      { name: "Thing", kind: "class", line: 3 },
      { name: "go", kind: "method", line: 4 },
    ]);
    const map = await repoMap(p.fs);
    expect(map.split("\n")[0]).toBe("src/cart.js (used 3×)");
    expect(map).toContain("function total :1");
    expect(map).not.toContain(".env");
    const found = await findSymbol(p.fs, "total");
    expect(found).toContain("src/cart.js:1: function total");
    expect(found).toContain("src/app.js:2: console.log(total([]));");
  });
});
