import { beforeEach, describe, expect, it } from "vitest";
import { EXAM_POLICY_DEFAULTS, PRACTICE_POLICY } from "@tmcode/protocol";
import { useAi, type AiStatus } from "../ai/service";
import { useExam } from "../exam/state";
import { setPolicy } from "../state/store";
import { activeExtensions, aiExtensionBlocked, aiExtensionsBlocked, useExtensions, type InstalledExtension } from "./service";

const status = (extra: Partial<AiStatus>): AiStatus => ({ enabled: true, exam: false, default_mode: "free", modes: [], models: [], you: { chat: { used: 0, limit: 1 }, complete: { used: 0, limit: 1 } }, pools: {}, openrouter: null, ...extra });
const ext = (id: string, displayName: string, description = ""): InstalledExtension => ({ id, version: "1.0.0", enabled: true, manifest: { id, displayName, description, categories: [] } as unknown as InstalledExtension["manifest"] });

describe("third-party AI extensions", () => {
  beforeEach(() => {
    setPolicy(PRACTICE_POLICY);
    useExam.setState({ phase: "idle", quiz: null });
    useAi.setState({ status: null, denied: null, project: { id: null, assessment: false } });
    useExtensions.setState({ installed: [ext("anthropic.claude-code", "Claude Code"), ext("esbenp.prettier-vscode", "Prettier"), ext("acme.helper", "Helper", "An AI coding agent")] });
  });

  const ids = () => activeExtensions().map((e) => e.id);

  it("run when Task Mentor allows them (or an older Task Mentor says nothing)", () => {
    useAi.setState({ status: status({ allowed: true, thirdPartyExtensions: true }) });
    expect(aiExtensionsBlocked()).toBe(false);
    expect(ids()).toEqual(["anthropic.claude-code", "esbenp.prettier-vscode", "acme.helper"]);
    useAi.setState({ status: status({}) });
    expect(aiExtensionsBlocked()).toBe(false);
  });

  it("are left out when thirdPartyExtensions is false; other extensions keep running", () => {
    useAi.setState({ status: status({ allowed: true, thirdPartyExtensions: false }) });
    expect(aiExtensionsBlocked()).toBe(true);
    expect(ids()).toEqual(["esbenp.prettier-vscode"]);
    expect(aiExtensionBlocked("anthropic.claude-code")).toBe(true);
    expect(aiExtensionBlocked("github.copilot")).toBe(true);
    expect(aiExtensionBlocked("esbenp.prettier-vscode", { displayName: "Prettier" })).toBe(false);
  });

  it("are off while the status is unknown in an assignment project", () => {
    useAi.setState({ status: null, project: { id: 3, assessment: true } });
    expect(ids()).toEqual(["esbenp.prettier-vscode"]);
    useAi.setState({ project: { id: 4, assessment: false } });
    expect(ids()).toHaveLength(3);
  });

  it("all extensions are off in exams", () => {
    setPolicy({ ...EXAM_POLICY_DEFAULTS, ai: "full" });
    expect(aiExtensionsBlocked()).toBe(true);
    expect(ids()).toEqual([]);
    setPolicy(PRACTICE_POLICY);
  });
});
