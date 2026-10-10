import { describe, expect, it } from "vitest";
import { profileById } from "@tmcode/profiles";
import { shortTitle, verdictLabel, versionLess } from "./api";
import { launchErrorCopy } from "./launchErrors";
import { clockCheck, computerProfiles, reachabilityCheck, toolchainChecks, toolsFor } from "./readiness";
import { examRootSubmission, isExamRoot } from "./roots";

describe("system check", () => {
  const python = profileById("python-3")!;
  const java = profileById("java-21")!;
  const web = profileById("web")!;

  it("lists the tools a profile needs (not the built program)", () => {
    expect(toolsFor(python)).toEqual(["python"]);
    expect(toolsFor(java)).toEqual(["javac", "java"]);
    expect(toolsFor(profileById("c17")!)).toEqual(["cc"]);
    expect(toolsFor(web)).toEqual([]);
  });

  it("found tools are ok with their version; missing ones get a fix and links for this OS", () => {
    const items = toolchainChecks([python, java, web], [{ tool: "python", path: "/usr/bin/python3", version: "Python 3.12.1" }], "windows", { exam: false });
    expect(items[0]).toMatchObject({ status: "ok", detail: "Python 3.12.1" });
    expect(items[1].status).toBe("fail");
    expect(items[1].detail).toContain("Java JDK");
    expect(items[1].links?.[0].url).toContain("adoptium.net");
    expect(items[2]).toMatchObject({ status: "ok" });
    // No made-up "toolchain packs".
    expect(JSON.stringify(items)).not.toMatch(/toolchain pack/i);
  });

  it("in an exam a missing tool is a warning: the tests run on Task Mentor", () => {
    const [item] = toolchainChecks([python], [], "mac", { exam: true });
    expect(item.status).toBe("warn");
    expect(item.detail).toContain("run on Task Mentor");
    expect(item.links?.[0].url).toContain("python.org/downloads/macos");
  });

  it("checks each toolset once on Check My Computer (TypeScript shares Node.js)", () => {
    const ids = computerProfiles().map((p) => p.id);
    expect(ids).toContain("node-22");
    expect(ids).not.toContain("typescript");
    expect(ids).not.toContain("web");
  });

  it("clock and reachability", () => {
    expect(clockCheck(5_000, "mac").status).toBe("ok");
    const fast = clockCheck(-10 * 60_000, "windows");
    expect(fast.status).toBe("warn");
    expect(fast.detail).toContain("10 min fast");
    expect(fast.fix).toContain("Set time automatically");
    expect(clockCheck(null, "linux").status).toBe("skipped");
    expect(reachabilityCheck(null).status).toBe("fail");
    expect(reachabilityCheck({ ms: 120 }).status).toBe("ok");
    expect(reachabilityCheck({ ms: 5000 }).status).toBe("warn");
  });
});

describe("launch errors", () => {
  it("map codes to a plain title and actions", () => {
    expect(launchErrorCopy("TICKET_USED", "x")).toMatchObject({ title: "This exam link has expired", actions: ["taskmentor"] });
    expect(launchErrorCopy("OFFLINE", "x").actions).toEqual(["retry", "taskmentor"]);
    expect(launchErrorCopy("APP_TOO_OLD", "", { min_app_version: "0.12.0" })).toMatchObject({ title: "This exam needs TMCode 0.12.0 or newer", actions: ["update", "taskmentor"] });
    expect(launchErrorCopy("APP_TOO_OLD", "").title).toBe("TMCode is out of date for this exam");
    expect(launchErrorCopy("HTTP_502", "Bad gateway").title).toBe("Task Mentor had a problem");
    expect(launchErrorCopy(null, "boom")).toMatchObject({ title: "The exam could not be opened", body: "boom" });
  });
});

describe("helpers", () => {
  it("compares versions numerically", () => {
    expect(versionLess("0.9.2", "0.10.0")).toBe(true);
    expect(versionLess("0.11.0", "0.11.0")).toBe(false);
    expect(versionLess("1.0.0", "0.99.9")).toBe(false);
    expect(versionLess("0.1.0-web", "0.2")).toBe(true);
  });

  it("cuts titles at a word boundary", () => {
    expect(shortTitle("Sum of two numbers")).toBe("Sum of two numbers");
    const long = "Write a program that reads a list of student marks and prints the average and the grade";
    const cut = shortTitle(long, 40);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(40);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(cut.slice(0, -1)).toBe("Write a program that reads a list of");
  });

  it("names verdicts plainly", () => {
    expect(verdictLabel("time-limit")).toBe("Too slow (time limit)");
    expect(verdictLabel("wrong-answer")).toBe("Wrong answer");
    expect(verdictLabel(undefined)).toBeNull();
  });

  it("recognises exam folders", () => {
    expect(isExamRoot("memory://exam-9001")).toBe(true);
    expect(isExamRoot("/Users/a/Library/Application Support/com.amashuri.tmcode/exams/812")).toBe(true);
    expect(isExamRoot("C:\\Users\\a\\AppData\\Roaming\\com.amashuri.tmcode\\exams\\812")).toBe(true);
    expect(isExamRoot("/Users/a/code/exams/812")).toBe(false);
    expect(isExamRoot("memory://practice-project")).toBe(false);
    expect(examRootSubmission("memory://exam-9001")).toBe(9001);
  });
});
