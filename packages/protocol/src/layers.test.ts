import { describe, expect, it } from "vitest";
import { aiModeOf, decideProfile, layerName, layerOf, parseDevicePolicy, resolveLayer, type ProfileInput } from "./layers";

describe("layers map 1:1 onto ai_mode", () => {
  it("off | hints | full ↔ exam | learning | industrial; anything else is exam", () => {
    expect(layerOf("off")).toBe("exam");
    expect(layerOf("hints")).toBe("learning");
    expect(layerOf("full")).toBe("industrial");
    expect(layerOf(undefined)).toBe("exam");
    expect(layerOf("turbo")).toBe("exam");
    for (const l of ["exam", "learning", "industrial"] as const) expect(layerOf(aiModeOf(l))).toBe(l);
  });
});

describe("resolveLayer: the lowest ceiling wins (§8.5)", () => {
  it("nothing set: Industrial", () => {
    expect(resolveLayer([]).layer).toBe("industrial");
  });

  it("every example row of §8.5", () => {
    // Visitor, signed out, own project.
    expect(resolveLayer([{ layer: "industrial", cause: "signed-out" }])).toMatchObject({ layer: "industrial", cause: "signed-out" });
    // S2 student, class max Learning, personal project.
    expect(resolveLayer([{ layer: "learning", cause: "class" }, { layer: "industrial", cause: "default" }])).toMatchObject({ layer: "learning", cause: "class" });
    // S6, assignment Industrial.
    expect(resolveLayer([{ layer: "industrial", cause: "class" }, { layer: "industrial", cause: "assignment" }]).layer).toBe("industrial");
    // S6, assignment Learning, signs out: the sticky layer holds.
    expect(resolveLayer([{ layer: "industrial", cause: "signed-out" }, { layer: "learning", cause: "sticky" }])).toMatchObject({ layer: "learning", cause: "sticky" });
    // In an exam.
    expect(resolveLayer([{ layer: "exam", cause: "exam-session" }, { layer: "industrial", cause: "class" }])).toMatchObject({ layer: "exam", cause: "exam-session" });
    // Teacher, school switch off.
    expect(resolveLayer([{ layer: "exam", cause: "school" }, { layer: "industrial", cause: "default" }])).toMatchObject({ layer: "exam", cause: "school" });
    // Lab PC: signed-out layer Learning.
    expect(resolveLayer([{ layer: "learning", cause: "device" }, { layer: "industrial", cause: "signed-out" }])).toMatchObject({ layer: "learning", cause: "device" });
    // Industrial user choosing Learning.
    expect(resolveLayer([{ layer: "industrial", cause: "default" }, { layer: "learning", cause: "choice" }])).toMatchObject({ layer: "learning", cause: "choice" });
  });

  it("a choice can't raise the layer", () => {
    expect(resolveLayer([{ layer: "learning", cause: "assignment" }, { layer: "industrial", cause: "choice" }])).toMatchObject({ layer: "learning", cause: "assignment" });
  });

  it("ties go to the earlier ceiling in §8.5's order (exam session before device before school…)", () => {
    expect(resolveLayer([{ layer: "exam", cause: "choice" }, { layer: "exam", cause: "school" }, { layer: "exam", cause: "device" }]).cause).toBe("device");
  });

  it("ignores junk", () => {
    expect(resolveLayer([null, undefined, false, { layer: "nope" as never, cause: "school" }]).layer).toBe("industrial");
  });
});

describe("decideProfile: role decides Guided or Open (§8.0)", () => {
  const base: ProfileInput = { layer: "industrial", staff: false, signedIn: true, assessment: false, ownTools: false, schoolThirdParty: false };
  it("students are Guided, staff and signed-out users Open", () => {
    expect(decideProfile(base)).toBe("guided");
    expect(decideProfile({ ...base, staff: true })).toBe("open");
    expect(decideProfile({ ...base, signedIn: false })).toBe("open");
  });
  it("a teacher's own-tools toggle opens an assignment; the school switch opens personal projects", () => {
    expect(decideProfile({ ...base, assessment: true, ownTools: true })).toBe("open");
    expect(decideProfile({ ...base, assessment: true, schoolThirdParty: true })).toBe("guided");
    expect(decideProfile({ ...base, schoolThirdParty: true })).toBe("open");
  });
  it("the device and the user can force Guided; other layers report Guided", () => {
    expect(decideProfile({ ...base, staff: true, forceGuided: true })).toBe("guided");
    expect(decideProfile({ ...base, staff: true, choseGuided: true })).toBe("guided");
    expect(decideProfile({ ...base, layer: "learning", staff: true })).toBe("guided");
  });
});

describe("names", () => {
  it("Exam in a session, No AI elsewhere; Industrial shows its profile", () => {
    expect(layerName("exam", null, true)).toBe("Exam");
    expect(layerName("exam", null, false)).toBe("No AI");
    expect(layerName("learning", "guided")).toBe("Learning");
    expect(layerName("industrial", "open")).toBe("Industrial · Open");
    expect(layerName("industrial", "guided")).toBe("Industrial · Guided");
  });
});

describe("parseDevicePolicy", () => {
  it("reads IT's file and keeps the readable parts of a damaged one", () => {
    expect(parseDevicePolicy(null)).toBeNull();
    expect(parseDevicePolicy({ signedOutLayer: "learning", requireSignIn: true })).toEqual({ signedOutLayer: "learning", requireSignIn: true });
    expect(parseDevicePolicy({ maxLayer: "learning", signedOutLayer: "bogus", rules: "nope" })).toEqual({ maxLayer: "learning" });
  });
});
