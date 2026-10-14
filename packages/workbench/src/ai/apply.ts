import { recordActivity, sizeText } from "../activity/log";
import { openDiffEditor } from "../exthost/mainThread";
import { ensureDocument } from "../monaco/documents";
import { codeEditorFor } from "../monaco/editors";
import { activeFilePath, closeEditors, notify, useWorkbench } from "../state/store";
import { registerLocalScheme } from "../util/virtual";

/**
 * Applying a TMCode AI answer to a file, as VS Code's chat does: the change opens as a diff (the
 * file now ↔ the AI's version, which can still be edited), and Accept puts it in the file as one
 * undoable edit; Reject drops it. Both are in the activity log.
 */

export const SCHEME = "tmcode-ai";
const proposals = new Map<string, { file: string; text: string; model: string }>();
let registered = false;

function ensureScheme() {
  if (registered) return;
  registered = true;
  registerLocalScheme(SCHEME, {
    read: async (path) => ({ text: proposals.get(path)?.text ?? "", readonly: false }),
    write: async (path, text) => {
      const p = proposals.get(path);
      if (p) p.text = text;
      return true;
    },
  });
}

export const proposalPath = (file: string) => `${SCHEME}:/${file}`;
export const isProposal = (path: string) => path.startsWith(`${SCHEME}:`);

/** Where a code block goes: the selection, the whole file (when it is one), or the cursor. */
export async function proposedText(file: string, code: string): Promise<string> {
  const model = await ensureDocument(file);
  const current = model.getValue();
  const ed = codeEditorFor(useWorkbench.getState().activeGroup);
  const sel = ed?.getModel() === model ? ed.getSelection() : null;
  const block = code.replace(/\n$/, "");
  if (sel && !sel.isEmpty()) {
    const start = model.getOffsetAt(sel.getStartPosition());
    const end = model.getOffsetAt(sel.getEndPosition());
    return current.slice(0, start) + block + current.slice(end);
  }
  // A whole file: the file is empty, or the block keeps most of the file's lines (a rewrite of it).
  if (!current.trim() || isWholeFile(current, block)) return block + (current.endsWith("\n") ? "\n" : "");
  const pos = ed?.getModel() === model ? ed.getPosition() : null;
  const at = pos ? model.getOffsetAt(pos) : current.length;
  return current.slice(0, at) + block + current.slice(at);
}

/** Opens the AI's version of `file` against the file as it is. */
export async function proposeEdit(file: string, code: string, model: string) {
  ensureScheme();
  const text = await proposedText(file, code);
  const path = proposalPath(file);
  proposals.set(path, { file, text, model });
  // A new proposal for the same file replaces the old one in its open diff.
  const { reloadVirtual } = await import("../monaco/documents");
  await reloadVirtual(path);
  openDiffEditor(file, path, `${file.slice(file.lastIndexOf("/") + 1)} ↔ TMCode AI's change`);
  recordActivity({ kind: "ai", action: "propose", path: file, text: `TMCode AI proposed a change to ${file.slice(file.lastIndexOf("/") + 1)}`, actor: { type: "tmcode-ai" }, ai: { by: "TMCode AI", how: "proposed a change (shown as a diff)", model } });
}

function closeDiffOf(path: string) {
  for (const g of useWorkbench.getState().groups) {
    const ids = g.editors.filter((e) => e.kind === "historyDiff" && e.path === path).map((e) => e.id);
    if (ids.length) void closeEditors(g.id, ids);
  }
}

export async function acceptProposal(path: string) {
  const p = proposals.get(path);
  if (!p) return;
  const { getDocument } = await import("../monaco/documents");
  // The diff's right side may have been edited: take its text.
  const text = getDocument(path)?.getValue() ?? p.text;
  const model = await ensureDocument(p.file);
  const before = model.getValue();
  model.pushStackElement();
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  model.pushStackElement();
  const changed = diffSize(before, text);
  recordActivity({
    kind: "ai",
    action: "apply",
    path: p.file,
    text: `Accepted TMCode AI's change to ${p.file.slice(p.file.lastIndexOf("/") + 1)} (${changed})`,
    data: { chars: Math.abs(text.length - before.length) },
    actor: { type: "tmcode-ai" },
    ai: { by: "TMCode AI", how: "chat answer applied to the file", model: p.model },
  });
  proposals.delete(path);
  closeDiffOf(path);
  notify("info", "TMCode AI's change is in the file. Undo (⌘Z) takes it back.", undefined, { kind: "hint" });
}

export function rejectProposal(path: string) {
  const p = proposals.get(path);
  if (!p) return;
  recordActivity({ kind: "ai", action: "reject", path: p.file, text: `Rejected TMCode AI's change to ${p.file.slice(p.file.lastIndexOf("/") + 1)}`, actor: { type: "you" }, ai: { by: "TMCode AI", how: "proposed change rejected", model: p.model } });
  proposals.delete(path);
  closeDiffOf(path);
}

/** Inserts code at the cursor of the active editor (one undoable edit). */
export function insertAtCursor(code: string, model: string) {
  const ed = codeEditorFor(useWorkbench.getState().activeGroup);
  const file = activeFilePath();
  if (!ed || !file) {
    notify("info", "Open a file and place the cursor where the code goes.");
    return false;
  }
  const sel = ed.getSelection()!;
  ed.pushUndoStop();
  ed.executeEdits("tmcode-ai", [{ range: sel, text: code.replace(/\n$/, ""), forceMoveMarkers: true }]);
  ed.pushUndoStop();
  ed.focus();
  recordActivity({ kind: "ai", action: "insert", path: file, text: `Inserted TMCode AI's code into ${file.slice(file.lastIndexOf("/") + 1)} (${sizeText(code)})`, data: { chars: code.length }, actor: { type: "tmcode-ai" }, ai: { by: "TMCode AI", how: "chat code inserted at the cursor", model } });
  return true;
}

/** Does `block` rewrite the whole file (most of its lines are there, and it isn't much shorter)? */
export function isWholeFile(current: string, block: string): boolean {
  const norm = (l: string) => l.trim();
  const fileLines = current.split("\n").map(norm).filter(Boolean);
  const blockLines = block.split("\n").map(norm).filter(Boolean);
  if (!fileLines.length) return true;
  if (blockLines.length < fileLines.length * 0.6) return false;
  const inBlock = new Set(blockLines);
  const kept = fileLines.filter((l) => inBlock.has(l)).length;
  // Changed lines don't count as kept, so a small file whose lines were all edited still counts
  // when the block is about as long as it.
  return kept / fileLines.length >= 0.4 || Math.abs(blockLines.length - fileLines.length) <= Math.max(1, fileLines.length * 0.2);
}

function diffSize(a: string, b: string) {
  const la = a.split("\n");
  const lb = b.split("\n");
  let same = 0;
  const seen = new Map<string, number>();
  for (const l of la) seen.set(l, (seen.get(l) ?? 0) + 1);
  for (const l of lb) {
    const n = seen.get(l) ?? 0;
    if (n > 0) {
      same++;
      seen.set(l, n - 1);
    }
  }
  const added = lb.length - same;
  const removed = la.length - same;
  return `+${added} −${removed} lines`;
}
