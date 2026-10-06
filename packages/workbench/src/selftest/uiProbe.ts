import { codeEditorFor } from "../monaco/editors";
import { monaco } from "../monaco/setup";
import { terminalTheme } from "../parts/panel/TerminalView";
import { useThemes } from "../themes/themeService";
import { getPlatform, openFile, showPanel, useWorkbench } from "../state/store";

/**
 * Measures the editor and terminal as the user sees them, inside whatever
 * webview runs the workbench (Playwright e2e and the native UI self-test).
 * Everything here is read from the live DOM, so a blocked stylesheet, a
 * mis-measured font or a stalled main thread shows up as a failed check.
 */

const violations: string[] = [];
let listening = false;
/** Records Content-Security-Policy refusals (e.g. a blocked runtime <style>), from as early as possible. */
export function watchCspViolations(onViolation?: (msg: string) => void) {
  if (listening || typeof document === "undefined") return;
  listening = true;
  const seen = new Set<string>();
  document.addEventListener("securitypolicyviolation", (e) => {
    const msg = `${e.effectiveDirective || e.violatedDirective} blocked ${e.blockedURI || "inline"}`;
    violations.push(msg);
    if (!seen.has(msg)) {
      seen.add(msg);
      onViolation?.(msg);
    }
  });
}

export interface UiCheck {
  name: string;
  ok: boolean;
  detail: string;
}

const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opaque, non-transparent colour? */
function visible(color: string | null | undefined) {
  if (!color) return false;
  if (color === "transparent") return false;
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return true;
  const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
  return parts.length < 4 || parts[3] > 0.05;
}

function luminance(color: string) {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return 0;
  const [r, g, b] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Watches requestAnimationFrame gaps while `work` runs: the longest gap is the worst freeze. */
async function longestFrameGap(work: () => Promise<void>, mark: () => string = () => "") {
  let running = true;
  let last = performance.now();
  let worst = 0;
  const stalls: string[] = [];
  const loop = () => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    if (now - last > 50) stalls.push(`${Math.round(now - last)}ms@${mark()}`);
    last = now;
    if (running) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  await work();
  running = false;
  await nextFrame();
  return { worst: Math.round(worst), stalls };
}

export async function runUiProbe(opts: { file: string; bigFile?: string; terminal?: boolean }): Promise<UiCheck[]> {
  const checks: UiCheck[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // A restored session reopens its editors asynchronously after boot; measure only once that has settled.
  let lastEditors = "";
  for (let i = 0, stable = 0; i < 100 && stable < 4; i++) {
    const now = JSON.stringify(useWorkbench.getState().groups.map((g) => [g.activeId, g.editors.length]));
    stable = now === lastEditors ? stable + 1 : 0;
    lastEditors = now;
    await wait(100);
  }
  const t0 = performance.now();
  openFile(opts.file, { pinned: true });
  let ed = codeEditorFor(useWorkbench.getState().activeGroup);
  for (let i = 0; i < 100 && !(ed?.getModel()?.uri.path.endsWith(opts.file) && ed.getDomNode()?.querySelector(".view-line")); i++) {
    await wait(50);
    ed = codeEditorFor(useWorkbench.getState().activeGroup);
  }
  if (!ed?.getModel()) {
    check("open", false, `editor for ${opts.file} never got a model`);
    return checks;
  }
  check("open", true, `${opts.file} in ${Math.round(performance.now() - t0)}ms`);
  const root = ed.getDomNode()!;
  // Where is the editor? (A hidden or detached editor reports empty styles for everything below.)
  const hiddenBy = (() => {
    for (let el: HTMLElement | null = root; el; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 3).join(".")} (${cs.display}/${cs.visibility})`;
    }
    return null;
  })();
  const box = root.getBoundingClientRect();
  check(
    "editor visible",
    root.isConnected && !hiddenBy && box.width > 100 && box.height > 100,
    `${Math.round(box.width)}x${Math.round(box.height)}, ${document.querySelectorAll(".monaco-editor").length} editors in DOM${hiddenBy ? `, hidden by ${hiddenBy}` : ""}`,
  );
  ed.focus();
  ed.setPosition({ lineNumber: 2, column: 1 });
  await wait(400); // tokenization + theme
  if (codeEditorFor(useWorkbench.getState().activeGroup) !== ed || !root.isConnected) check("editor stable", false, "the editor was replaced while being measured");

  const bg = getComputedStyle(root.querySelector(".monaco-editor-background") ?? root).backgroundColor;

  // Cursor: painted, a real width, in the right place, readable on the background.
  const cursor = root.querySelector<HTMLElement>(".cursors-layer .cursor");
  const cursorStyle = cursor ? getComputedStyle(cursor) : null;
  check(
    "cursor",
    !!cursorStyle && visible(cursorStyle.backgroundColor) && contrast(cursorStyle.backgroundColor, bg) >= 3 && parseFloat(cursorStyle.width) >= 1,
    cursorStyle ? `bg ${cursorStyle.backgroundColor} on ${bg} (contrast ${contrast(cursorStyle.backgroundColor, bg).toFixed(1)}), width ${cursorStyle.width}` : "no cursor element",
  );

  // Current line: highlighted in both the text and the line-number gutter.
  const line = root.querySelector<HTMLElement>(".view-overlays .current-line");
  const ls = line ? getComputedStyle(line) : null;
  check(
    "current line",
    !!ls && (visible(ls.backgroundColor) || (parseFloat(ls.borderTopWidth) > 0 && visible(ls.borderTopColor))),
    ls ? `bg ${ls.backgroundColor}, border ${ls.borderTopWidth} ${ls.borderTopColor}` : "no current-line overlay",
  );
  const activeNum = root.querySelector<HTMLElement>(".line-numbers.active-line-number");
  const otherNum = root.querySelector<HTMLElement>(".line-numbers:not(.active-line-number)");
  check(
    "active line number",
    !!activeNum && !!otherNum && getComputedStyle(activeNum).color !== getComputedStyle(otherNum).color,
    activeNum && otherNum ? `active ${getComputedStyle(activeNum).color}, others ${getComputedStyle(otherNum).color}` : "missing line numbers",
  );

  // Syntax colours: tokens must render in several distinct colours.
  // Grammars and the Oniguruma wasm load lazily on first use, which takes a while on a cold or slow machine.
  const tokenColors = () => new Set([...root.querySelectorAll<HTMLElement>(".view-lines span[class^='mtk'], .view-lines span[class*=' mtk']")].map((s) => getComputedStyle(s).color));
  let colors = tokenColors();
  for (let i = 0; i < 80 && colors.size < 3; i++) {
    await wait(100);
    colors = tokenColors();
  }
  check("syntax colours", colors.size >= 3, `${colors.size} distinct token colours`);

  // Glyph alignment: Monaco's measured character width must match what the browser paints,
  // or the caret and selections drift away from the text.
  const fi = ed.getOption(monaco.editor.EditorOption.fontInfo);
  const model = ed.getModel()!;
  let worstDrift = 0;
  let measured = 0;
  for (let n = 1; n <= Math.min(model.getLineCount(), 40); n++) {
    const text = model.getLineContent(n);
    if (!/^[\x20-\x7e]{12,}$/.test(text) || /\t/.test(text)) continue;
    const viewLine = [...root.querySelectorAll<HTMLElement>(".view-lines .view-line")].find((v) => v.textContent === text.replace(/ /g, " ") || v.textContent === text);
    const span = viewLine?.firstElementChild as HTMLElement | null;
    if (!span) continue;
    const painted = span.getBoundingClientRect().width;
    const expected = ed.getScrolledVisiblePosition({ lineNumber: n, column: text.length + 1 })!.left - ed.getScrolledVisiblePosition({ lineNumber: n, column: 1 })!.left;
    worstDrift = Math.max(worstDrift, Math.abs(painted - expected));
    measured++;
  }
  check("glyph alignment", measured > 0 && worstDrift <= 2, `${measured} lines, worst drift ${worstDrift.toFixed(1)}px (font ${fi.fontFamily}, ${fi.typicalHalfwidthCharacterWidth.toFixed(2)}px/char)`);

  // The hidden input must stay hidden (a visible textarea paints a second copy of typed text).
  const input = root.querySelector<HTMLElement>("textarea.inputarea, .native-edit-context");
  const is = input ? getComputedStyle(input) : null;
  check("hidden input", !!is && (!visible(is.color) || is.opacity === "0" || parseFloat(is.width) <= 1), is ? `color ${is.color}, width ${is.width}` : "none");

  // Responsiveness: typing and scrolling must not stall the main thread.
  let key = 0;
  const typing = await longestFrameGap(async () => {
    const end = model.getLineMaxColumn(model.getLineCount());
    ed!.setPosition({ lineNumber: model.getLineCount(), column: end });
    for (let i = 0; i < 60; i++, key++) {
      ed!.trigger("keyboard", "type", { text: i % 20 === 19 ? "\n" : "a" });
      await nextFrame();
    }
    key = -1;
    for (let i = 0; i < 70 && model.canUndo(); i++) ed!.trigger("keyboard", "undo", null);
  }, () => (key < 0 ? "undo" : `key${key}`));
  check("typing latency", typing.worst < 120, `longest frame gap ${typing.worst}ms while typing 60 keys${typing.stalls.length ? ` (stalls ${typing.stalls.join(", ")})` : ""}`);

  // Large files: opening and scrolling must stay responsive (no long main-thread stalls).
  if (opts.bigFile) {
    const t1 = performance.now();
    let opened = false;
    const openGap = await longestFrameGap(async () => {
      openFile(opts.bigFile!, { pinned: true });
      for (let i = 0; i < 200; i++) {
        const e = codeEditorFor(useWorkbench.getState().activeGroup);
        if (e?.getModel()?.uri.path.endsWith(opts.bigFile!)) {
          opened = true;
          break;
        }
        await wait(25);
      }
      await nextFrame();
    });
    const big = codeEditorFor(useWorkbench.getState().activeGroup)!;
    const lines = big?.getModel()?.getLineCount() ?? 0;
    check("large file open", opened && openGap.worst < 400, `${lines} lines in ${Math.round(performance.now() - t1)}ms, longest stall ${openGap.worst}ms`);
    const scroll = await longestFrameGap(async () => {
      for (let i = 0; i < 60; i++) {
        big.setScrollTop(big.getScrollTop() + 400);
        await nextFrame();
      }
      big.setScrollTop(0);
    });
    check("scrolling", scroll.worst < 120, `longest frame gap ${scroll.worst}ms over 60 scroll steps${scroll.stalls.length ? ` (${scroll.stalls.slice(0, 4).join(", ")})` : ""}`);
  }

  // Selection and clipboard: what ⌘C / ⌘X / ⌘V (the native Edit menu) and Delete reach inside the editor.
  // The large-file step may have replaced the editor: measure the live one, back on the probe file.
  {
    openFile(opts.file, { pinned: true });
    await wait(300);
    ed = codeEditorFor(useWorkbench.getState().activeGroup) ?? ed;
    const root = ed.getDomNode()!;
    const bg = getComputedStyle(root.querySelector(".monaco-editor-background") ?? root).backgroundColor;
    const model = ed.getModel()!;
    ed.focus();
    ed.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1 });
    await wait(250);
    const selEls = [...root.querySelectorAll<HTMLElement>(".selected-text")];
    const selBg = selEls[0] ? getComputedStyle(selEls[0]).backgroundColor : "";
    check("selection highlight", selEls.length > 0 && visible(selBg) && selBg !== bg, selEls.length ? `${selEls.length} boxes, ${selBg} on ${bg}` : "no .selected-text drawn");
    const input = root.querySelector<HTMLElement>("textarea.inputarea, textarea, .native-edit-context");
    const focused = document.activeElement === input || !!input?.contains(document.activeElement);
    const selected = model.getValueInRange(ed.getSelection()!);
    const dt = new DataTransfer();
    input?.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
    const copied = dt.getData("text/plain");
    check("input mode", true, `EditContext in this WebKit: ${"EditContext" in window}; editor input: ${root.querySelector("textarea") ? "textarea" : root.querySelector(".native-edit-context") ? "edit-context" : "none"}`);
    check("copy", !!copied && copied.replace(/\r/g, "") === selected.replace(/\r/g, ""), `input ${input?.tagName.toLowerCase()}${input?.className ? "." + String(input.className).split(" ")[0] : ""} focused=${focused}; copied ${copied.length} of ${selected.length} chars; execCommand(copy) supported=${document.queryCommandSupported?.("copy")}`);
    const version = model.getAlternativeVersionId();
    const pdt = new DataTransfer();
    pdt.setData("text/plain", "/*tmcode-paste*/");
    input?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: pdt, bubbles: true, cancelable: true }));
    await wait(150);
    check("paste", model.getValue().includes("/*tmcode-paste*/"), model.getValue().includes("/*tmcode-paste*/") ? "pasted text replaced the selection" : "paste event did not insert text");
    ed.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 });
    const lineBefore = model.getLineContent(1);
    ed.trigger("ui-probe", "deleteLeft", null);
    await wait(50);
    check("delete selection", model.getLineContent(1) !== lineBefore, `line 1 ${JSON.stringify(lineBefore.slice(0, 20))} → ${JSON.stringify(model.getLineContent(1).slice(0, 20))}`);
    // Leave the file as it was.
    for (let i = 0; i < 6 && model.getAlternativeVersionId() !== version; i++) ed.trigger("ui-probe", "undo", null);
    ed.setPosition({ lineNumber: 2, column: 1 });
  }

  if (opts.terminal) {
    showPanel("terminal");
    let term: HTMLElement | null = null;
    for (let i = 0; i < 100 && !(term = document.querySelector<HTMLElement>("[data-testid=integrated-terminal] .xterm .xterm-screen")); i++) await wait(50);
    // Wait for the shell's prompt (login shells with heavy rc files can take a few seconds).
    const t2 = performance.now();
    const rowText = () => [...document.querySelectorAll("[data-testid=integrated-terminal] .xterm-rows > div")].map((r) => r.textContent ?? "").join("").trim();
    while (performance.now() - t2 < 8000 && !rowText()) await wait(100);
    const box = document.querySelector("[data-testid=integrated-terminal]")?.getBoundingClientRect();
    check("terminal prompt", !!rowText(), rowText() ? `prompt after ${Math.round(performance.now() - t2)}ms: ${JSON.stringify(rowText().slice(0, 40))}` : `nothing printed in 8s (host ${Math.round(box?.width ?? 0)}x${Math.round(box?.height ?? 0)}, ${document.querySelectorAll("[data-testid=integrated-terminal] .xterm").length} xterm)`);
    const helper = document.querySelector<HTMLTextAreaElement>("[data-testid=integrated-terminal] .xterm-helper-textarea");
    helper?.focus();
    // A background window gets no real focus event, and xterm 6 draws no cursor before one.
    if (helper && !document.hasFocus()) helper.dispatchEvent(new FocusEvent("focus"));
    await wait(300);
    const rows = document.querySelector<HTMLElement>("[data-testid=integrated-terminal] .xterm-rows");
    // Fitted: every row is inside the visible host (an unfitted 80x24 terminal hides its prompt below the fold).
    const hostBox = document.querySelector("[data-testid=integrated-terminal]")!.getBoundingClientRect();
    const rowEls = [...(rows?.children ?? [])] as HTMLElement[];
    const lastRow = rowEls[rowEls.length - 1]?.getBoundingClientRect();
    check("terminal fits", !!lastRow && lastRow.bottom <= hostBox.bottom + 1 && lastRow.height > 0, lastRow ? `${rowEls.length} rows, last row ends at ${Math.round(lastRow.bottom - hostBox.top)}px of a ${Math.round(hostBox.height)}px host` : "no rows");
    const rs = rows ? getComputedStyle(rows) : null;
    const theme = terminalTheme(useThemes.getState().active?.id ?? "dark-modern");
    const hex = (c: string) => { const [r, g, b] = c.match(/\d+/g)!.map(Number); return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`; };
    check("terminal colours", !!term && !!rs && hex(rs.color) === theme.foreground?.toLowerCase(), rs ? `text ${hex(rs.color)} (theme ${theme.foreground}), ${rows!.children.length} rows` : "no xterm rows");
    // The cursor blinks (xterm drops its class in the "off" phase), so sample across a full blink cycle.
    // Focused: a bar drawn as an inset box-shadow; unfocused: a 1px outline (VS Code's look). Both come from
    // xterm's runtime <style>. The bar blinks, so sample across a full cycle for its "on" phase.
    let tCursor: HTMLElement | null = null;
    let cursorColor = "";
    for (let i = 0; i < 30 && !visible(cursorColor); i++) {
      tCursor = document.querySelector<HTMLElement>("[data-testid=integrated-terminal] .xterm-rows .xterm-cursor");
      const cs = tCursor ? getComputedStyle(tCursor) : null;
      cursorColor = !cs ? "" : cs.boxShadow !== "none" ? cs.boxShadow.match(/rgba?\([^)]*\)/)?.[0] ?? "" : cs.outlineStyle !== "none" ? cs.outlineColor : cs.backgroundColor;
      if (!visible(cursorColor)) await wait(50);
    }
    // Terminal selection: drag across the first prompt row; xterm draws its own selection layer.
    {
      const screen = document.querySelector<HTMLElement>("[data-testid=integrated-terminal] .xterm-screen");
      const firstRow = rowEls[0]?.getBoundingClientRect();
      if (screen && firstRow) {
        const y = firstRow.top + firstRow.height / 2;
        const opts = (x: number) => ({ clientX: x, clientY: y, bubbles: true, button: 0, buttons: 1, detail: 1, view: window });
        screen.dispatchEvent(new MouseEvent("mousedown", opts(firstRow.left + 2)));
        document.dispatchEvent(new MouseEvent("mousemove", opts(firstRow.left + Math.min(200, firstRow.width - 4))));
        document.dispatchEvent(new MouseEvent("mouseup", opts(firstRow.left + Math.min(200, firstRow.width - 4))));
        await wait(200);
      }
      const drawn = () => {
        const divs = [...document.querySelectorAll<HTMLElement>("[data-testid=integrated-terminal] .xterm-selection div")];
        return { n: divs.length, bg: divs[0] ? getComputedStyle(divs[0]).backgroundColor : "" };
      };
      const dragged = drawn();
      check("terminal selection (mouse)", dragged.n > 0 && visible(dragged.bg), dragged.n ? `${dragged.n} boxes, ${dragged.bg}` : "no selection drawn after a drag");
      // The same through xterm's API: separates drawing from mouse handling.
      const api = (window as unknown as { __TMCODE_TERM__?: { selectAll(): void; hasSelection(): boolean; getSelection(): string; clearSelection(): void } }).__TMCODE_TERM__;
      if (api) {
        api.selectAll();
        await wait(200);
        const all = drawn();
        check("terminal selection", api.hasSelection() && all.n > 0 && visible(all.bg), `selectAll: hasSelection=${api.hasSelection()} (${api.getSelection().length} chars), ${all.n} boxes ${all.bg}`);
        // ⌘C / Ctrl+C on the terminal reaches the system clipboard (WebKit copies nothing for xterm's selection).
        const clip = getPlatform().clipboard;
        if (clip) {
          const saved = await clip.readText().catch(() => "");
          const mac = getPlatform().os === "mac";
          const textarea = document.querySelector<HTMLTextAreaElement>("[data-testid=integrated-terminal] .xterm-helper-textarea");
          textarea?.focus();
          textarea?.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }));
          await wait(300);
          const copied = await clip.readText().catch(() => "");
          check("terminal copy", copied.trim().length > 0 && copied.trim() === api.getSelection().trim(), `clipboard has ${copied.trim().length} of ${api.getSelection().trim().length} selected chars`);
          await clip.writeText(saved).catch(() => {});
        }
        api.clearSelection();
      }
    }
    check("terminal cursor", !!tCursor && visible(cursorColor), tCursor ? `${tCursor.className.trim()} (${cursorColor})` : `no cursor: focus on ${document.activeElement?.className}; hidden by ${helper?.closest("[hidden]")?.className ?? "nothing"}`);
  }

  check("csp", violations.length === 0, violations.length ? [...new Set(violations)].slice(0, 5).join("; ") : "no blocked resources");
  return checks;
}
