import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalFiles, chainHmac, filesHash, journalKey, verifyChain } from "./journal";

// Test vectors published in docs/PROTOCOL.md §4 (Task Mentor's implementation must match).
const NONCE = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const SESSION = "6b1f0f3e-5c55-4b7a-9d55-2d6f1d0a9e01";
const FILES = [
  { path: "main.py", content: "print(1)\n" },
  { path: "data/in.txt", content: "2 3\n" },
];

describe("journal chain", () => {
  it("hashes files canonically (order-independent)", async () => {
    expect(canonicalFiles(FILES)).toBe('[["data/in.txt","2 3\\n"],["main.py","print(1)\\n"]]');
    const h = await filesHash(FILES);
    expect(h).toBe(createHash("sha256").update(canonicalFiles(FILES)).digest("hex"));
    expect(await filesHash([...FILES].reverse())).toBe(h);
  });

  it("matches a plain Node implementation (what Task Mentor runs)", async () => {
    const key = await journalKey(NONCE, SESSION);
    const nodeKey = createHmac("sha256", Buffer.from(NONCE, "base64")).update(`tmcode-journal-v1:${SESSION}`).digest();
    expect(Buffer.from(key).toString("hex")).toBe(nodeKey.toString("hex"));

    const rec = { seq: 1, question_id: 42, kind: "auto" as const, files_hash: await filesHash(FILES), client_ts: "2026-10-05T10:00:00.000Z" };
    const mac = await chainHmac(key, "", rec);
    const nodeMac = createHmac("sha256", nodeKey).update(`|1|42|auto|${rec.files_hash}|${rec.client_ts}`).digest("hex");
    expect(mac).toBe(nodeMac);
  });

  it("detects an edited record", async () => {
    const key = await journalKey(NONCE, SESSION);
    const fh = await filesHash(FILES);
    const r1 = { seq: 1, question_id: 42, kind: "auto" as const, files_hash: fh, client_ts: "2026-10-05T10:00:00.000Z" };
    const h1 = await chainHmac(key, "", r1);
    const r2 = { seq: 2, question_id: 42, kind: "final" as const, files_hash: fh, client_ts: "2026-10-05T10:05:00.000Z" };
    const h2 = await chainHmac(key, h1, r2);
    expect(await verifyChain(key, [{ ...r1, hmac: h1 }, { ...r2, hmac: h2 }])).toBeNull();
    expect(await verifyChain(key, [{ ...r1, hmac: h1 }, { ...r2, client_ts: "2026-10-05T09:59:00.000Z", hmac: h2 }])).toBe(2);
  });
});
