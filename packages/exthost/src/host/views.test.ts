import { describe, expect, it } from "vitest";
import { decodeWebviewMessage, encodeWebviewMessage } from "./views";

describe("webview messages", () => {
  it("carry typed arrays and ArrayBuffers over JSON", () => {
    const msg = { rpc: true, payload: new Uint8Array([123, 34, 0, 255]), list: [new Float32Array([1.5]), "x"], buf: new Uint8Array([7, 8]).buffer, n: 3 };
    const wire = JSON.parse(JSON.stringify(encodeWebviewMessage(msg)));
    expect(wire.payload).toEqual({ $$tmbuf: "eyIA/w==", t: "Uint8Array" });
    const back = decodeWebviewMessage(wire) as typeof msg;
    expect(back.payload).toBeInstanceOf(Uint8Array);
    expect([...back.payload]).toEqual([123, 34, 0, 255]);
    expect(back.list[0]).toBeInstanceOf(Float32Array);
    expect([...(back.list[0] as Float32Array)]).toEqual([1.5]);
    expect(new Uint8Array(back.buf)).toEqual(new Uint8Array([7, 8]));
    expect(back.n).toBe(3);
  });

  it("leaves plain JSON alone", () => {
    const msg = { command: "loadRepos", repos: { "/a": { columnWidths: null } }, list: [1, "two", false] };
    expect(decodeWebviewMessage(JSON.parse(JSON.stringify(encodeWebviewMessage(msg))))).toEqual(msg);
  });
});
