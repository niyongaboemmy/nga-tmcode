import { getDocument } from "../../monaco/documents";
import { recordSave } from "../../history/localHistory";
import { getPlatform, log, notify } from "../../state/store";
import { buildRegExp, planReplace, type SearchOptions } from "./search";

/**
 * Replace in Files. Open files are edited in their editor (one undo step,
 * saved by Auto Save like any edit); other files are written straight away.
 * Either way Local History keeps the file as it was first, so every replace
 * can be undone from the Timeline.
 */

export interface ReplaceTarget {
  path: string;
  /** Only these matches ("line:start"); all matches in the file when absent. */
  only?: Set<string>;
}

/** The file's current text: the editor's (unsaved edits included) or the disk's. */
export async function currentText(path: string): Promise<string> {
  return getDocument(path)?.getValue() ?? (await getPlatform().fs.readFile(path));
}

/** Text of `path` after the replace, for the preview diff. */
export async function previewReplace(path: string, opts: SearchOptions, replacement: string, only?: Set<string>) {
  const re = buildRegExp(opts);
  const before = await currentText(path);
  if (typeof re === "string") return { before, after: before, count: 0 };
  const plan = planReplace(before, re, replacement, { regex: opts.regex, only });
  return { before, after: plan.text, count: plan.count };
}

export async function applyReplace(targets: ReplaceTarget[], opts: SearchOptions, replacement: string): Promise<{ files: number; count: number }> {
  const re = buildRegExp(opts);
  if (typeof re === "string") return { files: 0, count: 0 };
  const fs = getPlatform().fs;
  let files = 0;
  let count = 0;
  const failed: string[] = [];
  for (const t of targets) {
    try {
      const model = getDocument(t.path);
      const disk = await fs.readFile(t.path).catch(() => null);
      const before = model?.getValue() ?? disk;
      if (before === null) continue;
      const plan = planReplace(before, re, replacement, { regex: opts.regex, only: t.only });
      if (!plan.count) continue;
      // Local History first: the file as it is on disk, before anything changes.
      if (disk !== null) await recordSave(t.path, disk);
      if (model) {
        model.pushStackElement();
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: plan.text }], () => null);
        model.pushStackElement();
      } else {
        await fs.writeFile(t.path, plan.text);
        await recordSave(t.path, plan.text);
      }
      files++;
      count += plan.count;
    } catch (e) {
      failed.push(`${t.path}: ${String((e as Error)?.message ?? e)}`);
    }
  }
  log("Search", `Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`);
  if (failed.length) notify("error", `Could not replace in ${failed.length} file${failed.length === 1 ? "" : "s"}: ${failed.join("; ")}`);
  return { files, count };
}
