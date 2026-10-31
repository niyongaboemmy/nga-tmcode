import { basename } from "../util/paths";

/**
 * Files attached to a TMCode AI question, as in Claude Code: picked with the
 * paperclip, dropped on the chat, pasted (copied files, screenshots) or long
 * pasted text. Text goes along with the question like an @-mention; images
 * go to models that can read them (Phase 2 of the modernization plan).
 */

export const ATTACH_LIMITS = {
  /** Attachments per question. */
  count: 5,
  /** Characters sent per attachment, and for all of them together. */
  chars: 30_000,
  totalChars: 90_000,
  /** Pasted text longer than this becomes a "Pasted text" chip instead of filling the box. */
  pasteChars: 2_000,
  imageBytes: 10 * 1024 * 1024,
};

export interface Attachment {
  id: string;
  name: string;
  /** Bytes (pasted text: characters). */
  size: number;
  kind: "file" | "pasted" | "image";
  text?: string;
  /** The file is longer than what is sent. */
  truncated?: boolean;
  /** data: URL of an image. */
  image?: string;
  /** Where it came from: an absolute path, a workspace path, or "" (pasted). */
  origin: string;
}

/** A file as the desktop reads it (src-tauri/src/ai_attach.rs). */
export interface AttachedFile {
  path: string;
  name: string;
  size: number;
  text: string | null;
  truncated: boolean;
  image: { mime: string; base64: string } | null;
}

let seq = 0;
const nextId = () => `att-${++seq}`;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A text attachment, cut to the per-file limit. */
export function textAttachment(name: string, text: string, size: number, origin: string, truncated = false): Attachment {
  const cut = text.length > ATTACH_LIMITS.chars;
  return { id: nextId(), name, size, kind: "file", text: cut ? text.slice(0, ATTACH_LIMITS.chars) : text, truncated: truncated || cut, origin };
}

export function imageAttachment(name: string, dataUrl: string, size: number, origin: string): Attachment {
  return { id: nextId(), name, size, kind: "image", image: dataUrl, origin };
}

/** Long pasted text: one chip, numbered ("Pasted text #2"). */
export function pastedAttachment(text: string, existing: readonly Attachment[]): Attachment {
  const n = existing.filter((a) => a.kind === "pasted").length + 1;
  const a = textAttachment(`Pasted text #${n}`, text, text.length, "");
  return { ...a, kind: "pasted" };
}

/** The desktop's read → an attachment, or why it can't be one. */
export function fromAttachedFile(f: AttachedFile): Attachment | string {
  if (f.image) {
    if (f.size > ATTACH_LIMITS.imageBytes) return `${f.name} is larger than 10 MB.`;
    return imageAttachment(f.name, `data:${f.image.mime};base64,${f.image.base64}`, f.size, f.path);
  }
  if (f.text === null) return `${f.name} is not a text file. TMCode AI can read code, text and images.`;
  return textAttachment(f.name, f.text, f.size, f.path, f.truncated);
}

/** FileReader, which every WebView (and the test DOM) has. */
function readBlob(blob: Blob, as: "text"): Promise<string>;
function readBlob(blob: Blob, as: "dataUrl"): Promise<string>;
function readBlob(blob: Blob, as: "buffer"): Promise<ArrayBuffer>;
function readBlob(blob: Blob, as: "text" | "dataUrl" | "buffer"): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string | ArrayBuffer);
    r.onerror = () => reject(r.error);
    if (as === "text") r.readAsText(blob);
    else if (as === "dataUrl") r.readAsDataURL(blob);
    else r.readAsArrayBuffer(blob);
  });
}

/** A browser File (drop, paste, the file input). */
export async function fromBrowserFile(file: File): Promise<Attachment | string> {
  const name = file.name || (file.type.startsWith("image/") ? `image.${file.type.split("/")[1] ?? "png"}` : "file");
  if (IMAGE_TYPES.has(file.type)) {
    if (file.size > ATTACH_LIMITS.imageBytes) return `${name} is larger than 10 MB.`;
    return imageAttachment(name, await readBlob(file, "dataUrl"), file.size, "");
  }
  const head = new Uint8Array(await readBlob(file.slice(0, 8192), "buffer"));
  if (head.includes(0)) return `${name} is not a text file. TMCode AI can read code, text and images.`;
  const text = await readBlob(file.slice(0, ATTACH_LIMITS.chars * 4), "text");
  return textAttachment(name, text, file.size, "", file.size > ATTACH_LIMITS.chars * 4);
}

/** Adds what fits; the rest come back as reasons. The same file is not attached twice. */
export function addAttachments(list: readonly Attachment[], more: (Attachment | string)[]): { list: Attachment[]; errors: string[] } {
  const out = [...list];
  const errors: string[] = [];
  for (const a of more) {
    if (typeof a === "string") {
      errors.push(a);
      continue;
    }
    if (a.origin && out.some((x) => x.origin === a.origin)) continue;
    if (out.length >= ATTACH_LIMITS.count) {
      errors.push(`You can attach up to ${ATTACH_LIMITS.count} files to one question.`);
      continue;
    }
    out.push(a);
  }
  return { list: out, errors: [...new Set(errors)] };
}

/** The text attachments as they go to the AI (with the question's context, like @-mentions). */
export function attachmentText(list: readonly Attachment[]): string {
  let left = ATTACH_LIMITS.totalChars;
  const parts: string[] = [];
  for (const a of list) {
    if (a.kind === "image" || !a.text || left <= 0) continue;
    const text = a.text.slice(0, left);
    left -= text.length;
    const cut = a.truncated || text.length < a.text.length ? " (only the start: the rest was cut)" : "";
    const label = a.kind === "pasted" ? `${a.name}${cut}` : `Attached file ${a.origin && !a.origin.startsWith("/") && !/^[A-Za-z]:\\/.test(a.origin) ? a.origin : basename(a.name)}${cut}`;
    parts.push(`${label}:\n\`\`\`\n${text}\n\`\`\``);
  }
  return parts.join("\n\n");
}

/** Chips on the sent question. */
export function attachmentChips(list: readonly Attachment[]): string[] {
  return list.map((a) => a.name);
}
