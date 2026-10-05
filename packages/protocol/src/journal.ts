/**
 * Tamper-evident snapshot chain (plan §13, docs/PROTOCOL.md §4).
 *
 *   key        = HMAC-SHA256(key = base64decode(journal_nonce), msg = "tmcode-journal-v1:" + session_id)
 *   files_hash = SHA-256 hex of JSON.stringify(files sorted by path as [[path, content], ...])
 *   hmac_n     = HMAC-SHA256(key, `${hmac_{n-1}}|${seq}|${question_id}|${kind}|${files_hash}|${client_ts}`)  (hex; hmac_0 = "")
 *
 * Task Mentor recomputes the chain on every upload; an edited or deleted
 * record breaks it. Uses WebCrypto, so it runs in the webview and in Node ≥ 20.
 */

export interface SnapshotFile {
  path: string;
  content: string;
}

export interface ChainRecord {
  seq: number;
  question_id: number;
  kind: "auto" | "run" | "final" | "offline_final";
  files_hash: string;
  client_ts: string;
}

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

function hex(buf: ArrayBuffer) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(keyBytes: Uint8Array, message: string) {
  const key = await subtle().importKey("raw", keyBytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", key, enc.encode(message)));
}

export function canonicalFiles(files: SnapshotFile[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify(sorted.map((f) => [f.path, f.content]));
}

export async function filesHash(files: SnapshotFile[]): Promise<string> {
  return hex(await subtle().digest("SHA-256", enc.encode(canonicalFiles(files))));
}

export async function journalKey(journalNonceB64: string, sessionId: string): Promise<Uint8Array> {
  return hmac(base64ToBytes(journalNonceB64), `tmcode-journal-v1:${sessionId}`);
}

export function chainMessage(prevHmac: string, r: ChainRecord) {
  return `${prevHmac}|${r.seq}|${r.question_id}|${r.kind}|${r.files_hash}|${r.client_ts}`;
}

export async function chainHmac(key: Uint8Array, prevHmac: string, r: ChainRecord): Promise<string> {
  const mac = await hmac(key, chainMessage(prevHmac, r));
  return hex(mac.buffer as ArrayBuffer);
}

/** Verifies a whole chain (records in seq order); returns the first bad seq or null. */
export async function verifyChain(key: Uint8Array, records: (ChainRecord & { hmac: string })[]): Promise<number | null> {
  let prev = "";
  for (const r of records) {
    if ((await chainHmac(key, prev, r)) !== r.hmac) return r.seq;
    prev = r.hmac;
  }
  return null;
}
