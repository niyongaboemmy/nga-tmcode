import { useEffect, useState } from "react";
import type { IconDTO } from "@tmcode/exthost";
import { useThemes } from "../../themes/themeService";
import { Codicon } from "../../widgets/icons";
import { loadImage, type IconSpec } from "./model";
import { themeColor } from "./themeVars";

/** An extension's image (data: URL once loaded), or null. */
export function useImage(ref: Parameters<typeof loadImage>[0] | null | undefined): string | null {
  const key = !ref ? "" : "codicon" in ref ? "" : JSON.stringify(ref);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!key) return setSrc(null);
    let alive = true;
    void loadImage(JSON.parse(key)).then((s) => alive && setSrc(s));
    return () => {
      alive = false;
    };
  }, [key]);
  return src;
}

/**
 * An icon from an extension: a codicon (`$(name)`, ThemeIcon, with its
 * ThemeColor), or an image from the extension / workspace (per theme kind).
 * `mask` paints monochrome images in the current colour, as VS Code does for
 * activity bar and view container icons.
 */
export function ExtIcon({ icon, className = "", mask = false, size = 16 }: { icon: IconDTO | IconSpec | null | undefined; className?: string; mask?: boolean; size?: number }) {
  const light = useThemes((s) => s.active?.uiTheme === "vs" || s.active?.uiTheme === "hc-light");
  const ref = !icon || "codicon" in icon ? null : "light" in icon ? (light ? icon.light : icon.dark) : icon;
  const src = useImage(ref);
  if (!icon) return null;
  if ("codicon" in icon) {
    const color = "color" in icon && icon.color ? themeColor(icon.color) : undefined;
    return <Codicon name={icon.codicon.replace(/~spin$/, "")} className={`${className} ${/~spin$/.test(icon.codicon) ? "codicon-modifier-spin" : ""}`} style={color ? { color } : undefined} />;
  }
  // Web images (avatars) are outside the workbench's CSP: a neutral glyph stands in.
  if (!src && ref && "url" in ref && /^https?:/.test(ref.url)) return <Codicon name={/avatar|gravatar/i.test(ref.url) ? "account" : "circle-outline"} className={className} />;
  if (!src) return <span className={`tm-ext-icon ${className}`} style={{ width: size, height: size }} aria-hidden />;
  if (mask) return <span className={`tm-ext-icon is-mask ${className}`} style={{ width: size, height: size, WebkitMaskImage: `url("${src}")`, maskImage: `url("${src}")` }} aria-hidden />;
  return <img className={`tm-ext-icon ${className}`} src={src} width={size} height={size} alt="" aria-hidden draggable={false} />;
}

/** A command's icon (`contributes.commands[].icon`): a codicon id or images inside the extension. */
export function commandIcon(icon: string | { light?: string; dark?: string } | undefined, extensionId: string): IconDTO | IconSpec | null {
  if (!icon) return null;
  if (typeof icon === "string") return icon.includes("/") || /\.(svg|png|jpe?g|gif)$/i.test(icon) ? { ext: extensionId, path: icon } : { codicon: icon };
  const l = icon.light ?? icon.dark;
  const d = icon.dark ?? icon.light;
  return l && d ? { light: { ext: extensionId, path: l }, dark: { ext: extensionId, path: d } } : null;
}
