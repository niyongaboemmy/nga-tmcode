import { useEffect, useId, useRef, useState } from "react";
import { useAiGate } from "../ai/gate";
import { modeLabel, useAi } from "../ai/service";
import { openSpecialEditor, type ContextMenuItem } from "../state/store";
import { Codicon } from "../widgets/icons";
import { copyGradingPrompt, gradeWithCli, GRADING_CLIS, type GradingCli } from "./aiCli";
import { discardAiDraft, requestAiDraft, stopWatching, useAiGrading, type AiDraftMeta } from "./aiGrading";
import type { Draft } from "./drafts";
import type { RosterRow } from "./service";

/**
 * The grade panel's AI parts: "Draft with AI" (a prompt box, then Task Mentor's AI drafts), the
 * banner while an AI draft waits for the teacher (who drafted it, how sure, notes for the teacher,
 * Discard), the "AI" marks on what is still the AI's, and the AI tools in More Actions.
 */

/** Is criterion i's score / comment still the AI's (not edited by the teacher)? */
export function aiMarks(meta: AiDraftMeta | undefined, draft: Draft) {
  return {
    score: (i: number) => !!meta && meta.scores[i] != null && draft.scores[i] === meta.scores[i],
    comment: (i: number) => !!meta && !!meta.comments[i] && draft.comments[i] === meta.comments[i],
    final: !!meta && meta.score != null && draft.score === meta.score,
    feedback: !!meta && !!meta.feedback && draft.feedback === meta.feedback,
  };
}

export function AiTag({ title = "Drafted by AI: still as the AI wrote it" }: { title?: string }) {
  return (
    <span className="tm-ai-tag" title={title} data-testid="ai-tag">
      <Codicon name="sparkle" /> AI
    </span>
  );
}

const CONF: Record<string, string> = { low: "low confidence", medium: "medium confidence", high: "high confidence" };

/** "AI draft by Claude Code · medium confidence · notes · Discard", or "Claude Code is grading Ben… watching for its draft". */
export function AiDraftBanner({ dkey, studentName }: { dkey: string; studentName: string }) {
  const meta = useAiGrading((s) => s.meta[dkey]);
  const watching = useAiGrading((s) => s.watching[dkey]);
  const drafting = useAiGrading((s) => !!s.drafting[dkey]);
  if (drafting) {
    return (
      <div className="tm-grade-ai-banner is-working" role="status" data-testid="grade-ai-working">
        <Codicon name="loading" className="codicon-modifier-spin" />
        <span>TMCode AI is reading {studentName}'s work and the rubric…</span>
      </div>
    );
  }
  if (watching && !meta) {
    return (
      <div className="tm-grade-ai-banner is-working" role="status" data-testid="grade-ai-watching">
        <Codicon name="loading" className="codicon-modifier-spin" />
        <span>
          {watching.tool} is grading {watching.student}… watching for its draft
        </span>
        <button type="button" className="tm-link-button" onClick={() => stopWatching(dkey)}>
          Stop Watching
        </button>
      </div>
    );
  }
  if (!meta) return null;
  const notes = [...meta.warnings, ...meta.notes];
  return (
    <div className="tm-grade-ai-banner" role="region" aria-label="AI draft" tabIndex={-1} data-testid="grade-ai-banner">
      <div className="tm-grade-ai-head">
        <Codicon name="sparkle" />
        <span className="tm-grade-ai-title">
          AI draft by <b>{meta.by}</b>
          {meta.confidence && <span className={`tm-grade-ai-conf is-${meta.confidence}`}> · {CONF[meta.confidence]}</span>}
        </span>
        <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => discardAiDraft(dkey)} data-testid="grade-ai-discard" title="Put the form back as it was before the AI's draft">
          Discard AI Draft
        </button>
      </div>
      <p className="tm-grade-ai-hint">Review and adjust it, then Save. Nothing is saved or shown to {studentName} until you do.</p>
      {meta.teacher_notes && (
        <details className="tm-grade-ai-notes" open data-testid="grade-ai-notes">
          <summary>Notes for you</summary>
          <p>{meta.teacher_notes}</p>
        </details>
      )}
      {notes.length > 0 && (
        <ul className="tm-grade-ai-warnings" data-testid="grade-ai-warnings">
          {notes.map((n, i) => (
            <li key={i}>
              <Codicon name="warning" /> {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** "Draft with AI": what to focus on, the model in use, then a draft in the form. */
export function AiDraftBox({ gkey, row, dkey, onClose }: { gkey: string; row: RosterRow; dkey: string; onClose: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<{ code: string; error: string } | null>(null);
  const drafting = useAiGrading((s) => !!s.drafting[dkey]);
  const mode = useAi((s) => s.mode);
  const status = useAi((s) => s.status);
  const ids = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const run = async () => {
    setError(null);
    const r = await requestAiDraft(gkey, row, prompt);
    if (r.ok) onClose();
    else setError(r);
  };
  return (
    <div className="tm-grade-ai-box" role="group" aria-labelledby={`${ids}-l`} data-testid="grade-ai-box">
      <label id={`${ids}-l`} htmlFor={`${ids}-p`}>
        <Codicon name="sparkle" /> Draft {row.student?.name ?? "this student"}'s grade with AI
      </label>
      <textarea
        id={`${ids}-p`}
        ref={ref}
        className="tm-input"
        rows={2}
        maxLength={4000}
        placeholder="Tell the AI what to focus on (optional), e.g. “check input validation”"
        value={prompt}
        disabled={drafting}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void run();
          } else if (e.key === "Escape") onClose();
        }}
        data-testid="grade-ai-prompt"
      />
      <p className="tm-muted tm-grade-ai-model">
        Uses {modeLabel(mode, status)}.{" "}
        <button type="button" className="tm-link-button" onClick={() => void import("../ai/ChatView").then((m) => m.pickMode())} data-testid="grade-ai-model">
          Change
        </button>{" "}
        It drafts scores, comments and feedback; you review and Save.
      </p>
      {error && (
        <p className="tm-grade-inline-error" role="alert" data-testid="grade-ai-error">
          <Codicon name="error" /> {error.error}{" "}
          {(error.code === "BYOK_MISSING" || error.code === "BYOK_REJECTED") && (
            <button type="button" className="tm-link-button" onClick={() => openSpecialEditor("settings")}>
              Your API Keys
            </button>
          )}
          {error.code === "PREMIUM_REQUIRED" && (
            <button type="button" className="tm-link-button" onClick={() => void import("../ai/ChatView").then((m) => m.pickMode())}>
              Pick Another Model
            </button>
          )}
        </p>
      )}
      <div className="tm-grade-return-buttons">
        <button type="button" className="tm-button" disabled={drafting} onClick={() => void run()} data-testid="grade-ai-run">
          <Codicon name={drafting ? "loading" : "sparkle"} className={drafting ? "codicon-modifier-spin" : ""} /> {drafting ? "Drafting…" : "Draft"}
        </button>
        <button type="button" className="tm-button tm-button--secondary" onClick={onClose} disabled={drafting}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Can "Draft with AI" be offered (TMCode AI allowed here)? */
export function useCanDraftWithAi() {
  return useAiGate().chat;
}

/** More Actions: the AI tools (third-party: only where the school allows them for staff). */
export function aiMenuItems(opts: { loaded: boolean; thirdParty: boolean; canDraft: boolean; openBox: () => void }): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (opts.canDraft) items.push({ kind: "item", label: "Draft with AI…", run: opts.openBox });
  if (opts.thirdParty && opts.loaded) {
    for (const tool of ["claude", "gemini", "codex"] as GradingCli[]) items.push({ kind: "item", label: `Grade with ${GRADING_CLIS[tool].label}`, run: () => void gradeWithCli(tool) });
    items.push({ kind: "item", label: "Copy Grading Prompt", run: () => void copyGradingPrompt() });
  }
  return items.length ? [{ kind: "separator" }, ...items] : [];
}
