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

/** Why a session is locked; each has its own full-window card. */
export type LockReason = "superseded" | "revoked" | "ended" | "submit_failed" | "time_rejected";

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
  /** The deadline passed: the editor is locked and the exam submits itself. */
  timeUp: boolean;
  lock: { reason: LockReason; detail?: string } | null;
  /** While submitting can't reach Task Mentor: when the next attempt starts. */
  retryAt: number | null;
  /** Results polling gave up while Task Mentor was still grading. */
  resultsSlow: boolean;
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
  timeUp: false,
  lock: null,
  retryAt: null,
  resultsSlow: false,
};

export const useExam = create<ExamState>()(() => ({ ...initialExamState }));

export function inExam() {
  const p = useExam.getState().phase;
  return p === "active" || p === "locked" || p === "submitting";
}
