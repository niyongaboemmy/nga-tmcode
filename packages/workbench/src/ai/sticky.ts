import { layerOf, StickyLayerClaimsSchema, StickyLayerTokenSchema, type StickyLayerToken } from "@tmcode/protocol";
import type { StickyLayer } from "./layerState";

/**
 * The sticky signed assignment layer (proposal §8.7, A9): Task Mentor signs { project, ai_mode,
 * own_tools, exp } with Ed25519 and TMCode keeps it in the project's `.tmcode/layer.json`, so
 * signing out never raises an assignment's layer. A file that fails the check counts as no file
 * (the folder is treated as unlinked) and the evidence says so. Task Mentor may rotate keys: each
 * has a `kid`, and old public keys stay here until their tokens have expired.
 */

export const LAYER_FILE = ".tmcode/layer.json";

/** Task Mentor's public keys (SPKI DER, base64) by kid. */
export const LAYER_PUBLIC_KEYS: Record<string, string> = {
  k1: "MCowBQYDK2VwAyEAdjoHcsvLbY6ULMlfq8iACPgu9EUORhwP6109Y31IpYA=",
};

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const fromB64url = (s: string) => fromB64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));

export type StickyCheck = { ok: true; sticky: StickyLayer } | { ok: false; why: "malformed" | "signature" | "project" | "expired" | "unsupported" };

/** Checks a token for the open project (by its Task Mentor id). */
export async function verifySticky(raw: unknown, projectId: number | null, keys: Record<string, string> = LAYER_PUBLIC_KEYS, now = Date.now()): Promise<StickyCheck> {
  const t = StickyLayerTokenSchema.safeParse(raw);
  if (!t.success) return { ok: false, why: "malformed" };
  let claims;
  try {
    claims = StickyLayerClaimsSchema.safeParse(JSON.parse(new TextDecoder().decode(fromB64url(t.data.claims))));
  } catch {
    return { ok: false, why: "malformed" };
  }
  if (!claims.success) return { ok: false, why: "malformed" };
  const c = claims.data;
  const pub = keys[c.kid];
  if (!pub) return { ok: false, why: "signature" };
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return { ok: false, why: "unsupported" };
  let valid = false;
  try {
    const key = await subtle.importKey("spki", fromB64(pub), { name: "Ed25519" }, false, ["verify"]);
    valid = await subtle.verify({ name: "Ed25519" }, key, fromB64url(t.data.sig), new TextEncoder().encode(t.data.claims));
  } catch {
    // An engine without Ed25519 in WebCrypto: can't check, so the file can't count.
    return { ok: false, why: "unsupported" };
  }
  if (!valid) return { ok: false, why: "signature" };
  if (projectId !== null && c.project_id !== projectId) return { ok: false, why: "project" };
  if (Date.parse(c.exp) <= now) return { ok: false, why: "expired" };
  return { ok: true, sticky: { layer: layerOf(c.ai_mode), ownTools: c.own_tools, projectId: c.project_id, exp: c.exp } };
}

export function stickyFileText(token: StickyLayerToken): string {
  return `${JSON.stringify({ about: "TMCode: the AI layer your teacher set for this assignment, signed by Task Mentor. Editing it makes it invalid.", ...token }, null, 2)}\n`;
}
