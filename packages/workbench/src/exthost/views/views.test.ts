import { describe, expect, it } from "vitest";
import { preludeScript, webviewDocument } from "./prelude";
import type { WebviewTheme } from "./themeVars";

const theme: WebviewTheme = { vars: { "--vscode-editor-background": "#1e1e1e" }, kind: "vscode-dark", themeId: "dark-modern", colorScheme: "dark" };

describe("webview documents", () => {
  it("puts the prelude first in <head>, before the extension's CSP", () => {
    const html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-x'"></head><body class="x"><p>hi</p></body></html>`;
    const doc = webviewDocument(html, { state: { n: 1 }, theme });
    expect(doc.indexOf("acquireVsCodeApi")).toBeGreaterThan(doc.indexOf("<head>"));
    expect(doc.indexOf("acquireVsCodeApi")).toBeLessThan(doc.indexOf("Content-Security-Policy"));
    // The theme kind is on <body> before any page script runs.
    expect(doc).toContain('<body class="vscode-dark x" data-vscode-theme-kind="vscode-dark" data-vscode-theme-id="dark-modern">');
  });

  it("wraps fragments and pages without <head>", () => {
    expect(webviewDocument("<p>side</p>", { state: undefined, theme })).toMatch(/^<!DOCTYPE html><html><head><script>[\s\S]*<\/script><\/head><body><p>side<\/p><\/body><\/html>$/);
    expect(webviewDocument("<html lang='en'><body>x</body></html>", { state: undefined, theme })).toMatch(/^<html lang='en'><head><script>/);
  });

  it("is a script that parses (a broken prelude stops every extension page)", () => {
    const s = preludeScript({ state: { n: 1 }, theme });
    expect(() => new Function(s.replace(/^<script>/, "").replace(/<\/script>$/, ""))).not.toThrow();
  });

  it("reports what goes wrong on the page: errors, rejections, failed loads, CSP refusals", () => {
    const s = preludeScript({ state: null, theme });
    for (const event of ['"error"', '"unhandledrejection"', '"securitypolicyviolation"']) expect(s).toContain(event);
    expect(s).toContain('type: "diagnostic"');
  });

  it("delivers the extension's messages from the page's own origin, as VS Code does (Codex checks it)", () => {
    const s = preludeScript({ state: null, theme });
    expect(s).toContain("origin: window.location.origin");
  });

  it("keeps state and theme JSON from closing the script", () => {
    const s = preludeScript({ state: { evil: "</script><script>alert(1)</script>" }, theme });
    expect(s.match(/<\/script>/g)).toHaveLength(1);
    expect(s).toContain("\\u003c/script>");
  });
});
