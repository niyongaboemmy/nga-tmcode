import { useEffect, useMemo, useRef, useState } from "react";
import { completeness, ruleCard, type CoachResult, type CompletenessItem, type IntentCard, type IntentExample } from "@tmcode/protocol";
import { Codicon } from "../../widgets/icons";
import { backToEditing, confirmCard, dismissChecklist, editCard, saveCardAsPlan, saveExamplesAsTests, sendAsIs, studentContributed, useIntent, type Pending } from "./state";

/**
 * The request check above the prompt box (prompt interpreter report, Q3/Q6/Q7): the intent card
 * (full, hints or a one-line summary), Learning's prompt coach, a notice, or the check loading.
 * Keyboard first: Enter confirms, Esc goes back to editing, ⌘/Ctrl+Enter sends the words as typed.
 */

const LANG: Record<string, string> = { en: "English", fr: "Français", rw: "Kinyarwanda", "rw+en": "Kinyarwanda + English", "rw+fr": "Kinyarwanda + Français", "fr+en": "Français + English", other: "Other" };
const CONF: Record<IntentCard["confidence"], { label: string; icon: string }> = { high: { label: "Sure", icon: "pass-filled" }, medium: { label: "Fairly sure", icon: "circle-large-outline" }, low: { label: "Not sure", icon: "question" } };
const ITEM: Record<CompletenessItem, { label: string; icon: string; hint: string }> = {
  goal: { label: "Goal", icon: "target", hint: "What it should do, in one sentence" },
  inputs: { label: "Input", icon: "arrow-right", hint: "What goes in (typed, a list, a file…)" },
  outputs: { label: "Output", icon: "output", hint: "What comes out or is shown" },
  example: { label: "Example", icon: "symbol-event", hint: "This input → this result" },
  edge_case: { label: "Unusual case", icon: "warning", hint: "Empty, wrong or very large input" },
  target: { label: "File", icon: "file-code", hint: "Which file or function (@ adds one)" },
};
const isMod = (e: React.KeyboardEvent) => e.metaKey || e.ctrlKey;
const inField = (e: React.KeyboardEvent) => /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);

export function IntentPanel() {
  const p = useIntent((s) => s.pending);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (p?.status === "ready" || p?.status === "notice" || p?.status === "failed") ref.current?.focus({ preventScroll: true });
  }, [p?.id, p?.status]);
  if (!p) return null;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      backToEditing();
    } else if (e.key === "Enter" && isMod(e)) {
      e.preventDefault();
      sendAsIs();
    } else if (e.key === "Enter" && !e.shiftKey && !inField(e) && p.status === "ready" && p.card && canConfirm(p)) {
      e.preventDefault();
      confirmCard();
    }
  };
  return (
    <div ref={ref} tabIndex={-1} className={`tm-intent is-${p.status} is-${p.decision.kind} is-stage-${p.decision.stage}`} onKeyDown={onKey} data-testid="intent-panel" data-status={p.status} data-stage={p.decision.stage} role="region" aria-label="What TMCode understood">
      {p.status === "loading" && <Loading p={p} />}
      {p.status === "notice" && <Notice p={p} />}
      {p.status === "failed" && <Failed p={p} />}
      {p.status === "ready" && p.coach && <Coach p={p} coach={p.coach} />}
      {p.status === "ready" && p.card && (p.decision.stage === "strip" ? <Strip p={p} card={p.card} /> : p.decision.stage === "hint" ? <Hints p={p} card={p.card} /> : <FullCard p={p} card={p.card} />)}
    </div>
  );
}

const canConfirm = (p: Pending) => !p.decision.mustFill || studentContributed(p.card, p.received);

function Loading({ p }: { p: Pending }) {
  return (
    <div className="tm-intent-loading" data-testid="intent-loading" aria-live="polite">
      <div className="tm-intent-head">
        <Codicon name="sparkle" className="tm-intent-spark" />
        <span className="tm-intent-title">{p.decision.kind === "coach" ? "Reading your question…" : "Checking what you mean…"}</span>
        <span className="tm-intent-spacer" />
        <button type="button" className="tm-chat-btn" onClick={sendAsIs} data-testid="intent-skip" title="Send your words now (⌘/Ctrl+Enter)">
          Skip
        </button>
      </div>
      <div className="tm-intent-skeleton" aria-hidden>
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function Notice({ p }: { p: Pending }) {
  return (
    <div className="tm-intent-notice" data-testid="intent-notice">
      <div className="tm-intent-head">
        <Codicon name="info" />
        <span className="tm-intent-message">{p.message}</span>
      </div>
      <div className="tm-intent-foot">
        <button type="button" className="tm-chat-btn is-primary" onClick={backToEditing} data-testid="intent-back">
          Edit my words
        </button>
        <button type="button" className="tm-chat-btn" onClick={sendAsIs} data-testid="intent-as-is">
          Send anyway
        </button>
      </div>
    </div>
  );
}

function Failed({ p }: { p: Pending }) {
  return (
    <div className="tm-intent-notice is-failed" data-testid="intent-failed">
      <div className="tm-intent-head">
        <Codicon name="warning" />
        <span className="tm-intent-message">{p.message}</span>
      </div>
      <div className="tm-intent-foot">
        <button type="button" className="tm-chat-btn is-primary" onClick={sendAsIs} data-testid="intent-as-is">
          Send my words
        </button>
        <button type="button" className="tm-chat-btn" onClick={backToEditing} data-testid="intent-back">
          Edit my words
        </button>
      </div>
    </div>
  );
}

function Head({ p, card, title }: { p: Pending; card: IntentCard; title: string }) {
  const c = CONF[card.confidence];
  return (
    <div className="tm-intent-head">
      <Codicon name="sparkle" className="tm-intent-spark" />
      <span className="tm-intent-title">{title}</span>
      <span className="tm-intent-pill" title="The language TMCode read" data-testid="intent-language">
        <Codicon name="globe" /> {LANG[card.language] ?? card.language}
      </span>
      <span className={`tm-intent-pill is-conf-${card.confidence}`} title={p.agreed === false ? "Two readings differed: please choose" : "How sure TMCode is"} data-testid="intent-confidence">
        <Codicon name={c.icon} /> {c.label}
      </span>
      <span className="tm-intent-spacer" />
      {p.meta && (
        <span className="tm-intent-meta" title={`${p.meta.provider} · ${p.meta.model} · ${(p.meta.ms / 1000).toFixed(1)} s`}>
          {(p.meta.ms / 1000).toFixed(1)} s
        </span>
      )}
      <button type="button" className="tm-chat-icon" onClick={backToEditing} title="Back to my words (Esc)" aria-label="Back to my words" data-testid="intent-close">
        <Codicon name="close" />
      </button>
    </div>
  );
}

function Foot({ p, confirmLabel = "Yes, do this" }: { p: Pending; confirmLabel?: string }) {
  const [more, setMore] = useState(false);
  const ok = canConfirm(p);
  const testable = p.card?.examples.some((e) => e.verdict === "yes");
  return (
    <div className="tm-intent-foot">
      {p.decision.mustFill && (
        <span className={`tm-intent-turn ${ok ? "is-done" : ""}`} data-testid="intent-your-turn" title="Say one thing yourself: an example result or an unusual case">
          <Codicon name={ok ? "pass-filled" : "edit"} /> {ok ? "Nice: you added your part" : "Your turn: fill in one example or add an unusual case"}
        </span>
      )}
      <span className="tm-intent-spacer" />
      <div className="tm-intent-actions">
        <button type="button" className="tm-chat-btn is-primary" onClick={confirmCard} disabled={!ok} data-testid="intent-confirm" title="Enter">
          <Codicon name="check" /> {confirmLabel}
        </button>
        <button type="button" className="tm-chat-btn" onClick={backToEditing} data-testid="intent-back" title="Esc">
          Edit my words
        </button>
        <button type="button" className="tm-chat-btn is-quiet" onClick={sendAsIs} data-testid="intent-as-is" title="⌘/Ctrl+Enter">
          As typed
        </button>
        <div className="tm-intent-more">
          <button type="button" className="tm-chat-icon" onClick={() => setMore(!more)} aria-haspopup="menu" aria-expanded={more} aria-label="More" data-testid="intent-more">
            <Codicon name="ellipsis" />
          </button>
          {more && (
            <div className="tm-intent-menu" role="menu" onMouseLeave={() => setMore(false)}>
              <button type="button" role="menuitem" onClick={() => (setMore(false), void saveCardAsPlan())} data-testid="intent-save-plan">
                <Codicon name="list-ordered" /> Save as plan
              </button>
              <button type="button" role="menuitem" onClick={() => (setMore(false), void saveExamplesAsTests())} disabled={!testable} data-testid="intent-save-tests" title={testable ? "Write the ✓ examples as a test file" : "Tick ✓ an example first"}>
                <Codicon name="beaker" /> Save ✓ examples as tests
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Added({ why, guided }: { why?: string; guided: boolean }) {
  return (
    <span className="tm-intent-added" title={why ? `Added by TMCode: ${why}` : "Added by TMCode"}>
      <Codicon name="sparkle" />
      {guided && why ? <span className="tm-intent-why">{why}</span> : null}
    </span>
  );
}

function Inline({ value, placeholder, onChange, testid, multiline, label }: { value: string; placeholder: string; onChange: (v: string) => void; testid: string; multiline?: boolean; label: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => v !== value && onChange(v.trim());
  return multiline ? (
    <textarea className="tm-intent-input is-multi" rows={2} value={v} placeholder={placeholder} aria-label={label} onChange={(e) => setV(e.target.value)} onBlur={commit} data-testid={testid} />
  ) : (
    <input className="tm-intent-input" value={v} placeholder={placeholder} aria-label={label} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), commit(), (e.target as HTMLInputElement).blur())} data-testid={testid} />
  );
}

function Adder({ placeholder, onAdd, testid, label }: { placeholder: string; onAdd: (v: string) => void; testid: string; label: string }) {
  const [v, setV] = useState("");
  return (
    <form
      className="tm-intent-adder"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onAdd(v.trim());
        setV("");
      }}
    >
      <Codicon name="add" />
      <input className="tm-intent-input" value={v} placeholder={placeholder} aria-label={label} onChange={(e) => setV(e.target.value)} data-testid={testid} />
    </form>
  );
}

function ExampleRow({ e, i, guided }: { e: IntentExample; i: number; guided: boolean }) {
  const set = (patch: Partial<IntentExample>, field = "examples") => editCard(field, (c) => ({ ...c, examples: c.examples.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  return (
    <div className={`tm-intent-example is-${e.verdict ?? "open"}`} data-testid="intent-example">
      <code className="tm-intent-in">{e.input}</code>
      <Codicon name="arrow-right" className="tm-intent-arrow" />
      <input
        className={`tm-intent-input tm-intent-out ${e.output ? "" : "is-blank"}`}
        defaultValue={e.output}
        placeholder="you decide"
        aria-label={`Result for ${e.input}`}
        onBlur={(ev) => ev.target.value.trim() !== e.output && set({ output: ev.target.value.trim(), verdict: ev.target.value.trim() ? "yes" : e.verdict })}
        data-testid="intent-example-output"
      />
      {e.by === "ai" && <Added why={e.why} guided={guided} />}
      <span className="tm-intent-verdict" role="group" aria-label="Is this right?">
        <button type="button" className={e.verdict === "yes" ? "is-on" : ""} aria-pressed={e.verdict === "yes"} onClick={() => set({ verdict: e.verdict === "yes" ? null : "yes" })} title="Yes, this is right" data-testid="intent-example-yes">
          <Codicon name="check" />
        </button>
        <button type="button" className={e.verdict === "no" ? "is-on is-no" : ""} aria-pressed={e.verdict === "no"} onClick={() => set({ verdict: e.verdict === "no" ? null : "no" })} title="No, not this" data-testid="intent-example-no">
          <Codicon name="close" />
        </button>
      </span>
    </div>
  );
}

function FullCard({ p, card }: { p: Pending; card: IntentCard }) {
  const guided = p.decision.mustFill;
  const [forAi, setForAi] = useState(false);
  return (
    <div className="tm-intent-card" data-testid="intent-card">
      <Head p={p} card={card} title="Here's what I understood" />
      {p.diffNote && (
        <div className="tm-intent-banner" data-testid="intent-diff">
          <Codicon name="history" /> {p.diffNote}
        </div>
      )}
      <p className="tm-intent-restated" data-testid="intent-restated">
        {card.restated}
      </p>
      {!!card.glossary.length && (
        <div className="tm-intent-glossary" data-testid="intent-glossary" aria-label="Words in English">
          {card.glossary.map((g) => (
            <span key={g.term} className="tm-intent-gloss">
              <em>{g.term}</em> <Codicon name="arrow-right" /> <strong>{g.en}</strong>
            </span>
          ))}
        </div>
      )}
      {!!card.open_questions.length && (
        <div className="tm-intent-section is-questions">
          {card.open_questions.map((q, qi) => (
            <div key={q.id} className="tm-intent-question" data-testid="intent-question">
              <span className="tm-intent-q">
                <Codicon name="question" /> {q.text}
              </span>
              <div className="tm-intent-choices">
                {q.choices.map((c) => (
                  <button key={c} type="button" className={`tm-intent-choice ${q.answer === c ? "is-on" : ""}`} aria-pressed={q.answer === c} onClick={() => editCard("answers", (x) => ({ ...x, open_questions: x.open_questions.map((y, j) => (j === qi ? { ...y, answer: y.answer === c ? null : c } : y)) }))} data-testid="intent-choice">
                    {c}
                  </button>
                ))}
                <Adder label="Your own answer" placeholder="Other…" testid="intent-choice-other" onAdd={(v) => editCard("answers", (x) => ({ ...x, open_questions: x.open_questions.map((y, j) => (j === qi ? { ...y, answer: v } : y)) }))} />
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="tm-intent-grid">
        {(card.inputs || card.outputs) && (
          <div className="tm-intent-io">
            <label>
              <span>In</span>
              <Inline label="What goes in" value={card.inputs} placeholder="what goes in" onChange={(v) => editCard("inputs", (c) => ({ ...c, inputs: v }))} testid="intent-inputs" />
            </label>
            <label>
              <span>Out</span>
              <Inline label="What comes out" value={card.outputs} placeholder="what comes out" onChange={(v) => editCard("outputs", (c) => ({ ...c, outputs: v }))} testid="intent-outputs" />
            </label>
          </div>
        )}
        <div className="tm-intent-section">
          <div className="tm-intent-label">
            <Codicon name="symbol-event" /> Examples <span className="tm-intent-sub">tick ✓ what's right</span>
          </div>
          {card.examples.map((e, i) => (
            <ExampleRow key={`${e.input}-${i}`} e={e} i={i} guided={guided} />
          ))}
          <ExampleAdder />
        </div>
        <div className="tm-intent-section">
          <div className="tm-intent-label">
            <Codicon name="warning" /> Unusual cases
          </div>
          <div className="tm-intent-chips">
            {card.edge_cases.map((x, i) => (
              <span key={`${x.text}-${i}`} className={`tm-intent-chip ${x.by === "ai" ? "is-ai" : ""}`} data-testid="intent-edge">
                {x.text}
                {x.by === "ai" && <Added why={x.why} guided={guided} />}
                <button type="button" aria-label={`Remove ${x.text}`} onClick={() => editCard("edge_cases", (c) => ({ ...c, edge_cases: c.edge_cases.filter((_, j) => j !== i) }))}>
                  <Codicon name="close" />
                </button>
              </span>
            ))}
            <Adder label="Add an unusual case" placeholder="add one (empty input…)" testid="intent-edge-add" onAdd={(v) => editCard("edge_cases", (c) => ({ ...c, edge_cases: [...c.edge_cases, { text: v, by: "you" as const }].slice(0, 6) }))} />
          </div>
        </div>
        {!!card.targets.length && (
          <div className="tm-intent-section">
            <div className="tm-intent-label">
              <Codicon name="file-code" /> Files
            </div>
            <div className="tm-intent-chips">
              {card.targets.map((t) => (
                <span key={t} className="tm-intent-chip is-file" data-testid="intent-target">
                  {t.slice(t.lastIndexOf("/") + 1)}
                  <button type="button" aria-label={`Not ${t}`} onClick={() => editCard("targets", (c) => ({ ...c, targets: c.targets.filter((x) => x !== t) }))}>
                    <Codicon name="close" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
        {!!card.requirements.length && (
          <div className="tm-intent-section">
            <div className="tm-intent-label">
              <Codicon name="quote" /> You asked for
            </div>
            <ul className="tm-intent-reqs">
              {card.requirements.map((r, i) => (
                <li key={i} data-testid="intent-requirement">
                  <span className="tm-intent-quote">“{r.quote ?? r.text}”</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!!card.assumptions.length && (
          <div className="tm-intent-section">
            <div className="tm-intent-label">
              <Codicon name="lightbulb" /> I assumed <span className="tm-intent-sub">click to remove</span>
            </div>
            <div className="tm-intent-chips">
              {card.assumptions.map((a, i) => (
                <button
                  key={`${a.text}-${i}`}
                  type="button"
                  className={`tm-intent-chip is-assumption ${a.keep === false ? "is-removed" : ""}`}
                  aria-pressed={a.keep !== false}
                  title={a.why ?? "TMCode inferred this; keep it only if you want it"}
                  onClick={() => editCard("assumptions", (c) => ({ ...c, assumptions: c.assumptions.map((x, j) => (j === i ? { ...x, keep: x.keep === false } : x)) }))}
                  data-testid="intent-assumption"
                >
                  <Codicon name={a.keep === false ? "circle-slash" : "check"} /> {a.text}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <button type="button" className="tm-intent-forai" onClick={() => setForAi(!forAi)} aria-expanded={forAi} data-testid="intent-for-ai">
        <Codicon name={forAi ? "chevron-down" : "chevron-right"} /> What the AI gets {card.language !== "en" ? "(in English)" : ""}
      </button>
      {forAi && <Inline multiline label="The goal in English for the AI" value={card.spec_en} placeholder="The goal for the AI" onChange={(v) => v && editCard("spec", (c) => ({ ...c, spec_en: v }))} testid="intent-spec" />}
      <Foot p={p} />
    </div>
  );
}

function ExampleAdder() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const add = () => {
    if (!input.trim()) return;
    editCard("examples", (c) => ({ ...c, examples: [...c.examples, { input: input.trim(), output: output.trim(), verdict: (output.trim() ? "yes" : null) as IntentExample["verdict"], by: "you" as const }].slice(0, 6) }));
    setInput("");
    setOutput("");
  };
  return (
    <form
      className="tm-intent-example is-new"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <input className="tm-intent-input tm-intent-in" value={input} onChange={(e) => setInput(e.target.value)} placeholder="+ your example" aria-label="Example input" data-testid="intent-example-add-input" />
      <Codicon name="arrow-right" className="tm-intent-arrow" />
      <input className="tm-intent-input tm-intent-out" value={output} onChange={(e) => setOutput(e.target.value)} placeholder="result" aria-label="Example result" data-testid="intent-example-add-output" onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} />
      <button type="submit" className="tm-chat-icon" aria-label="Add example" disabled={!input.trim()} data-testid="intent-example-add">
        <Codicon name="add" />
      </button>
    </form>
  );
}

/** Hint mode (Guided, faded once): only what's missing is flagged; the student fills it in. */
function Hints({ p, card }: { p: Pending; card: IntentCard }) {
  const c = completeness(card, p.mentions);
  const [open, setOpen] = useState<CompletenessItem | null>(null);
  const fill = (item: CompletenessItem, v: string) => {
    if (item === "example") {
      const [i, o] = v.split(/\s*(?:->|→|=>)\s*/);
      editCard("examples", (x) => ({ ...x, examples: [...x.examples, { input: i, output: o ?? "", verdict: (o ? "yes" : null) as IntentExample["verdict"], by: "you" as const }] }));
    } else if (item === "edge_case") editCard("edge_cases", (x) => ({ ...x, edge_cases: [...x.edge_cases, { text: v, by: "you" as const }] }));
    else if (item === "inputs") editCard("inputs", (x) => ({ ...x, inputs: v }));
    else if (item === "outputs") editCard("outputs", (x) => ({ ...x, outputs: v }));
    else if (item === "target") editCard("targets", (x) => ({ ...x, targets: [...x.targets, v] }));
    else editCard("spec", (x) => ({ ...x, spec_en: `${x.spec_en} ${v}` }));
    setOpen(null);
  };
  return (
    <div className="tm-intent-card is-hints" data-testid="intent-hints">
      <Head p={p} card={card} title="Almost there" />
      {p.diffNote && (
        <div className="tm-intent-banner" data-testid="intent-diff">
          <Codicon name="history" /> {p.diffNote}
        </div>
      )}
      <p className="tm-intent-restated">{card.restated}</p>
      {c.missing.length ? (
        <>
          <div className="tm-intent-label">
            <Codicon name="checklist" /> Your request doesn't say yet
          </div>
          <div className="tm-intent-chips">
            {c.missing.map((m) => (
              <button key={m} type="button" className={`tm-intent-chip is-missing ${open === m ? "is-on" : ""}`} onClick={() => setOpen(open === m ? null : m)} title={ITEM[m].hint} data-testid="intent-missing">
                <Codicon name={ITEM[m].icon} /> {ITEM[m].label}
              </button>
            ))}
          </div>
          {open && <Adder label={ITEM[open].hint} placeholder={open === "example" ? "input → result" : ITEM[open].hint} testid="intent-missing-fill" onAdd={(v) => fill(open, v)} />}
        </>
      ) : (
        <p className="tm-intent-sub">
          <Codicon name="pass-filled" /> Your request says it all.
        </p>
      )}
      <Foot p={p} />
    </div>
  );
}

/** The one-line summary (faded, or a clear request). */
function Strip({ card }: { p: Pending; card: IntentCard }) {
  return (
    <div className="tm-intent-strip" data-testid="intent-strip">
      <Codicon name="sparkle" className="tm-intent-spark" />
      <span className="tm-intent-strip-text">
        <span className="tm-intent-sub">Understood as</span> {card.restated}
      </span>
      <button type="button" className="tm-chat-btn is-primary" onClick={confirmCard} data-testid="intent-confirm" title="Enter">
        Do it
      </button>
      <button type="button" className="tm-chat-btn" onClick={backToEditing} data-testid="intent-back" title="Esc">
        Change
      </button>
    </div>
  );
}

/** The student's request with each piece marked by what it tells the AI (Learning's coach). */
function Segments({ text, coach }: { text: string; coach: CoachResult }) {
  const parts = useMemo(() => {
    const marks: { from: number; to: number; kind: string; note?: string }[] = [];
    const lower = text.toLowerCase();
    for (const s of coach.segments) {
      const at = lower.indexOf(s.text.toLowerCase());
      if (at >= 0 && !marks.some((m) => at < m.to && at + s.text.length > m.from)) marks.push({ from: at, to: at + s.text.length, kind: s.kind, note: s.note });
    }
    marks.sort((a, b) => a.from - b.from);
    const out: { text: string; kind?: string; note?: string }[] = [];
    let i = 0;
    for (const m of marks) {
      if (m.from > i) out.push({ text: text.slice(i, m.from) });
      out.push({ text: text.slice(m.from, m.to), kind: m.kind, note: m.note });
      i = m.to;
    }
    if (i < text.length) out.push({ text: text.slice(i) });
    return out;
  }, [text, coach]);
  return (
    <p className="tm-coach-text" data-testid="coach-text">
      {parts.map((x, i) =>
        x.kind ? (
          <mark key={i} className={`tm-coach-seg is-${x.kind}`} title={x.note ?? x.kind} data-testid="coach-segment">
            {x.text}
          </mark>
        ) : (
          <span key={i}>{x.text}</span>
        ),
      )}
    </p>
  );
}

/** Learning's prompt coach: what's missing, as questions; the student rewrites (never a rewrite from TMCode). */
function Coach({ p, coach }: { p: Pending; coach: CoachResult }) {
  return (
    <div className="tm-coach" data-testid="coach-panel">
      <div className="tm-intent-head">
        <Codicon name="lightbulb" className="tm-intent-spark" />
        <span className="tm-intent-title">Before you ask the tutor</span>
        <span className="tm-intent-spacer" />
        <button type="button" className="tm-chat-icon" onClick={backToEditing} title="Back to my question (Esc)" aria-label="Back to my question" data-testid="intent-close">
          <Codicon name="close" />
        </button>
      </div>
      <Segments text={p.text} coach={coach} />
      {coach.praise && (
        <p className="tm-coach-praise">
          <Codicon name="star-full" /> {coach.praise}
        </p>
      )}
      {!!coach.missing.length && (
        <ul className="tm-coach-missing">
          {coach.missing.map((m) => (
            <li key={m.id} data-testid="coach-missing">
              <span className="tm-coach-item">{m.label}</span>
              <span className="tm-coach-q">{m.question}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="tm-intent-foot">
        <span className="tm-intent-sub">Add what's missing in your own words: the tutor understands you better.</span>
        <span className="tm-intent-spacer" />
        <div className="tm-intent-actions">
          <button type="button" className="tm-chat-btn is-primary" onClick={backToEditing} data-testid="coach-improve">
            <Codicon name="edit" /> Improve my question
          </button>
          <button type="button" className="tm-chat-btn" onClick={sendAsIs} data-testid="coach-ask-anyway">
            Ask as it is
          </button>
        </div>
      </div>
    </div>
  );
}

/** While the student rewrites (Learning): the coach's checklist ticks itself as the request improves. */
export function CoachChecklist({ text }: { text: string }) {
  const coach = useIntent((s) => s.checklist);
  if (!coach || !coach.missing.length) return null;
  const have = completeness(ruleCard(text)).have as string[];
  const done = coach.missing.filter((m) => have.includes(m.id)).length;
  return (
    <div className="tm-coach-checklist" data-testid="coach-checklist">
      <Codicon name="checklist" />
      {coach.missing.map((m) => (
        <span key={m.id} className={`tm-coach-tick ${have.includes(m.id) ? "is-done" : ""}`} title={m.question} data-testid="coach-tick">
          <Codicon name={have.includes(m.id) ? "pass-filled" : "circle-large-outline"} /> {m.label}
        </span>
      ))}
      <span className="tm-intent-spacer" />
      <span className="tm-intent-sub">
        {done}/{coach.missing.length}
      </span>
      <button type="button" className="tm-chat-icon" onClick={dismissChecklist} aria-label="Hide the checklist">
        <Codicon name="close" />
      </button>
    </div>
  );
}

/** A live meter under the prompt box (students): which of the six items the request says so far. */
export function RequestMeter({ text, mentions }: { text: string; mentions: number }) {
  const c = useMemo(() => completeness(ruleCard(text), mentions), [text, mentions]);
  if (text.trim().length < 12) return null;
  return (
    <div className="tm-request-meter" data-testid="request-meter" aria-label={`Your request says ${c.have.length} of 6 things`}>
      {(Object.keys(ITEM) as CompletenessItem[]).map((k) => (
        <span key={k} className={`tm-request-dot ${c.have.includes(k) ? "is-on" : ""}`} title={`${ITEM[k].label}: ${c.have.includes(k) ? "said" : ITEM[k].hint}`} data-testid="request-dot" data-on={c.have.includes(k) ? "1" : "0"}>
          <Codicon name={ITEM[k].icon} />
        </span>
      ))}
      <span className="tm-request-score">{c.have.length}/6</span>
    </div>
  );
}

/** A small note when a request went through unchecked (the interpreter never blocks). */
export function IntentNote() {
  const note = useIntent((s) => s.note);
  if (!note) return null;
  return (
    <div className="tm-intent-note" data-testid="intent-note" role="status">
      <Codicon name="info" /> {note}
      <button type="button" className="tm-chat-icon" onClick={() => useIntent.setState({ note: null })} aria-label="Dismiss">
        <Codicon name="close" />
      </button>
    </div>
  );
}
