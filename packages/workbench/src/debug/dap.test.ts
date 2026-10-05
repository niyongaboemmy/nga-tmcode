import { describe, expect, it } from "vitest";
import { DapFrameReader, encodeMessage } from "./dap";
import { DapSession } from "./dapSession";

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (s: string) => new TextEncoder().encode(s);

describe("DAP framing", () => {
  it("frames with a Content-Length that counts UTF-8 bytes", () => {
    const body = '{"x":"héllo ✓"}';
    const framed = text(encodeMessage(body));
    expect(framed).toBe(`Content-Length: ${bytes(body).length}\r\n\r\n${body}`);
    expect(bytes(body).length).not.toBe(body.length);
  });

  it("round-trips messages delivered byte by byte (splitting multi-byte characters)", () => {
    const a = '{"seq":1,"type":"event","event":"initialized"}';
    const b = '{"seq":2,"type":"response","body":{"text":"héllo ✓ 日本"}}';
    const all = new Uint8Array([...encodeMessage(a), ...encodeMessage(b)]);
    const r = new DapFrameReader();
    const got: string[] = [];
    for (const byte of all) {
      r.push(new Uint8Array([byte]));
      got.push(...r.drain());
    }
    expect(got).toEqual([a, b]);
  });

  it("returns several messages pushed at once, then waits", () => {
    const r = new DapFrameReader();
    r.push(new Uint8Array([...encodeMessage("{}"), ...encodeMessage("[]")]));
    expect(r.next()).toBe("{}");
    expect(r.next()).toBe("[]");
    expect(r.next()).toBeNull();
  });

  it("accepts extra headers and any header case", () => {
    const r = new DapFrameReader();
    r.push(bytes("content-length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}"));
    expect(r.next()).toBe("{}");
  });

  it("drops a header without Content-Length and recovers", () => {
    const r = new DapFrameReader();
    r.push(bytes("Bogus: 1\r\n\r\nContent-Length: 2\r\n\r\n[]"));
    expect(() => r.next()).toThrow(/bad DAP header/);
    expect(r.next()).toBe("[]");
    const errors: Error[] = [];
    r.push(bytes("X: y\r\n\r\nContent-Length: 4\r\n\r\ntrue"));
    expect(r.drain((e) => errors.push(e))).toEqual(["true"]);
    expect(errors).toHaveLength(1);
  });

  it("waits for a partial body", () => {
    const r = new DapFrameReader();
    r.push(bytes('Content-Length: 8\r\n\r\n{"a":'));
    expect(r.next()).toBeNull();
    r.push(bytes("12}"));
    expect(r.next()).toBe('{"a":12}');
  });

  it("gives up on an endless header", () => {
    const r = new DapFrameReader();
    r.push(bytes("x".repeat(9000)));
    expect(() => r.next()).toThrow(/too long/);
    expect(r.next()).toBeNull();
  });
});

describe("DapSession", () => {
  function pair() {
    const sent: { seq: number; type: string; command?: string; arguments?: unknown; request_seq?: number; success?: boolean; body?: unknown }[] = [];
    const s = new DapSession({ send: (m) => sent.push(JSON.parse(m)) }, "test");
    return { s, sent };
  }

  it("resolves a request with its response body and rejects with the adapter's message", async () => {
    const { s, sent } = pair();
    const ok = s.request<{ threads: unknown[] }>("threads");
    const bad = s.request("evaluate", { expression: "nope" });
    expect(sent.map((m) => m.command)).toEqual(["threads", "evaluate"]);
    s.handleMessage(JSON.stringify({ seq: 1, type: "response", request_seq: sent[1].seq, command: "evaluate", success: false, message: "NameError: name 'nope' is not defined" }));
    s.handleMessage({ seq: 2, type: "response", request_seq: sent[0].seq, command: "threads", success: true, body: { threads: [{ id: 1, name: "main" }] } });
    await expect(ok).resolves.toEqual({ threads: [{ id: 1, name: "main" }] });
    await expect(bad).rejects.toThrow("NameError");
  });

  it("formats structured errors ({format, variables})", async () => {
    const { s, sent } = pair();
    const p = s.request("launch", {});
    s.handleMessage({ seq: 1, type: "response", request_seq: sent[0].seq, command: "launch", success: false, body: { error: { format: "Cannot find {path}", variables: { path: "/x.py" } } } });
    await expect(p).rejects.toThrow("Cannot find /x.py");
  });

  it("dispatches events and answers reverse requests", async () => {
    const { s, sent } = pair();
    const stops: unknown[] = [];
    s.on("stopped", (b) => stops.push(b));
    s.handleMessage({ seq: 1, type: "event", event: "stopped", body: { reason: "breakpoint", threadId: 1 } });
    expect(stops).toEqual([{ reason: "breakpoint", threadId: 1 }]);
    s.onReverseRequest = async (command) => (command === "runInTerminal" ? { processId: 42 } : Promise.reject(new Error("no")));
    s.handleMessage({ seq: 7, type: "request", command: "runInTerminal", arguments: { args: ["python"] } });
    s.handleMessage({ seq: 8, type: "request", command: "other" });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.find((m) => m.request_seq === 7)).toMatchObject({ type: "response", success: true, body: { processId: 42 } });
    expect(sent.find((m) => m.request_seq === 8)).toMatchObject({ type: "response", success: false });
  });

  it("merges capabilities events and fails pending requests when closed", async () => {
    const { s } = pair();
    s.handleMessage({ seq: 1, type: "event", event: "capabilities", body: { capabilities: { supportsSetVariable: true } } });
    expect(s.capabilities.supportsSetVariable).toBe(true);
    const p = s.request("threads");
    const waiting = s.once("initialized");
    s.close();
    await expect(p).rejects.toThrow("ended");
    await expect(waiting).rejects.toThrow("exited");
    await expect(s.request("threads")).rejects.toThrow("ended");
  });
});
