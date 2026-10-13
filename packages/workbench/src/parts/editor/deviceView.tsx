/**
 * The device frame shared by Live Preview and the built-in browser: a page at a real screen size
 * (phone, tablet, laptop), in its own shape, turned to landscape, zoomed to fit or to a set size.
 * The choice is remembered for every preview in this window.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { openContextMenu } from "../../state/store";
import { ActionButton, Codicon } from "../../widgets/icons";

export const DEVICES = {
  responsive: { label: "Responsive", icon: "screen-full", width: 0, height: 0, frame: "none" },
  mobile: { label: "Mobile (375)", icon: "device-mobile", width: 375, height: 667, frame: "phone" },
  tablet: { label: "Tablet (768)", icon: "browser", width: 768, height: 1024, frame: "tablet" },
  desktop: { label: "Laptop (1280)", icon: "device-desktop", width: 1280, height: 800, frame: "laptop" },
} as const;
export type Device = keyof typeof DEVICES;
export type Zoom = "fit" | 0.5 | 0.75 | 1;

const KEY = "tmcode:preview-device";
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as { device?: Device; landscape?: boolean; zoom?: Zoom };
  } catch {
    return {};
  }
})();

export const useDeviceView = create<{ device: Device; landscape: boolean; zoom: Zoom }>(() => ({
  device: saved.device && saved.device in DEVICES ? saved.device : "responsive",
  landscape: !!saved.landscape,
  zoom: saved.zoom ?? "fit",
}));
useDeviceView.subscribe((s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
});

/** The page's size in CSS pixels for the current device and orientation (0×0: responsive). */
export function deviceSize(device: Device, landscape: boolean) {
  const d = DEVICES[device];
  return landscape && d.width ? { width: d.height, height: d.width } : { width: d.width, height: d.height };
}

/** The scale that shows the device whole in the stage (never larger than 100%). */
export function fitScale(stage: { width: number; height: number }, size: { width: number; height: number }, bezel: number) {
  if (!size.width) return 1;
  const s = Math.min(1, (stage.width - 32) / (size.width + bezel * 2), (stage.height - 56) / (size.height + bezel * 2));
  return Math.max(0.1, s);
}

const BEZEL: Record<string, number> = { none: 0, phone: 12, tablet: 14, laptop: 0 };

/** The toolbar's device controls: sizes, landscape and zoom. */
export function DeviceControls() {
  const { device, landscape, zoom } = useDeviceView();
  const fixed = device !== "responsive";
  return (
    <>
      <div className="tm-segmented" role="radiogroup" aria-label="Device">
        {(Object.keys(DEVICES) as Device[]).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={device === k}
            className={device === k ? "is-on" : ""}
            title={DEVICES[k].label}
            aria-label={DEVICES[k].label}
            onClick={() => useDeviceView.setState({ device: k })}
          >
            <Codicon name={DEVICES[k].icon} />
            {k !== "responsive" && <span>{DEVICES[k].width}</span>}
          </button>
        ))}
      </div>
      {fixed && (
        <>
          <ActionButton icon="sync" label={landscape ? "Portrait" : "Landscape"} active={landscape} aria-pressed={landscape} onClick={() => useDeviceView.setState({ landscape: !landscape })} data-testid="preview-rotate" />
          <button
            type="button"
            className="tm-preview-zoom"
            title="Zoom"
            aria-label="Zoom"
            aria-haspopup="menu"
            data-testid="preview-zoom"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const item = (z: Zoom, label: string) => ({ kind: "item" as const, label: `${zoom === z ? "✓ " : ""}${label}`, run: () => useDeviceView.setState({ zoom: z }) });
              openContextMenu(r.left, r.bottom, [item("fit", "Fit to Window"), { kind: "separator" }, item(0.5, "50%"), item(0.75, "75%"), item(1, "100% (real size)")]);
            }}
          >
            {zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`}
            <Codicon name="chevron-down" />
          </button>
        </>
      )}
    </>
  );
}

/** The stage: the page full size (responsive), or inside its device, centred, with its size below. */
export function DeviceStage({ children, overlay }: { children: ReactNode; overlay?: ReactNode }) {
  const { device, landscape, zoom } = useDeviceView();
  const size = deviceSize(device, landscape);
  const d = DEVICES[device];
  const bezel = BEZEL[d.frame] ?? 0;
  const stageRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setFit(fitScale({ width: el.clientWidth, height: el.clientHeight }, size, bezel));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [size.width, size.height, bezel]);
  const scale = zoom === "fit" ? fit : zoom;
  if (!size.width) {
    return (
      <div ref={stageRef} className="tm-preview-stage">
        <div className="tm-preview-device">{children}</div>
        {overlay}
      </div>
    );
  }
  const outerW = (size.width + bezel * 2) * scale;
  const outerH = (size.height + bezel * 2) * scale;
  return (
    <div ref={stageRef} className="tm-preview-stage is-device" data-device={device} data-landscape={landscape ? "true" : undefined}>
      <div className="tm-preview-sizer" style={{ width: outerW, height: outerH }}>
        <div className={`tm-preview-device is-${d.frame}`} style={{ width: size.width, height: size.height, borderWidth: bezel, transform: `scale(${scale})` }}>
          {children}
        </div>
      </div>
      <div className="tm-preview-dims" data-testid="preview-dims">
        {size.width} × {size.height} · {Math.round(scale * 100)}%
      </div>
      {overlay}
    </div>
  );
}
