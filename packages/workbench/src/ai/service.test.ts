import { describe, expect, it } from "vitest";
import { AiRequestError, asAiError, sseParser } from "./service";

describe("asAiError", () => {
  it("never leaves an error without words", () => {
    expect(asAiError("Command tm_stream not allowed by ACL").message).toMatch(/Update TMCode/);
    expect(asAiError("Sign in to use Task Mentor projects.").code).toBe("SIGNED_OUT");
    expect(asAiError(new Error("boom")).message).toBe("TMCode AI couldn't answer: boom");
    expect(asAiError(undefined).message).toBe("TMCode AI couldn't answer. Try again.");
    expect(asAiError(new AiRequestError("FAILED", "")).message).toBe("TMCode AI couldn't answer. Try again.");
    const kept = new AiRequestError("USER_QUOTA", "You've used today's 40 AI questions.");
    expect(asAiError(kept)).toBe(kept);
  });
});

describe("sseParser", () => {
  it("reads events split anywhere", () => {
    const out: [string, unknown][] = [];
    const feed = sseParser((n, d) => out.push([n, d]));
    feed('event: meta\ndata: {"provider":"groq"}\n\nevent: del');
    feed('ta\ndata: {"text":"Hi"}\n\n: ping\n\n');
    expect(out).toEqual([
      ["meta", { provider: "groq" }],
      ["delta", { text: "Hi" }],
    ]);
  });
});
