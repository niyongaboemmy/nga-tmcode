import type { ButtonHTMLAttributes, CSSProperties } from "react";
import { extname, basename } from "../util/paths";
import { fontCharacter, iconFont, iconImage, resolveIcon, useIconTheme, type ActiveIconTheme } from "../themes/iconThemes";
import { useThemes } from "../themes/themeService";

export function Codicon({ name, className = "", style, title }: { name: string; className?: string; style?: CSSProperties; title?: string }) {
  return <span className={`codicon codicon-${name} ${className}`} style={style} title={title} aria-hidden={title ? undefined : true} />;
}

/** A square icon button as used in view titles, tabs and the title bar. */
export function ActionButton({
  icon,
  label,
  active,
  className = "",
  ...rest
}: { icon: string; label: string; active?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`tm-action ${active ? "is-active" : ""} ${className}`} aria-label={label} title={label} {...rest}>
      <Codicon name={icon} />
    </button>
  );
}

interface FileGlyph {
  text: string;
  color: string;
  /** Text colour on the badge when `color` is light. */
  ink?: string;
}

/**
 * Compact, colour-coded file glyphs (in the spirit of the Seti / Material icon
 * themes) so students can tell file types apart at a glance.
 */
const BY_EXT: Record<string, FileGlyph> = {
  py: { text: "py", color: "#3776ab" },
  js: { text: "JS", color: "#e8d44d", ink: "#1f1f1f" },
  mjs: { text: "JS", color: "#e8d44d", ink: "#1f1f1f" },
  cjs: { text: "JS", color: "#e8d44d", ink: "#1f1f1f" },
  jsx: { text: "⚛", color: "#149eca" },
  ts: { text: "TS", color: "#3178c6" },
  tsx: { text: "⚛", color: "#3178c6" },
  html: { text: "<>", color: "#e44d26" },
  htm: { text: "<>", color: "#e44d26" },
  css: { text: "#", color: "#663399" },
  scss: { text: "S", color: "#cd6799" },
  json: { text: "{}", color: "#cbcb41", ink: "#1f1f1f" },
  md: { text: "M↓", color: "#519aba" },
  java: { text: "J", color: "#e76f00" },
  class: { text: "J", color: "#b07219" },
  c: { text: "C", color: "#5c6bc0" },
  h: { text: "h", color: "#7e57c2" },
  cpp: { text: "C+", color: "#f34b7d" },
  cc: { text: "C+", color: "#f34b7d" },
  hpp: { text: "h+", color: "#a074c4" },
  php: { text: "php", color: "#777bb4" },
  sql: { text: "SQL", color: "#e38c00" },
  go: { text: "go", color: "#00add8" },
  rs: { text: "rs", color: "#dea584", ink: "#1f1f1f" },
  txt: { text: "≡", color: "#8a8a8a" },
  csv: { text: "csv", color: "#89e051", ink: "#1f1f1f" },
  svg: { text: "svg", color: "#ffb13b", ink: "#1f1f1f" },
  png: { text: "img", color: "#a074c4" },
  jpg: { text: "img", color: "#a074c4" },
  gif: { text: "img", color: "#a074c4" },
  sh: { text: "$", color: "#4eaa25" },
  yml: { text: "yml", color: "#cb171e" },
  yaml: { text: "yml", color: "#cb171e" },
  xml: { text: "xml", color: "#e37933" },
};

const BY_NAME: Record<string, FileGlyph> = {
  "package.json": { text: "npm", color: "#cb3837" },
  ".gitignore": { text: "git", color: "#f14e32" },
  dockerfile: { text: "🐳", color: "#2496ed" },
  "requirements.txt": { text: "py", color: "#3776ab" },
};

/** Light / dark / high-contrast variant of the active colour theme, for icon themes' `light` and `highContrast` sections. */
function useIconVariant(): "dark" | "light" | "hc" {
  const ui = useThemes((s) => s.active?.uiTheme ?? "vs-dark");
  // High Contrast Light keeps a theme's light colours (Seti's dark ones are too pale on white).
  return ui === "vs" || ui === "hc-light" ? "light" : ui === "hc-black" ? "hc" : "dark";
}

/**
 * One icon definition of a file icon theme: an image, or a glyph from the
 * theme's font. `data-icon` names the definition ("_python"), so tests and
 * screen-reader tooling can tell which icon a row shows.
 */
function ThemedIcon({ active, defId, size }: { active: ActiveIconTheme; defId: string; size: number }) {
  useIconTheme((s) => s.assets);
  const def = active.doc?.iconDefinitions?.[defId];
  const data = { "data-icon": defId, "data-icon-theme": active.entry.id };
  if (!def) return <span className="tm-themed-icon" style={{ width: size, height: size }} aria-hidden {...data} />;
  if (def.codicon) return <span className={`codicon codicon-${def.codicon} tm-themed-icon tm-file-icon--generic`} style={{ width: size, height: size }} aria-hidden {...data} />;
  if (def.iconPath) {
    const src = iconImage(active, defId);
    return src ? (
      <img className="tm-themed-icon" src={src} width={size} height={size} alt="" aria-hidden draggable={false} {...data} />
    ) : (
      <span className="tm-themed-icon" style={{ width: size, height: size }} aria-hidden {...data} />
    );
  }
  if (def.fontCharacter) {
    const font = iconFont(active, def);
    return (
      <span
        className="tm-themed-icon tm-themed-icon--font"
        aria-hidden
        {...data}
        style={{ width: size, height: size, fontFamily: font?.family, color: def.fontColor, fontSize: font?.size ?? `${size}px`, lineHeight: `${size}px` }}
      >
        {fontCharacter(def.fontCharacter)}
      </span>
    );
  }
  return <span className="tm-themed-icon" style={{ width: size, height: size }} aria-hidden {...data} />;
}

export function FileIcon({ path, size = 16 }: { path: string; size?: number }) {
  const active = useIconTheme((s) => s.active);
  const variant = useIconVariant();
  if (active.entry.id === "none") return null;
  if (active.doc) {
    const defId = resolveIcon(active.doc, path, "file", { variant });
    if (defId) return <ThemedIcon active={active} defId={defId} size={size} />;
  }
  const ext = extname(path);
  const g = BY_NAME[basename(path).toLowerCase()] ?? BY_EXT[ext];
  if (!g) return <Codicon name="file" className="tm-file-icon tm-file-icon--generic" />;
  const fontSize = g.text.length >= 3 ? size * 0.42 : g.text.length === 2 ? size * 0.5 : size * 0.62;
  return (
    <span
      className="tm-file-icon"
      aria-hidden
      data-icon={`tmcode:${ext || basename(path).toLowerCase()}`}
      data-icon-theme="tmcode"
      style={{ width: size, height: size, background: g.color, color: g.ink ?? "#ffffff", fontSize }}
    >
      {g.text}
    </span>
  );
}

export function FolderIcon({ open, name = "" }: { open: boolean; name?: string }) {
  const active = useIconTheme((s) => s.active);
  const variant = useIconVariant();
  if (active.entry.id === "none") return null;
  if (active.doc) {
    const defId = resolveIcon(active.doc, name, "folder", { expanded: open, variant });
    // Icon themes without folder icons (Seti, Minimal) show none, only the twistie, as in VS Code.
    return defId ? <ThemedIcon active={active} defId={defId} size={16} /> : null;
  }
  return <Codicon name={open ? "folder-opened" : "folder"} className="tm-folder-icon" />;
}
