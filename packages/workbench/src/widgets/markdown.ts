import DOMPurify from "dompurify";
import { Marked } from "marked";

/**
 * Task briefs are Markdown from Task Mentor. Raw HTML is shown as text (never
 * rendered), and links open nothing inside the exam window.
 */
const escape = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html: ({ text }) => escape(text),
    link: ({ text }) => `<span class="tm-md-link">${escape(text)}</span>`,
    image: ({ text }) => `<span class="tm-muted">[image: ${escape(text)}]</span>`,
  },
});

export function renderMarkdown(src: string): string {
  return md.parse(src, { async: false }) as string;
}

/**
 * Task Mentor question text is rich-text HTML (its editor); plain briefs are
 * Markdown. HTML is sanitised: no scripts, handlers, iframes, forms or links.
 */
export function renderBrief(src: string): string {
  if (!/^\s*</.test(src)) return renderMarkdown(src);
  return DOMPurify.sanitize(src, {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button", "a", "link", "meta"],
    // The theme decides colours and fonts (old <font color> / bgcolor attributes too).
    FORBID_ATTR: ["style", "srcset", "color", "bgcolor", "face", "background"],
    KEEP_CONTENT: true,
  });
}
