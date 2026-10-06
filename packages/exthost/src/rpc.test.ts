import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, RpcConnection, type RpcMessage } from "./rpc";

const text = (b: Uint8Array) => new TextDecoder().decode(b);

describe("RPC framing", () => {
  it("frames with the UTF-8 byte length, not the character count", () => {
    const frame = text(encodeFrame({ method: "é", params: ["😀"] }));
    const body = JSON.stringify({ method: "é", params: ["😀"] });
    expect(frame).toBe(`Content-Length: ${new TextEncoder().encode(body).length}\r\n\r\n${body}`);
  });

  it("decodes frames split across chunks and several frames in one chunk", () => {
    const a = encodeFrame({ method: "a", params: [1] });
    const b = encodeFrame({ method: "b", params: ["ü"] });
    const all = new Uint8Array([...a, ...b]);
    const d = new FrameDecoder();
    const out: string[] = [];
    for (let i = 0; i < all.length; i += 3) out.push(...d.push(all.subarray(i, i + 3)));
    expect(out.map((m) => JSON.parse(m).method)).toEqual(["a", "b"]);
  });

  it("skips garbage headers and resynchronises", () => {
    const d = new FrameDecoder();
    const bad = new TextEncoder().encode("hello from console.log\r\n\r\n");
    const out = d.push(new Uint8Array([...bad, ...encodeFrame({ method: "ok", params: [] })]));
    expect(out.map((m) => JSON.parse(m).method)).toEqual(["ok"]);
  });
});

/** Two connected peers. */
function pair() {
  let a!: RpcConnection;
  let b!: RpcConnection;
  // Through JSON, like the real transports.
  a = new RpcConnection((m: RpcMessage) => queueMicrotask(() => b.handleMessage(JSON.stringify(m))));
  b = new RpcConnection((m: RpcMessage) => queueMicrotask(() => a.handleMessage(JSON.stringify(m))));
  return { a, b };
}

describe("RpcConnection", () => {
  it("answers requests, reports errors and unknown methods", async () => {
    const { a, b } = pair();
    b.register("add", ([x, y]) => (x as number) + (y as number));
    b.register("fail", () => {
      throw new TypeError("nope");
    });
    expect(await a.request("add", [2, 3])).toBe(5);
    await expect(a.request("fail")).rejects.toMatchObject({ message: "nope", name: "TypeError" });
    await expect(a.request("missing")).rejects.toThrow("Unknown method 'missing'");
  });

  it("delivers notifications and supports async handlers", async () => {
    const { a, b } = pair();
    const seen: unknown[] = [];
    b.register("note", (p) => void seen.push(p));
    b.register("slow", async () => new Promise((r) => setTimeout(() => r("done"), 5)));
    a.notify("note", [1, "x"]);
    expect(await a.request("slow")).toBe("done");
    expect(seen).toEqual([[1, "x"]]);
  });

  it("cancels a request on both sides", async () => {
    const { a, b } = pair();
    let cancelled = false;
    b.register("wait", (_p, token) => new Promise((r) => token.onCancel(() => ((cancelled = true), r(null)))));
    const listeners: (() => void)[] = [];
    const token = { isCancellationRequested: false, onCancellationRequested: (fn: () => void) => listeners.push(fn) };
    const p = a.request("wait", [], token);
    await new Promise((r) => setTimeout(r, 5));
    token.isCancellationRequested = true;
    listeners.forEach((l) => l());
    await expect(p).rejects.toMatchObject({ code: "Canceled" });
    await new Promise((r) => setTimeout(r, 5));
    expect(cancelled).toBe(true);
  });

  it("fails pending requests when the peer goes away", async () => {
    const { a } = pair();
    const p = a.request("never");
    a.close();
    await expect(p).rejects.toMatchObject({ code: "Closed" });
    await expect(a.request("x")).rejects.toMatchObject({ code: "Closed" });
  });
});
