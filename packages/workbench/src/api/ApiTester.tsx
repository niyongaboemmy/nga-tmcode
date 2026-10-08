import { useEffect, useMemo, useState } from "react";
import { monaco } from "../monaco/setup";
import { revealInEditor } from "../monaco/reveal";
import { getPlatform } from "../state/store";
import { Codicon } from "../widgets/icons";
import { applyRoute, baseUrl, METHODS, scanRoutes, send, setDraft, useApi, type Method } from "./service";

const tone = (s: number) => (s >= 500 ? "error" : s >= 400 ? "warn" : s >= 300 ? "info" : "ok");
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function JsonView({ text }: { text: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return null;
    }
  }, [text]);
  useEffect(() => {
    let alive = true;
    if (pretty) void monaco.editor.colorize(pretty, "json", { tabSize: 2 }).then((h) => alive && setHtml(h));
    return () => {
      alive = false;
    };
  }, [pretty]);
  if (!pretty) return <pre className="tm-api-raw">{text}</pre>;
  return html ? <pre className="tm-api-raw tm-api-json" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="tm-api-raw">{pretty}</pre>;
}

/** Send requests to a running API and see its response (status, time, JSON, headers, page). */
export function ApiTester() {
  const draft = useApi((s) => s.draft);
  const response = useApi((s) => s.response);
  const error = useApi((s) => s.error);
  const sending = useApi((s) => s.sending);
  const routes = useApi((s) => s.routes);
  const history = useApi((s) => s.history);
  const [reqTab, setReqTab] = useState<"body" | "headers">("body");
  const [resTab, setResTab] = useState<"body" | "headers" | "preview">("body");
  const [side, setSide] = useState<"routes" | "history">("routes");
  const isHtml = !!response?.headers.find(([k, v]) => /^content-type$/i.test(k) && /html/i.test(v));
  const withBody = !["GET", "HEAD"].includes(draft.method);
  const mod = getPlatform().os === "mac" ? "⌘" : "Ctrl+";

  return (
    <div
      className="tm-api-page"
      data-testid="api-tester"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          void send();
        }
      }}
    >
      <aside className="tm-api-side">
        <div className="tm-api-side-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={side === "routes"} className={`tm-filter-chip ${side === "routes" ? "is-active" : ""}`} onClick={() => setSide("routes")}>
            Routes {routes ? <span>{routes.length}</span> : null}
          </button>
          <button type="button" role="tab" aria-selected={side === "history"} className={`tm-filter-chip ${side === "history" ? "is-active" : ""}`} onClick={() => setSide("history")}>
            History <span>{history.length}</span>
          </button>
          <button type="button" className="tm-action" title="Find the routes again" aria-label="Rescan routes" onClick={() => void scanRoutes()}>
            <Codicon name="refresh" />
          </button>
        </div>
        <div className="tm-api-side-list">
          {side === "routes" ? (
            routes === null ? (
              <p className="tm-muted">Looking for routes…</p>
            ) : routes.length === 0 ? (
              <p className="tm-muted">No routes found in this folder. Type a URL above.</p>
            ) : (
              routes.map((r, i) => (
                <div key={i} className="tm-api-route" role="button" tabIndex={0} data-testid="api-route" title={`${r.framework} · ${r.file}:${r.line}\nClick to fill the request; double-click to open the code`} onClick={() => applyRoute(r)} onDoubleClick={() => revealInEditor(r.file, r.line)} onKeyDown={(e) => e.key === "Enter" && applyRoute(r)}>
                  <span className={`tm-api-method is-${r.method.toLowerCase()}`}>{r.method}</span>
                  <span className="tm-project-name">{r.path}</span>
                </div>
              ))
            )
          ) : history.length === 0 ? (
            <p className="tm-muted">Requests you send appear here.</p>
          ) : (
            history.map((h, i) => (
              <div key={i} className="tm-api-route" role="button" tabIndex={0} title={h.url} onClick={() => setDraft({ method: h.method, url: h.url, headers: h.headers, body: h.body })}>
                <span className={`tm-api-method is-${h.method.toLowerCase()}`}>{h.method}</span>
                <span className="tm-project-name">{h.url.replace(/^https?:\/\/[^/]+/, "") || "/"}</span>
                {h.status !== null ? <span className={`tm-api-status is-${tone(h.status)}`}>{h.status}</span> : <Codicon name="error" />}
              </div>
            ))
          )}
        </div>
      </aside>

      <main className="tm-api-main">
        <form
          className="tm-api-bar"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <select className="tm-select tm-api-method-select" aria-label="Method" value={draft.method} onChange={(e) => setDraft({ method: e.target.value as Method })} data-testid="api-method">
            {METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <input className="tm-input tm-api-url" aria-label="URL" placeholder={`${baseUrl()}/api/…`} value={draft.url} onChange={(e) => setDraft({ url: e.target.value })} data-testid="api-url" spellCheck={false} />
          <button type="submit" className="tm-button" disabled={sending || !draft.url.trim()} title={`Send (${mod}Enter)`} data-testid="api-send">
            <Codicon name={sending ? "loading" : "send"} className={sending ? "codicon-modifier-spin" : ""} /> Send
          </button>
        </form>

        <div className="tm-api-section">
          <div className="tm-api-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={reqTab === "body"} className={reqTab === "body" ? "is-active" : ""} onClick={() => setReqTab("body")}>
              Body
            </button>
            <button type="button" role="tab" aria-selected={reqTab === "headers"} className={reqTab === "headers" ? "is-active" : ""} onClick={() => setReqTab("headers")}>
              Headers <small>{draft.headers.filter(([k]) => k).length}</small>
            </button>
            {reqTab === "body" && withBody && (
              <button
                type="button"
                className="tm-link-button tm-api-format"
                onClick={() => {
                  try {
                    setDraft({ body: JSON.stringify(JSON.parse(draft.body || "{}"), null, 2) });
                  } catch {
                    /* leave it: Send explains the JSON error */
                  }
                }}
              >
                Format JSON
              </button>
            )}
          </div>
          {reqTab === "body" ? (
            withBody ? (
              <textarea className="tm-input tm-api-body" rows={6} spellCheck={false} placeholder='{ "title": "Read a book" }' value={draft.body} onChange={(e) => setDraft({ body: e.target.value })} data-testid="api-body" />
            ) : (
              <p className="tm-muted tm-api-hint">{draft.method} requests have no body. Add query parameters to the URL (?page=2).</p>
            )
          ) : (
            <div className="tm-api-headers">
              {[...draft.headers, ["", ""] as [string, string]].map(([k, v], i) => (
                <div key={i} className="tm-api-header-row">
                  <input className="tm-input" placeholder="Header" aria-label={`Header ${i + 1} name`} value={k} onChange={(e) => setDraft({ headers: upsert(draft.headers, i, [e.target.value, v]) })} />
                  <input className="tm-input" placeholder="Value" aria-label={`Header ${i + 1} value`} value={v} onChange={(e) => setDraft({ headers: upsert(draft.headers, i, [k, e.target.value]) })} />
                  {i < draft.headers.length && (
                    <button type="button" className="tm-action" title="Remove this header" aria-label="Remove header" onClick={() => setDraft({ headers: draft.headers.filter((_, j) => j !== i) })}>
                      <Codicon name="close" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="tm-api-section tm-api-response" data-testid="api-response">
          {error ? (
            <div className="tm-api-error">
              <Codicon name="error" /> {error}
            </div>
          ) : !response ? (
            <p className="tm-muted tm-api-hint">
              Send a request to see the response here. Start your server with Run Project first ({mod}Shift+F10).
            </p>
          ) : (
            <>
              <div className="tm-api-meta">
                <span className={`tm-api-status is-${tone(response.status)}`} data-testid="api-status">
                  {response.status} {response.status_text}
                </span>
                <span>
                  <Codicon name="clock" /> {response.ms} ms
                </span>
                <span>
                  <Codicon name="file" /> {size(response.size)}
                  {response.truncated ? " (cut)" : ""}
                </span>
              </div>
              <div className="tm-api-tabs" role="tablist">
                {(["body", "headers", ...(isHtml ? ["preview"] : [])] as const).map((t) => (
                  <button key={t} type="button" role="tab" aria-selected={resTab === t} className={resTab === t ? "is-active" : ""} onClick={() => setResTab(t as typeof resTab)}>
                    {t === "body" ? "Body" : t === "headers" ? `Headers (${response.headers.length})` : "Preview"}
                  </button>
                ))}
              </div>
              {resTab === "headers" ? (
                <table className="tm-sql-table tm-api-header-table">
                  <tbody>
                    {response.headers.map(([k, v], i) => (
                      <tr key={i}>
                        <th>{k}</th>
                        <td>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : resTab === "preview" && isHtml ? (
                <iframe className="tm-api-preview" title="Response preview" sandbox="" srcDoc={response.body} />
              ) : response.binary ? (
                <p className="tm-muted tm-api-hint">Binary response ({size(response.size)}).</p>
              ) : (
                <JsonView text={response.body} />
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function upsert(list: [string, string][], i: number, v: [string, string]) {
  const out = [...list];
  if (i >= out.length) out.push(v);
  else out[i] = v;
  return out.filter(([k, val], j) => j === i || k || val);
}
