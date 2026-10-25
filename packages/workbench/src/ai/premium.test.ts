import { describe, expect, it } from "vitest";
import { decideAiGate } from "./gate";
import { modeFields, MissingKeyError, parseMode } from "./keys";
import { aiErrorFromResponse, effectiveMode, modeLabel, type AiStatus } from "./service";

const base: AiStatus = { enabled: true, exam: false, default_mode: "free", modes: [], models: [], you: { chat: { used: 0, limit: 40 }, complete: { used: 0, limit: 200 } }, pools: {}, openrouter: null };
const newer = (s: Partial<AiStatus> = {}): AiStatus => ({
  ...base,
  allowed: true,
  reason: "ALLOWED_BY_ROLE",
  features: { assist: true, complete: true },
  staff: true,
  thirdPartyExtensions: true,
  tiers: { free: true, premium: true, byok: true },
  premium_models: [{ id: "premium:anthropic/claude-sonnet-4-5", label: "claude-sonnet-4-5", provider: "anthropic", providerLabel: "Anthropic" }],
  premium_you: { used: 1, limit: 50 },
  byok_providers: [{ id: "openai", label: "OpenAI", suggested_models: ["gpt-4.1-mini"] }],
  ...s,
});

describe("modes", () => {
  it("parses free, premium and own-key modes", () => {
    expect(parseMode("free")).toEqual({ tier: "free", provider: null, model: null });
    expect(parseMode("groq/openai/gpt-oss-20b")).toEqual({ tier: "free", provider: "groq", model: "openai/gpt-oss-20b" });
    expect(parseMode("premium:openrouter/anthropic/claude-sonnet-4.5")).toEqual({ tier: "premium", provider: "openrouter", model: "anthropic/claude-sonnet-4.5" });
    expect(parseMode("byok:openai/gpt-4.1")).toEqual({ tier: "byok", provider: "openai", model: "gpt-4.1" });
  });

  it("puts the own key in the body only for own-key modes, read at request time", async () => {
    const reads: string[] = [];
    const read = async (p: string) => (reads.push(p), p === "openai" ? "sk-test" : null);
    expect(await modeFields("auto", read)).toEqual({ mode: "auto" });
    expect(await modeFields("premium:openai/gpt-4.1", read)).toEqual({ mode: "premium:openai/gpt-4.1" });
    expect(reads).toEqual([]);
    expect(await modeFields("byok:openai/gpt-4.1", read)).toEqual({ mode: "byok:openai/gpt-4.1", byok: { provider: "openai", key: "sk-test" } });
    await expect(modeFields("byok:anthropic/claude-sonnet-4-5", read)).rejects.toBeInstanceOf(MissingKeyError);
  });

  it("falls back to Free when the server can't serve the picked mode (older Task Mentor, premium taken away)", () => {
    expect(effectiveMode("premium:anthropic/claude-sonnet-4-5", newer())).toBe("premium:anthropic/claude-sonnet-4-5");
    expect(effectiveMode("premium:anthropic/claude-sonnet-4-5", newer({ tiers: { free: true, premium: false, byok: true }, premium_models: [] }))).toBe("free");
    expect(effectiveMode("premium:anthropic/claude-sonnet-4-5", base)).toBe("free");
    expect(effectiveMode("byok:openai/gpt-4.1", base)).toBe("free");
    expect(effectiveMode("byok:openai/gpt-4.1", newer())).toBe("byok:openai/gpt-4.1");
    expect(effectiveMode("auto", base)).toBe("auto");
    expect(effectiveMode("byok:openai/gpt-4.1", null)).toBe("byok:openai/gpt-4.1");
  });

  it("labels premium and own-key modes", () => {
    expect(modeLabel("premium:anthropic/claude-sonnet-4-5", newer())).toBe("claude-sonnet-4-5 · Premium");
    expect(modeLabel("byok:openai/gpt-4.1", newer())).toBe("gpt-4.1 · your OpenAI key");
  });

  it("says clearly why premium or an own key was refused", () => {
    expect(aiErrorFromResponse(403, { code: "PREMIUM_REQUIRED" }).message).toMatch(/Premium AI isn't turned on for your account/);
    const byok = aiErrorFromResponse(400, { code: "BYOK_REJECTED", message: "401 Unauthorized" });
    expect(byok.code).toBe("BYOK_REJECTED");
    expect(byok.message).toBe("Your own API key was refused: 401 Unauthorized");
  });
});

describe("third-party AI tools for staff", () => {
  it("follow Task Mentor's staff decision (thirdPartyExtensions), even in an assignment project", () => {
    expect(decideAiGate({ status: newer(), exam: false, assessmentProject: true }).thirdParty).toBe(true);
    expect(decideAiGate({ status: newer({ thirdPartyExtensions: false }), exam: false }).thirdParty).toBe(false);
    // Never in exams.
    expect(decideAiGate({ status: newer(), statusInExam: true, exam: true }).thirdParty).toBe(false);
  });
});
