import { describe, expect, it } from "vitest";
import menus from "../commands/menus.json";
import { SETTING_SECTIONS } from "../state/settings";
import { coverage, tr } from "./i18n";

function menuLabels(): string[] {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      if (typeof o.label === "string") out.push(o.label);
      Object.values(o).forEach(walk);
    }
  };
  walk(menus);
  return [...new Set(out)];
}

describe("display language", () => {
  it("French covers every menu label and every Settings section", () => {
    const missing = menuLabels().filter((l) => tr(l, "fr") === l && !["TMCode", "Terminal", "Minimap", "Extensions", "OK", "Application"].includes(l));
    expect(missing).toEqual([]);
    expect(coverage("fr", SETTING_SECTIONS.map((s) => s.title))).toBe(1);
  });

  it("falls back to English", () => {
    expect(tr("Save", "fr")).toBe("Enregistrer");
    expect(tr("Something new", "fr")).toBe("Something new");
    expect(tr("Save", "en")).toBe("Save");
  });
});
