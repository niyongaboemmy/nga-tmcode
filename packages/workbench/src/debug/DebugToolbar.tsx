import { useEffect, useRef, useState } from "react";
import { executeCommand, formatKeybinding } from "../commands/registry";
import { getPlatform } from "../state/store";
import { ActionButton, Codicon } from "../widgets/icons";
import { useDebug } from "./debugService";

const POS_KEY = "debug.toolbarX";

/**
 * VS Code's floating debug toolbar: top centre, draggable sideways by its
 * gripper, Continue/Pause · Step Over · Step Into · Step Out · Restart · Stop.
 */
export function DebugToolbar() {
  const phase = useDebug((s) => s.phase);
  const os = getPlatform().os;
  const [x, setX] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: number; from: number } | null>(null);

  useEffect(() => {
    void getPlatform()
      .store.get<number>(POS_KEY)
      .then((v) => typeof v === "number" && setX(v))
      .catch(() => {});
  }, []);

  if (phase === "inactive") return null;
  const kb = (k: string) => formatKeybinding(k, os);
  const stopped = phase === "stopped";
  const clamp = (v: number) => Math.max(0, Math.min(1, v));

  return (
    <div
      ref={ref}
      className="tm-debug-toolbar"
      role="toolbar"
      aria-label="Debug Toolbar"
      data-testid="debug-toolbar"
      style={x !== null ? { left: `${x * 100}%` } : undefined}
    >
      <span
        className="tm-debug-toolbar-grip"
        aria-hidden
        title="Drag to move"
        onPointerDown={(e) => {
          const parent = ref.current?.parentElement?.getBoundingClientRect();
          if (!parent) return;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { start: e.clientX, from: x ?? 0.5 };
        }}
        onPointerMove={(e) => {
          const parent = ref.current?.parentElement?.getBoundingClientRect();
          if (!drag.current || !parent) return;
          setX(clamp(drag.current.from + (e.clientX - drag.current.start) / parent.width));
        }}
        onPointerUp={() => {
          drag.current = null;
          if (x !== null) void getPlatform().store.set(POS_KEY, x);
        }}
        onDoubleClick={() => {
          setX(null);
          void getPlatform().store.set(POS_KEY, 0.5);
        }}
      >
        <Codicon name="gripper" />
      </span>
      {stopped ? (
        <ActionButton icon="debug-continue" className="tm-dbg-continue" label={`Continue (${kb("f5")})`} onClick={() => executeCommand("workbench.action.debug.continue")} />
      ) : (
        <ActionButton icon="debug-pause" label={`Pause (${kb("f6")})`} disabled={phase !== "running"} onClick={() => executeCommand("workbench.action.debug.pause")} />
      )}
      <ActionButton icon="debug-step-over" label={`Step Over (${kb("f10")})`} disabled={!stopped} onClick={() => executeCommand("workbench.action.debug.stepOver")} />
      <ActionButton icon="debug-step-into" label={`Step Into (${kb("f11")})`} disabled={!stopped} onClick={() => executeCommand("workbench.action.debug.stepInto")} />
      <ActionButton icon="debug-step-out" label={`Step Out (${kb("shift+f11")})`} disabled={!stopped} onClick={() => executeCommand("workbench.action.debug.stepOut")} />
      <ActionButton icon="debug-restart" className="tm-dbg-restart" label={`Restart (${kb("mod+shift+f5")})`} onClick={() => executeCommand("workbench.action.debug.restart")} />
      <ActionButton icon="debug-stop" className="tm-dbg-stop" label={`Stop (${kb("shift+f5")})`} onClick={() => executeCommand("workbench.action.debug.stop")} />
    </div>
  );
}
