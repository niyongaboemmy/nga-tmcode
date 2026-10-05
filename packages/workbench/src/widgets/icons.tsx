import type { ButtonHTMLAttributes, CSSProperties } from "react";
import { extname, basename } from "../util/paths";

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

export function FileIcon({ path, size = 16 }: { path: string; size?: number }) {
  const g = BY_NAME[basename(path).toLowerCase()] ?? BY_EXT[extname(path)];
  if (!g) return <Codicon name="file" className="tm-file-icon tm-file-icon--generic" />;
  const fontSize = g.text.length >= 3 ? size * 0.42 : g.text.length === 2 ? size * 0.5 : size * 0.62;
  return (
    <span
      className="tm-file-icon"
      aria-hidden
      style={{ width: size, height: size, background: g.color, color: g.ink ?? "#ffffff", fontSize }}
    >
      {g.text}
    </span>
  );
}

export function FolderIcon({ open }: { open: boolean }) {
  return <Codicon name={open ? "folder-opened" : "folder"} className="tm-folder-icon" />;
}
