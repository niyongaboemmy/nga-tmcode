import { create } from "zustand";
import type { ExamPackage, VisibleTest } from "@tmcode/protocol";
import type { Results } from "./api";

export interface ExamTaskState {
  question_id: number;
  order: number;
  title: string;
  points: number;
  profile_id: string;
  brief_md: string;
  /** Workspace folder of this task ("q1-grade-calculator"). */
  folder: string;
  entry: string;
  visible_tests: VisibleTest[];
  hidden_test_count: number;
  /** Highest journal seq for this task, synced or not. */
  last_seq: number;
}

export type ExamPhase = "idle" | "starting" | "active" | "locked" | "submitting" | "submitted" | "error";

export interface ExamState {
  phase: ExamPhase;
  error: string | null;
  quiz: ExamPackage["quiz"] | null;
  submissionId: number | null;
  sessionId: string | null;
  deadline: number | null;
  tasks: ExamTaskState[];
  activeTask: number | null;
  /** pending: in the journal, not yet on the server; queued: changes not yet snapshotted. */
  sync: { pending: number; queued: number; offline: boolean; lastSyncedAt: number | null; tampered: boolean };
  paused: boolean;
  message: string | null;
  results: Results | null;
}

export const initialExamState: ExamState = {
  phase: "idle",
  error: null,
  quiz: null,
  submissionId: null,
  sessionId: null,
  deadline: null,
  tasks: [],
  activeTask: null,
  sync: { pending: 0, queued: 0, offline: false, lastSyncedAt: null, tampered: false },
  paused: false,
  message: null,
  results: null,
};

export const useExam = create<ExamState>()(() => ({ ...initialExamState }));

export function inExam() {
  const p = useExam.getState().phase;
  return p === "active" || p === "locked" || p === "submitting";
}
