import { useState } from "react";
import { completeness, detectLanguage, ruleCard } from "@tmcode/protocol";
import { recordActivity } from "../../activity/log";
import { getPlatform, openFile } from "../../state/store";
import { Codicon } from "../../widgets/icons";
import { replyLanguage } from "../actions";
import { asAiError, chat, checkPromptProblem, useAi, type InterpreterStatus } from "../service";
import { useAiGate } from "../gate";
import { isStudent } from "./state";
import { RequestMeter } from "./IntentPanel";

/**
 * A Prompt Problem (prompt interpreter report, Q11; Prather et al., CHI 2024): the student sees
 * input → output examples and describes the program in their own words, in any language. The AI
 * writes the program from that request ALONE (it never sees the examples), Task Mentor runs it
 * against the shown examples and the teacher's hidden ones, and the student refines the request
 * until it passes. It practises exactly what novices lack: saying precisely what a program does.
 */

type Problem = NonNullable<InterpreterStatus["prompt_problem"]>;
type Result = Awaited<ReturnType<typeof checkPromptProblem>>;

/** The code block of an answer (or the whole answer when it has none). */
export function codeOf(answer: string): string {
  const m = /```[\w+-]*\n([\s\S]*?)```/.exec(answer);
  return (m ? m[1] : answer).replace(/\s+$/, "") + "\n";
}

/** Asks the AI to write the entry file from the student's request only. */
export function generateFromRequest(request: string, p: Problem): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const lang = replyLanguage();
    void chat(
      [{ role: "user", content: request }],
      { purpose: "prompt-problem", task: `File: ${p.entry} (${p.language}). Write the complete file from the student's request.`, ...(lang ? { reply_language: lang } : {}) },
      { meta() {}, delta: (t) => (text += t), done: () => resolve(text), error: reject },
    ).catch(reject);
  });
}

export function PromptProblemPanel() {
  const p = useAi((s) => s.status?.interpreter?.prompt_problem ?? null);
  const showPrompts = useAi((s) => !!s.status?.interpreter?.show_prompts);
  const gate = useAiGate();
  const [open, setOpen] = useState(true);
  const [request, setRequest] = useState("");
  const [phase, setPhase] = useState<"idle" | "writing" | "checking" | "done" | "error">("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [best, setBest] = useState<number | null>(null);
  const [showCode, setShowCode] = useState(false);
  if (!p || gate.layer !== "industrial" || !gate.chat) return null;
  const busy = phase === "writing" || phase === "checking";

  const run = async () => {
    const words = request.trim();
    if (!words || busy) return;
    setPhase("writing");
    setError(null);
    const attempt = attempts + 1;
    setAttempts(attempt);
    try {
      const generated = codeOf(await generateFromRequest(words, p));
      setCode(generated);
      await getPlatform().fs.writeFile(p.entry, generated).catch(() => undefined);
      setPhase("checking");
      const r = await checkPromptProblem(generated);
      setResult(r);
      setBest((b) => Math.max(b ?? 0, r.passed));
      setPhase("done");
      const c = completeness(ruleCard(words));
      recordActivity({
        kind: "ai",
        action: "prompt-problem",
        path: p.entry,
        text: `Prompt Problem attempt ${attempt}: ${r.passed}/${r.total} examples passed${r.hidden.total ? ` (${r.hidden.passed}/${r.hidden.total} hidden)` : ""}`,
        data: { passed: r.passed, total: r.total, hidden_passed: r.hidden.passed, hidden_total: r.hidden.total, attempt, completeness: c.score, language: detectLanguage(words), ...(showPrompts || !isStudent() ? { request: words.slice(0, 500) } : {}) },
        actor: { type: "you" },
        ai: { by: "TMCode AI", how: "wrote the Prompt Problem's code from the student's request" },
      });
    } catch (e) {
      setError(asAiError(e).message);
      setPhase("error");
    }
  };

  const solved = !!result && result.passed === result.total;
  return (
    <section className={`tm-pp ${solved ? "is-solved" : ""}`} data-testid="prompt-problem" aria-label="Prompt Problem">
      <button type="button" className="tm-pp-head" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="prompt-problem-toggle">
        <Codicon name={solved ? "pass-filled" : "mortar-board"} />
        <span className="tm-pp-title">Prompt Problem</span>
        <span className="tm-intent-sub">describe the program; the AI writes it from your words only</span>
        <span className="tm-intent-spacer" />
        {best !== null && result && (
          <span className={`tm-intent-pill ${solved ? "is-conf-high" : ""}`} data-testid="prompt-problem-score">
            {best}/{result.total}
          </span>
        )}
        <Codicon name={open ? "chevron-up" : "chevron-down"} />
      </button>
      {open && (
        <div className="tm-pp-body">
          {p.instructions && <p className="tm-pp-instructions">{p.instructions}</p>}
          <div className="tm-pp-examples" role="table" aria-label="Examples">
            {p.examples.map((e, i) => {
              const r = result?.shown[i];
              return (
                <div key={i} className={`tm-pp-row ${r ? (r.passed ? "is-pass" : "is-fail") : ""}`} role="row" data-testid="prompt-problem-example">
                  <code role="cell">{e.input}</code>
                  <Codicon name="arrow-right" />
                  <code role="cell">{e.output}</code>
                  {r && (
                    <span className="tm-pp-got" role="cell" title={r.passed ? "Passed" : `Your program gave ${r.got || "nothing"}`}>
                      <Codicon name={r.passed ? "pass-filled" : "error"} /> {r.passed ? "" : r.got || "—"}
                    </span>
                  )}
                </div>
              );
            })}
            {p.hidden_count > 0 && (
              <div className="tm-pp-row is-hidden" data-testid="prompt-problem-hidden">
                <Codicon name="eye-closed" /> {result ? `${result.hidden.passed}/${result.hidden.total} hidden examples passed` : `+ ${p.hidden_count} hidden example${p.hidden_count === 1 ? "" : "s"} your teacher will check`}
              </div>
            )}
          </div>
          <textarea
            className="tm-input tm-pp-input"
            rows={3}
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void run();
              }
            }}
            placeholder="Describe the program in your own words (any language): what it gets, what it gives back, unusual cases…"
            aria-label="Your request"
            data-testid="prompt-problem-input"
          />
          {p.hints && <RequestMeter text={request} mentions={0} />}
          <div className="tm-intent-foot">
            {attempts > 0 && <span className="tm-intent-sub">Attempt {attempts}</span>}
            {solved && (
              <span className="tm-intent-turn is-done" data-testid="prompt-problem-solved">
                <Codicon name="pass-filled" /> Solved: your words said it all
              </span>
            )}
            <span className="tm-intent-spacer" />
            {code && (
              <button type="button" className="tm-chat-btn is-quiet" onClick={() => setShowCode(!showCode)} aria-expanded={showCode} data-testid="prompt-problem-show-code">
                {showCode ? "Hide" : "Show"} the AI's code
              </button>
            )}
            {code && (
              <button type="button" className="tm-chat-btn is-quiet" onClick={() => openFile(p.entry, { pinned: true })}>
                Open {p.entry}
              </button>
            )}
            <button type="button" className="tm-chat-btn is-primary" onClick={() => void run()} disabled={!request.trim() || busy} data-testid="prompt-problem-run" title="⌘/Ctrl+Enter">
              <Codicon name={busy ? "loading" : "play"} className={busy ? "codicon-modifier-spin" : ""} /> {phase === "writing" ? "AI is writing…" : phase === "checking" ? "Checking…" : attempts ? "Try again" : "Write & check"}
            </button>
          </div>
          {error && (
            <div className="tm-intent-banner is-error" role="alert" data-testid="prompt-problem-error">
              <Codicon name="warning" /> {error}
            </div>
          )}
          {result?.error && (
            <div className="tm-intent-banner is-error" data-testid="prompt-problem-run-error">
              <Codicon name="warning" /> The program didn't run: {result.error.slice(0, 300)}
            </div>
          )}
          {showCode && code && <pre className="tm-pp-code" data-testid="prompt-problem-code">{code}</pre>}
          {result && !solved && <p className="tm-intent-sub">Look at what your program gave: which part of your request could the AI have read differently? Add it in your words, then try again.</p>}
        </div>
      )}
    </section>
  );
}
