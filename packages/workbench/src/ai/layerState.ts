import { create } from "zustand";
import type { DevicePolicy, Layer } from "@tmcode/protocol";

/**
 * What the AI layer depends on besides Task Mentor's status (ai/gate.ts reads it; ai/layers.ts
 * fills it): the NGA sign-in, the managed device policy (A8), the open project's signed sticky
 * layer (A9) and the user's own choice to lower it (P5). Kept apart from the projects store so
 * the gate stays a pure function of small inputs.
 */

export interface StickyLayer {
  layer: Layer;
  ownTools: boolean;
  /** Task Mentor project id it was signed for. */
  projectId: number;
  /** When it stops applying. */
  exp: string;
}

interface LayerState {
  /** Signed in to NGA (null: not known yet, treated as signed in so nothing flips at start-up). */
  signedIn: boolean | null;
  device: DevicePolicy | null;
  sticky: StickyLayer | null;
  /** The layer the user chose for this project (only ever lower), and whether they chose Guided. */
  choice: Layer | null;
  choseGuided: boolean;
}

export const useLayerInputs = create<LayerState>(() => ({ signedIn: null, device: null, sticky: null, choice: null, choseGuided: false }));
