import type { TmResponse, TmStreamEvent } from "./types";

/**
 * Task Mentor's TMCode AI (/api/tmcode/ai) for the browser build and e2e: answers are made up
 * from the question (deterministic), streamed in pieces as Server-Sent Events, with the same
 * allowance counting and error codes as the server. localStorage "tmcode:mock-ai-fail" =
 * "PROVIDER_QUOTA" makes Free answers fail as an exhausted OpenRouter pool would.
 * localStorage "tmcode:mock-ai-policy" = a JSON AI decision ({"allowed":false,"reason":"TEACHER_OFF",
 * "message":"…"}) makes the status carry it (AI usage control) and chat/complete answer 403 AI_DISABLED.
 */

function mockPolicy(): { allowed: boolean; reason: string; message: string; thirdPartyExtensions?: boolean } | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem("tmcode:mock-ai-policy") : null;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const CHAT_LIMIT = 40;

export function memoryAi() {
  let used = 0;
  let completes = 0;
  let seq = 0;
  type Wire = { role: string; content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string };
  const jobs = new Map<string, { mode: string; question: string; context: Record<string, unknown>; agent?: { mode: string; step: number }; messages: Wire[] }>();
  let callSeq = 0;

  /**
   * A tiny deterministic agent: read the file, then (Plan) present a plan, or edit console.log →
   * console.info and summarise. Enough to drive every part of the agent UI.
   */
  function agentTurn(job: { context: Record<string, unknown>; agent: { mode: string }; messages: Wire[] }): { text: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] } {
    const calls = job.messages.flatMap((m) => m.tool_calls ?? []);
    const results = job.messages.filter((m) => m.role === "tool");
    const readCall = calls.find((c) => c.function.name === "read_file");
    const path = readCall ? String(JSON.parse(readCall.function.arguments).path) : String(job.context.file ?? "js/app.js");
    const call = (name: string, args: Record<string, unknown>) => ({ text: "", tool_calls: [{ id: `call_${++callSeq}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
    if (!results.length) return call("read_file", { path });
    const read = results[0].content ?? "";
    if (job.agent.mode === "plan") return { text: `Here is the plan for **${path}**:\n\n1. Replace \`console.log\` with \`console.info\` for messages.\n2. Keep everything else as it is.` };
    const last = results[results.length - 1].content ?? "";
    if (results.length === 1 && read.includes("console.log")) return call("edit_file", { path, old_text: "console.log", new_text: "console.info" });
    if (/declined/.test(last)) return { text: "Understood: I left the file as it was. What would you like instead?" };
    return { text: `I changed \`console.log\` to \`console.info\` in **${path}**.` };
  }

  function status(): TmResponse {
    return {
      status: 200,
      body: {
        enabled: true,
        exam: false,
        default_mode: "free",
        modes: [
          { id: "free", label: "Free (OpenRouter)", detail: "OpenRouter's free models. The school shares 50 of these requests a day." },
          { id: "auto", label: "Auto", detail: "Picks a free AI that still has requests left today." },
        ],
        models: [
          { id: "openrouter/nvidia/nemotron-3-super-120b-a12b:free", label: "nvidia/nemotron-3-super-120b-a12b", provider: "openrouter", providerLabel: "OpenRouter (free models)" },
          { id: "groq/openai/gpt-oss-20b", label: "openai/gpt-oss-20b", provider: "groq", providerLabel: "Groq (free tier)" },
        ],
        you: { chat: { used, limit: CHAT_LIMIT }, complete: { used: completes, limit: 200 } },
        pools: { openrouter: { label: "OpenRouter (free models)", used: 4, limit: 50, remaining: 46 }, groq: { label: "Groq (free tier)", used: 0, limit: 1000, remaining: 1000 } },
        openrouter: { used: 4, limit: 50, remaining: 46 },
        ...(() => {
          const p = mockPolicy();
          return p ? { allowed: p.allowed, reason: p.reason, message: p.message, mode: null, features: { assist: p.allowed, complete: p.allowed }, thirdPartyExtensions: p.thirdPartyExtensions ?? p.allowed } : {};
        })(),
      },
    };
  }

  function answer(question: string, context: Record<string, unknown>): string {
    const file = typeof context.file === "string" ? context.file : null;
    const name = file ? file.slice(file.lastIndexOf("/") + 1) : null;
    const code = typeof context.selection === "string" ? context.selection : typeof context.fileText === "string" ? context.fileText : "";
    if (/bug|fix/i.test(question) && code) {
      const fixed = code.replace(/console\.log/g, "console.info");
      return `There's one thing to fix in **${name}**: use \`console.info\` for messages.\n\n${name}:\n\`\`\`javascript\n${fixed.replace(/\n$/, "")}\n\`\`\`\n\nThis keeps the output the same and makes the intent clearer.`;
    }
    if (/explain/i.test(question)) return `This code${name ? ` in **${name}**` : ""} runs from top to bottom:\n\n1. It defines its values.\n2. It prints the result.\n\nNothing else happens.`;
    return `You asked: _${question}_\n\nHere is a small example:\n\n\`\`\`javascript\nconst greet = (name) => \`Hello, \${name}!\`;\n\`\`\``;
  }

  return {
    route(method: string, path: string, body: Record<string, unknown>): TmResponse {
      if (path === "/status" && method === "GET") return status();
      const policy = mockPolicy();
      if (policy && !policy.allowed && (path === "/chat" || path === "/complete")) return { status: 403, body: { code: "AI_DISABLED", reason: policy.reason, message: policy.message } };
      if (path === "/chat" && method === "POST") {
        const messages = (body.messages as { role: string; content: string }[]) ?? [];
        const id = `job-${++seq}`;
        const agent = body.agent as { mode: string; step: number } | undefined;
        jobs.set(id, { mode: String(body.mode ?? "free"), question: messages.filter((m) => m.role === "user").pop()?.content ?? "", context: (body.context as Record<string, unknown>) ?? {}, agent, messages: messages as unknown as Wire[] });
        return { status: 201, body: { id } };
      }
      if (path === "/complete" && method === "POST") {
        completes++;
        const prefix = String(body.prefix ?? "");
        if (/return\s*$/.test(prefix)) return { status: 200, body: { text: "a + b;", provider: "groq", model: "qwen/qwen3.8-27b" } };
        if (/function greet\($/.test(prefix)) return { status: 200, body: { text: "name) {\n  return `Hello, ${name}!`;\n}", provider: "groq", model: "qwen/qwen3.8-27b" } };
        return { status: 200, body: { text: null } };
      }
      return { status: 404, body: { error_code: "NOT_FOUND", message: "Not found" } };
    },
    stream(path: string, onEvent: (e: TmStreamEvent) => void) {
      const m = /^\/chat\/([^/]+)\/stream$/.exec(path);
      const job = m ? jobs.get(m[1]) : undefined;
      let cancelled = false;
      const send = (event: string, data: unknown) => onEvent({ type: "data", data: `event: ${event}\ndata: ${JSON.stringify(data)}\n\n` });
      void (async () => {
        await new Promise((r) => setTimeout(r, 30));
        onEvent({ type: "status", status: job ? 200 : 404 });
        if (!job) return onEvent({ type: "end" });
        jobs.delete(m![1]);
        const fail = (() => {
          try {
            return localStorage.getItem("tmcode:mock-ai-fail");
          } catch {
            return null;
          }
        })();
        if (fail && job.mode === "free") {
          send("error", { code: fail, message: "This model's free requests are used up for now. Switch to Auto: it picks a free AI that still has requests left." });
          return onEvent({ type: "end" });
        }
        const provider = job.mode === "auto" || job.mode.startsWith("groq/") ? "groq" : "openrouter";
        const model = provider === "groq" ? "openai/gpt-oss-20b" : "poolside/laguna-xs-2.1:free";
        send("meta", { provider, model });
        if (job.agent) {
          const turn = agentTurn(job as { context: Record<string, unknown>; agent: { mode: string }; messages: Wire[] });
          if (turn.text) send("delta", { text: turn.text });
          // Like Task Mentor: only an agent's first step is a question; the rest are agent steps.
          if (!job.agent.step) used++;
          send("done", { provider, model, you: { used, limit: CHAT_LIMIT }, ...(turn.tool_calls ? { tool_calls: turn.tool_calls } : {}) });
          return onEvent({ type: "end" });
        }
        const text = answer(job.question, job.context);
        for (let i = 0; i < text.length && !cancelled; i += 12) {
          send("delta", { text: text.slice(i, i + 12) });
          await new Promise((r) => setTimeout(r, 8));
        }
        if (cancelled) return;
        used++;
        send("done", { provider, model, you: { used, limit: CHAT_LIMIT } });
        onEvent({ type: "end" });
      })();
      return { cancel: () => (cancelled = true) };
    },
  };
}
