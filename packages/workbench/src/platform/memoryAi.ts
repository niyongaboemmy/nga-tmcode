import { filterLearningText, identifiersOf } from "@tmcode/protocol";
import type { TmResponse, TmStreamEvent } from "./types";

/**
 * Task Mentor's TMCode AI (/api/tmcode/ai) for the browser build and e2e: answers are made up
 * from the question (deterministic), streamed in pieces as Server-Sent Events, with the same
 * allowance counting and error codes as the server. localStorage "tmcode:mock-ai-fail" =
 * "PROVIDER_QUOTA" makes Free answers fail as an exhausted OpenRouter pool would.
 * localStorage "tmcode:mock-ai-policy" = a JSON AI decision ({"allowed":false,"reason":"TEACHER_OFF",
 * "message":"…"}) makes the status carry it (AI usage control) and chat/complete answer 403 AI_DISABLED.
 * With "layer":"learning" it is a Task Mentor that knows the AI layers: the tutor answers, its code
 * is cut by the Learning filter (done.filtered), completions are refused (LAYER_LEARNING).
 * localStorage "tmcode:mock-ai-tiers" = {"premium":true,"byok":true,"staff":true} makes the status a
 * Task Mentor with premium AI and own keys (without it: an older one, free only). An own key "bad"
 * is refused (BYOK_REJECTED); `lastChatBody` on the returned object is the last /chat body.
 */

function mockTiers(): { premium?: boolean; byok?: boolean; staff?: boolean } | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem("tmcode:mock-ai-tiers") : null;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function mockPolicy(): { allowed: boolean; reason: string; message: string; thirdPartyExtensions?: boolean; layer?: string; mode?: string; own_tools?: boolean; staff?: boolean } | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem("tmcode:mock-ai-policy") : null;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const CHAT_LIMIT = 40;

export function memoryAi() {
  const lastChat: { body: Record<string, unknown> | null } = { body: null };
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
    // A teacher grading (context.purpose "grading"): read the task, then propose a grade.
    if (job.context.purpose === "grading") {
      if (!results.length) return call("get_grading_context", {});
      if (results.length === 1) {
        const ctx = JSON.parse(results[0].content ?? "{}") as { rubric?: { index: number; max_score: number }[] };
        return call("propose_grade", { rubric_scores: (ctx.rubric ?? []).map((c) => ({ index: c.index, score: c.max_score - 1, comment: `Mostly there (criterion ${c.index + 1}).` })), feedback: "Nice structure; handle empty input.", teacher_notes: "Run it with an empty item.", confidence: "high" });
      }
      return { text: "I put a draft in your grade form. Review it, then Save." };
    }
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
          { id: "openrouter/nvidia/nemotron-3-super-120b-a12b:free", label: "nvidia/nemotron-3-super-120b-a12b", provider: "openrouter", providerLabel: "OpenRouter (free models)", vision: false },
          { id: "openrouter/google/gemma-3-27b-it:free", label: "google/gemma-3-27b-it", provider: "openrouter", providerLabel: "OpenRouter (free models)", vision: true },
          { id: "groq/openai/gpt-oss-20b", label: "openai/gpt-oss-20b", provider: "groq", providerLabel: "Groq (free tier)", vision: false },
        ],
        you: { chat: { used, limit: CHAT_LIMIT }, complete: { used: completes, limit: 200 } },
        pools: { openrouter: { label: "OpenRouter (free models)", used: 4, limit: 50, remaining: 46 }, groq: { label: "Groq (free tier)", used: 0, limit: 1000, remaining: 1000 } },
        openrouter: { used: 4, limit: 50, remaining: 46 },
        ...(() => {
          const t = mockTiers();
          if (!t) return {};
          return {
            staff: !!t.staff,
            tiers: { free: true, premium: !!t.premium, byok: t.byok !== false },
            premium_models: t.premium ? [{ id: "premium:anthropic/claude-sonnet-4-5", label: "claude-sonnet-4-5", provider: "anthropic", providerLabel: "Anthropic (premium)" }, { id: "premium:openai/gpt-4.1", label: "gpt-4.1", provider: "openai", providerLabel: "OpenAI (premium)" }] : [],
            premium_you: t.premium ? { used: 3, limit: 50 } : null,
            byok_providers: [
              { id: "openai", label: "OpenAI", suggested_models: ["gpt-4.1-mini", "gpt-4.1"] },
              { id: "anthropic", label: "Anthropic", suggested_models: ["claude-sonnet-4-5"] },
              { id: "gemini", label: "Google Gemini", suggested_models: ["gemini-2.5-flash"] },
            ],
          };
        })(),
        ...(() => {
          const p = mockPolicy();
          if (!p) return {};
          const learning = p.layer === "learning";
          return {
            allowed: p.allowed,
            reason: p.reason,
            message: p.message,
            mode: p.mode ?? (learning ? "hints" : null),
            features: { assist: p.allowed, complete: p.allowed && !learning },
            thirdPartyExtensions: learning ? false : (p.thirdPartyExtensions ?? p.allowed),
            ...(p.layer ? { layer: p.layer, own_tools: !!p.own_tools } : {}),
            ...(p.staff !== undefined ? { staff: p.staff } : {}),
            ...(learning ? { learning: { strength: "tutor", pseudo: true, syntax: false, allowance: { max: 10, regain_minutes: 3, left: 10 - used, next_in_s: null } } } : {}),
          };
        })(),
      },
    };
  }

  /** The terminal's AI (context.purpose "terminal"): commands as Task Mentor's terminal prompt answers them. */
  function terminalAnswer(question: string): string {
    const json = (o: unknown) => JSON.stringify(o);
    const failed = /^\$ (.+)$/m.exec(question)?.[1];
    if (/This command failed/.test(question) && failed) {
      const fixed = failed.replace(/\btset\b/, "test").replace(/^gti\b/, "git");
      return json({ commands: [{ command: fixed, explanation: `Runs \`${fixed}\` (the command was misspelled).` }], explanation: `\`${failed}\` failed because of a typo: you meant \`${fixed}\`.`, risk: "safe" });
    }
    if (/Explain this command/.test(question) && failed) return json({ commands: [{ command: failed, explanation: "The command you ran." }], explanation: `\`${failed.split(/\s+/)[0]}\` is a program; the words after it are its arguments.`, risk: "safe" });
    if (/delete|remove|clean/i.test(question)) return json({ commands: [{ command: "rm -rf build", explanation: "Deletes the build folder and everything in it (-r: folders too, -f: without asking)." }], explanation: "This removes the build output; it is made again on the next build.", risk: "safe" });
    if (/big|large/i.test(question)) return `Here you go:\n\n\`\`\`bash\nfind . -type f -size +100M\n\`\`\`\n\nLists files over 100 MB (-type f: files only).`;
    if (/install/i.test(question)) return json({ commands: [{ command: "npm install", explanation: "Installs the packages in package.json." }], explanation: "Installs the project's packages.", risk: "caution" });
    return json({ commands: [{ command: "ls -la", explanation: "Lists all files (-a: hidden ones too) with details (-l)." }, { command: "git status", explanation: "Shows what changed." }], explanation: "Two ways to see what's in this folder.", risk: "safe" });
  }

  function answer(question: string, context: Record<string, unknown>): string {
    const seen = /\n\[(\d+) images?\]$/.exec(question);
    if (seen) return `I can see ${seen[1]} image${seen[1] === "1" ? "" : "s"}. The screenshot shows an error message on the page.`;
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
    lastChat,
    route(method: string, path: string, body: Record<string, unknown>): TmResponse {
      if (path === "/status" && method === "GET") return status();
      const policy = mockPolicy();
      if (policy && !policy.allowed && (path === "/chat" || path === "/complete")) return { status: 403, body: { code: "AI_DISABLED", reason: policy.reason, message: policy.message } };
      if (path === "/chat" && method === "POST") {
        lastChat.body = body;
        const mode = String(body.mode ?? "free");
        if (mode.startsWith("premium:") && !mockTiers()?.premium) return { status: 403, body: { code: "PREMIUM_REQUIRED", message: "Premium AI isn't turned on for your account." } };
        if (mode.startsWith("byok:") && (body.byok as { key?: string } | undefined)?.key === "bad") return { status: 400, body: { code: "BYOK_REJECTED", message: "The provider refused the key (401 Unauthorized)." } };
        const raw = (body.messages as { role: string; content: string | { type: string; text?: string }[] }[]) ?? [];
        // Questions with images (content parts): the text, and how many images came.
        const images = raw.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url").length : 0), 0);
        if (images && /^groq\/|nemotron/.test(mode)) return { status: 400, body: { code: "NO_VISION", message: "The AI available now can't read images." } };
        const messages = raw.map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.map((p) => p.text ?? "").join("") : m.content })) as { role: string; content: string }[];
        if (images) messages[messages.length - 1].content += `\n[${images} image${images === 1 ? "" : "s"}]`;
        const id = `job-${++seq}`;
        const agent = body.agent as { mode: string; step: number } | undefined;
        jobs.set(id, { mode: String(body.mode ?? "free"), question: messages.filter((m) => m.role === "user").pop()?.content ?? "", context: (body.context as Record<string, unknown>) ?? {}, agent, messages: messages as unknown as Wire[] });
        return { status: 201, body: { id } };
      }
      if (path === "/byok/verify" && method === "POST") {
        if (body.key === "bad") return { status: 400, body: { code: "BYOK_REJECTED", message: "OpenAI refused your API key: Incorrect API key provided." } };
        return { status: 200, body: { ok: true, provider: body.provider, model: body.model ?? "gpt-4.1-mini" } };
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
          // Learning: the tutor's words pass the filter; tools that change files never reach the app.
          if (mockPolicy()?.layer === "learning") {
            turn.text = filterLearningText(turn.text).text;
            turn.tool_calls = turn.tool_calls?.filter((c) => ["list_files", "read_file", "search", "get_problems", "repo_map", "find_symbol", "explore", "ask_user"].includes(c.function.name));
            if (!turn.tool_calls?.length) delete turn.tool_calls;
          }
          if (turn.text) send("delta", { text: turn.text });
          // Like Task Mentor: only an agent's first step is a question; the rest are agent steps.
          if (!job.agent.step) used++;
          send("done", { provider, model, you: { used, limit: CHAT_LIMIT }, ...(turn.tool_calls ? { tool_calls: turn.tool_calls } : {}) });
          return onEvent({ type: "end" });
        }
        let text = job.context.purpose === "terminal" ? terminalAnswer(job.question) : answer(job.question, job.context);
        // Learning (a Task Mentor that knows the layers): the answer passes the code filter.
        const learning = mockPolicy()?.layer === "learning";
        let removed = 0;
        if (learning) {
          const f = filterLearningText(text, { identifiers: identifiersOf(String(job.context.fileText ?? job.context.selection ?? "")) });
          text = f.text;
          removed = f.removed;
        }
        for (let i = 0; i < text.length && !cancelled; i += 12) {
          send("delta", { text: text.slice(i, i + 12) });
          await new Promise((r) => setTimeout(r, 8));
        }
        if (cancelled) return;
        used++;
        send("done", { provider, model, you: { used, limit: CHAT_LIMIT }, ...(learning ? { layer: "learning", filtered: { removed } } : {}) });
        onEvent({ type: "end" });
      })();
      return { cancel: () => (cancelled = true) };
    },
  };
}
