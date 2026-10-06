import DOMPurify from "dompurify";
import { Marked } from "marked";

/**
 * Developer Markdown (README, docs) for the Markdown preview: GitHub-flavoured,
 * images and links kept, then sanitised. Unlike task briefs this is the
 * developer's own file, but it may come from a cloned repository, so scripts,
 * handlers, iframes and forms are still stripped.
 */
const md = new Marked({ gfm: true, breaks: false });

const slug = (t: string) =>
  t
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-");

export function renderDocMarkdown(src: string): string {
  const html = md.parse(src, { async: false }) as string;
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "button", "link", "meta", "base"],
    ADD_ATTR: ["align"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
  // GitHub-style heading anchors so [x](#section) links work.
  return clean.replace(/<h([1-6])>(.*?)<\/h\1>/g, (_m, n, inner) => `<h${n} id="${slug(inner)}">${inner}</h${n}>`);
}

/** Links that leave the workspace (opened in the system browser). */
export function isExternalHref(href: string) {
  return /^(https?:|mailto:)/i.test(href);
}
