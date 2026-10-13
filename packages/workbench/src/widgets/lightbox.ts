/**
 * A picture at its full size, over the workbench (a brief's screenshots and mock-ups): fitted to the
 * window with its own shape, closed by Escape, a click or the × button.
 */
export function showImageLightbox(src: string, alt = "") {
  document.querySelector(".tm-lightbox")?.remove();
  const root = document.createElement("div");
  root.className = "tm-lightbox";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", alt || "Image");
  root.dataset.testid = "image-lightbox";
  const img = document.createElement("img");
  img.src = src;
  img.alt = alt;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "tm-lightbox-close codicon codicon-close";
  close.setAttribute("aria-label", "Close");
  root.append(img, close);
  const done = () => {
    root.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      done();
    }
  };
  root.addEventListener("click", done);
  window.addEventListener("keydown", onKey, true);
  document.body.append(root);
  close.focus();
}
