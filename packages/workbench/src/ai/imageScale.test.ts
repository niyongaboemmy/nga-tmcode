import { describe, expect, it } from "vitest";
import { fitSize, MAX_IMAGE_SIDE } from "./imageScale";
import { aiReadsImages, type AiStatus } from "./service";

describe("images for TMCode AI", () => {
  it("scales the long side down to the limit, keeping the shape", () => {
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitSize(3136, 1000)).toEqual({ width: MAX_IMAGE_SIDE, height: 500 });
    expect(fitSize(1000, 4704)).toEqual({ width: 333, height: MAX_IMAGE_SIDE });
  });

  const status = (models: AiStatus["models"], extra: Partial<AiStatus> = {}) => ({ models, tiers: { free: true, premium: true, byok: true }, ...extra }) as AiStatus;
  const or = (id: string, vision?: boolean) => ({ id: `openrouter/${id}`, label: id, provider: "openrouter", providerLabel: "OpenRouter", ...(vision === undefined ? {} : { vision }) });
  const groq = { id: "groq/gpt-oss", label: "gpt-oss", provider: "groq", providerLabel: "Groq", vision: false };

  it("knows when the AI that answers reads images", () => {
    const s = status([or("a", false), or("b", true), groq]);
    expect(aiReadsImages("free", s)).toBe(true);
    expect(aiReadsImages("auto", s)).toBe(true);
    expect(aiReadsImages("groq/gpt-oss", s)).toBe(false);
    expect(aiReadsImages("openrouter/b", s)).toBe(true);
    expect(aiReadsImages("free", status([or("a", false), { ...groq, vision: true }]))).toBe(false);
    expect(aiReadsImages("auto", status([or("a", false), { ...groq, vision: true }]))).toBe(true);
  });

  it("premium models say for themselves; an older server offers no images", () => {
    const s = status([or("b", true)], { premium_models: [{ id: "premium:anthropic/claude", label: "claude", provider: "anthropic", providerLabel: "A", vision: true }] });
    expect(aiReadsImages("premium:anthropic/claude", s)).toBe(true);
    expect(aiReadsImages("free", status([or("a"), or("b")]))).toBe(false);
    expect(aiReadsImages("free", null)).toBe(false);
  });
});
