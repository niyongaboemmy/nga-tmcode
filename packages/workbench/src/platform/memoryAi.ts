import type { TmResponse, TmStreamEvent } from "./types";

/**
 * Task Mentor's TMCode AI (/api/tmcode/ai) for the browser build and e2e: answers are made up
 * from the question (deterministic), streamed in pieces as Server-Sent Events, with the same
 * allowance counting and error codes as the server. localStorage "tmcode:mock-ai-fail" =
 * "PROVIDER_QUOTA" makes Free answers fail as an exhausted OpenRouter pool would.
 */

const CHAT_LIMIT = 40;

export function memoryAi() {
  let used = 0;
  let completes = 0;
  let seq = 0;
  const jobs = new Map<string, { mode: string; question: string; context: Record<string, unknown> }>();

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
      if (path === "/chat" && method === "POST") {
        const messages = (body.messages as { role: string; content: string }[]) ?? [];
        const id = `job-${++seq}`;
        jobs.set(id, { mode: String(body.mode ?? "free"), question: messages[messages.length - 1]?.content ?? "", context: (body.context as Record<string, unknown>) ?? {} });
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
