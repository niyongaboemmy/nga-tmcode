import DOMPurify from "dompurify";

/**
 * Rich text written in Task Mentor (assignment briefs, instructions) shown in
 * TMCode. Teachers write it in a rich editor that bakes in its own look:
 * `color: black`, white backgrounds, Times New Roman, fixed sizes. In a dark
 * theme that is black text on black. Here the theme decides colours and fonts:
 * only the structure (headings, lists, emphasis, tables, alignment) is kept.
 *
 * Task Mentor stores uploaded images as `/uploads/…`, relative to its own
 * server: they are made absolute against `base` (the Task Mentor API origin,
 * which serves /uploads). Images from other sites become a link instead of a
 * broken box: the app only loads images from NGA servers (tauri.conf.json CSP).
 */

/** Style properties that carry structure, not a look: kept. Everything else (colours, fonts, sizes…) goes. */
const KEPT_STYLE = new Set(["text-align", "font-weight", "font-style", "text-decoration", "text-decoration-line", "list-style-type", "vertical-align"]);

/** Hosts the app may load images from (keep in step with img-src in tauri.conf.json). */
export function imageHostAllowed(url: URL, base: URL | null): boolean {
  if (url.protocol === "data:" || url.protocol === "blob:") return true;
  if (base && url.origin === base.origin) return true;
  if (url.protocol === "https:" && (url.hostname === "amashuri.com" || url.hostname.endsWith(".amashuri.com"))) return true;
  return /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
}

function keptStyle(style: string): string {
  return style
    .split(";")
    .map((d) => d.trim())
    .filter((d) => {
      const prop = d.split(":")[0]?.trim().toLowerCase();
      return !!prop && KEPT_STYLE.has(prop) && !/url\(|expression\(/i.test(d);
    })
    .join("; ");
}

export function taskMentorHtml(html: string, base?: string | null): string {
  let baseUrl: URL | null = null;
  try {
    baseUrl = base ? new URL(base) : null;
  } catch {
    baseUrl = null;
  }
  const absolute = (raw: string): URL | null => {
    try {
      return baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    } catch {
      return null;
    }
  };

  const onAttr = (node: Element, data: { attrName: string; attrValue: string; keepAttr: boolean }) => {
    const name = data.attrName.toLowerCase();
    if (name === "style") {
      const kept = keptStyle(data.attrValue);
      if (kept) data.attrValue = kept;
      else data.keepAttr = false;
    } else if (name === "color" || name === "bgcolor" || name === "face" || name === "background" || (name === "size" && node.nodeName === "FONT")) {
      data.keepAttr = false;
    } else if ((name === "href" || name === "src") && data.attrValue && !/^(#|mailto:|data:)/i.test(data.attrValue)) {
      const u = absolute(data.attrValue);
      if (u && /^(https?|data|blob):$/.test(u.protocol)) data.attrValue = u.href;
    }
  };
  const afterAttrs = (node: Element) => {
    if (node.nodeName !== "IMG") return;
    const src = node.getAttribute("src") ?? "";
    const u = absolute(src);
    node.setAttribute("loading", "lazy");
    if (!node.getAttribute("alt")) node.setAttribute("alt", "");
    if (u && imageHostAllowed(u, baseUrl)) return;
    // Not loadable here: a link to open it in the browser instead of an empty box.
    const a = node.ownerDocument.createElement("a");
    a.setAttribute("href", u?.href ?? src);
    a.setAttribute("class", "tm-ext-image");
    a.textContent = `Open image${u ? ` (${u.hostname})` : ""}`;
    node.replaceWith(a);
  };

  DOMPurify.addHook("uponSanitizeAttribute", onAttr as never);
  DOMPurify.addHook("afterSanitizeAttributes", afterAttrs as never);
  try {
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "button", "input", "link", "meta", "base"],
    }) as string;
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes");
    DOMPurify.removeHook("uponSanitizeAttribute");
  }
}
