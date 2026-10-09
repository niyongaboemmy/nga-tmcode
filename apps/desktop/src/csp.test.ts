import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

/**
 * 0.3.0 shipped with an invisible cursor, no current-line highlight and no
 * syntax colours: Tauri adds a nonce to style-src for every inline <style> in
 * index.html, a nonce makes WebKit ignore 'unsafe-inline', and then every
 * style Monaco and xterm create at runtime was refused.
 */
describe("webview content security policy", () => {
  it("index.html has no inline <style> (it would switch off 'unsafe-inline')", () => {
    expect(read("index.html")).not.toMatch(/<style[\s>]/i);
  });

  it("style-src still allows the runtime styles Monaco and xterm inject", () => {
    const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(conf.app.security.csp["style-src"]).toContain("'unsafe-inline'");
  });

  it("img-src loads assignment images from NGA servers (Task Mentor /uploads, the file server), not any site", () => {
    const img: string = JSON.parse(read("src-tauri/tauri.conf.json")).app.security.csp["img-src"];
    expect(img).toContain("https://*.amashuri.com");
    // Other sites' images become links (widgets/richHtml.ts): no tracking pixels in briefs.
    expect(img.split(/\s+/)).not.toContain("https:");
  });
});
