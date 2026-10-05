import { useEffect, useRef, useState } from "react";
import { getDocument, languageForPath, onDocumentChanged } from "../../monaco/documents";
import { monaco } from "../../monaco/setup";
import { revealInEditor } from "../../monaco/reveal";
import { getPlatform, type EditorInput } from "../../state/store";
import { openBrowser, openExternalUrl } from "../../terminal/browser";
import { dirname, join } from "../../util/paths";
import { isExternalHref, renderDocMarkdown } from "../../widgets/docMarkdown";
import { SkeletonLines } from "../../widgets/Skeleton";
import { mimeFor } from "./MediaEditor";

type MarkdownInput = Extract<EditorInput, { kind: "markdown" }>;

/** Normalises "a/../b" style paths produced by relative links. */
function normalize(path: string) {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  return out.join("/");
}

/** Live Markdown preview (Ctrl+K V), updated as the source is typed. */
export function MarkdownEditor({ input }: { input: MarkdownInput }) {
  const [html, setHtml] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const platform = getPlatform();
  const base = dirname(input.path);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const render = async () => {
      const src = getDocument(input.path)?.getValue() ?? (await platform.fs.readFile(input.path).catch(() => null));
      if (alive) setHtml(src === null ? `<p class="tm-muted">${input.path} could not be read.</p>` : renderDocMarkdown(src));
    };
    void render();
    const off = onDocumentChanged((p) => {
      if (p !== input.path) return;
      clearTimeout(timer);
      timer = setTimeout(() => void render(), 120);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      off();
    };
  }, [input.path, platform]);

  // After each render: highlight code blocks with Monaco's tokenizer, load local images.
  useEffect(() => {
    const root = body.current;
    if (!root || html === null) return;
    for (const code of root.querySelectorAll<HTMLElement>("pre > code")) {
      const lang = /language-([\w+#-]+)/.exec(code.className)?.[1];
      if (!lang) continue;
      const id = languageForPath(`x.${lang}`) !== "plaintext" ? languageForPath(`x.${lang}`) : lang;
      void monaco.editor.colorize(code.textContent ?? "", id, { tabSize: 2 }).then((out) => {
        if (code.isConnected) code.innerHTML = out;
      });
    }
    for (const img of root.querySelectorAll<HTMLImageElement>("img")) {
      const src = img.getAttribute("src") ?? "";
      if (!src || /^(https?:|data:)/i.test(src)) continue;
      const path = normalize(join(base, decodeURI(src.split(/[?#]/)[0])));
      img.removeAttribute("src");
      const mime = mimeFor(path);
      if (!platform.fs.readBase64 || !mime) continue;
      void platform.fs.readBase64(path).then(
        (b64) => img.isConnected && (img.src = `data:${mime};base64,${b64}`),
        () => img.classList.add("is-broken"),
      );
    }
  }, [html, base, platform]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      body.current?.querySelector(`#${CSS.escape(href.slice(1))}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (/^https?:\/\/(localhost|127\.0\.0\.1)/i.test(href)) openBrowser(href);
    else if (isExternalHref(href)) void openExternalUrl(href);
    else if (href) revealInEditor(normalize(join(base, decodeURI(href.split("#")[0]))));
  };

  return (
    <div className="tm-markdown-preview tm-scroll" data-testid="markdown-preview">
      {html === null ? (
        <div className="tm-markdown-body">
          <SkeletonLines lines={9} label="Rendering Markdown" />
        </div>
      ) : (
        <div ref={body} className="tm-markdown-body tm-md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
