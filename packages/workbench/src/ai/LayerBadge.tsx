import { LAYER_INFO, PROFILE_LINE, type Layer } from "@tmcode/protocol";
import { useEffect } from "react";
import { aiExamActive, canChoose, gateLabel, useAiGate, type AiGate } from "./gate";
import { chooseGuided, chooseLayer } from "./layers";
import { useLayerInputs } from "./layerState";
import { showQuickPick, type PickItem } from "../widgets/QuickPick";
import { Codicon } from "../widgets/icons";

/**
 * The AI layer, always visible (proposal §8.8, A2): a status-bar badge (Exam/No AI red with a lock,
 * Learning blue with a lightbulb, Industrial purple with sparkles), the reason on hover, and a menu
 * to lower your own layer. The workbench root carries `data-ai-layer` for the thin title-bar accent.
 */

export function layerTitle(g: AiGate): string {
  const line = g.layer === "industrial" ? PROFILE_LINE[g.profile] : g.layer === "exam" && aiExamActive() ? "No AI during the exam." : LAYER_INFO[g.layer].line;
  return `AI: ${gateLabel(g)}. ${line}${g.detail ? `\n${g.detail}` : ""}${g.layer !== "exam" || g.cause === "choice" ? "\nClick to change it for this project." : ""}`;
}

/** The badge's menu: only ever lower; back to what's set; Guided while Open. */
export async function pickLayer(g: AiGate) {
  const { choice, choseGuided } = useLayerInputs.getState();
  const items: PickItem[] = [];
  const offer = (layer: Layer, label: string, detail: string) => {
    if (layer === g.layer || !canChoose(g, layer)) return;
    items.push({ id: `layer:${layer}`, label, detail, icon: LAYER_INFO[layer].icon });
  };
  offer("learning", "Switch to Learning for This Project", "A tutor that helps you think. You write every line.");
  offer("exam", "No AI for This Project", "Turn every AI feature off here.");
  if (g.layer === "industrial" && g.profile === "open") items.push({ id: "guided", label: "Use Guided for This Project", detail: "Your school's TMCode AI only; explain what you keep.", icon: "mortar-board" });
  if (choice || choseGuided) items.push({ id: "reset", label: "Back to What's Set for You", detail: "Use the layer your school, teacher or device sets.", icon: "discard" });
  if (!items.length) items.push({ id: "why", label: gateLabel(g), detail: g.detail ?? LAYER_INFO[g.layer].line, icon: LAYER_INFO[g.layer].icon });
  const picked = await showQuickPick({ title: `AI layer: ${gateLabel(g)}`, placeholder: g.detail ?? LAYER_INFO[g.layer].line, items });
  if (!picked || picked.id === "why") return;
  if (picked.id === "reset") {
    chooseGuided(false);
    return chooseLayer(null);
  }
  if (picked.id === "guided") return chooseGuided(true);
  chooseLayer(picked.id.slice("layer:".length) as Layer);
}

export function LayerBadge() {
  const g = useAiGate();
  useEffect(() => {
    document.documentElement.dataset.aiLayer = g.layer;
  }, [g.layer]);
  const info = LAYER_INFO[g.layer];
  return (
    <button type="button" className={`tm-status-item is-clickable tm-status-layer is-${g.layer} is-${g.profile}`} title={layerTitle(g)} aria-label={layerTitle(g)} onClick={() => void pickLayer(g)} data-testid="ai-layer-badge" data-layer={g.layer} data-profile={g.profile}>
      <Codicon name={info.icon} />
      <span>{gateLabel(g)}</span>
    </button>
  );
}
