/**
 * Images for TMCode AI: scaled so the long side is at most 1568 px (larger
 * images cost more and read no better), as JPEG unless the original is a
 * small PNG/GIF/WebP that already fits.
 */

export const MAX_IMAGE_SIDE = 1568;
/** Under this, an image that already fits is sent as it is. */
const KEEP_BYTES = 1024 * 1024;

/** The size an image is drawn at. */
export function fitSize(width: number, height: number, max = MAX_IMAGE_SIDE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

const dataUrlBytes = (url: string) => Math.floor(((url.length - url.indexOf(",") - 1) * 3) / 4);

/** A smaller data: URL of the image (the original when it can't be drawn here). */
export async function scaleImage(dataUrl: string): Promise<{ dataUrl: string; size: number }> {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const fit = fitSize(img.naturalWidth, img.naturalHeight);
    const fits = fit.width === img.naturalWidth && fit.height === img.naturalHeight;
    if (fits && dataUrlBytes(dataUrl) <= KEEP_BYTES) return { dataUrl, size: dataUrlBytes(dataUrl) };
    const canvas = document.createElement("canvas");
    canvas.width = fit.width;
    canvas.height = fit.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    // JPEG has no transparency: a white page under it, like a screenshot of a page.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, fit.width, fit.height);
    ctx.drawImage(img, 0, 0, fit.width, fit.height);
    const out = canvas.toDataURL("image/jpeg", 0.85);
    return { dataUrl: out, size: dataUrlBytes(out) };
  } catch {
    return { dataUrl, size: dataUrlBytes(dataUrl) };
  }
}
