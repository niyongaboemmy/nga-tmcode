export { Workbench } from "./Workbench";
export { initWorkbench, setWorkspace, setPolicy, notify, log, useWorkbench } from "./state/store";
export { createMemoryPlatform, MemoryFileSystem, DEMO_PROJECT, simulateExternalWrite } from "./platform/memory";
export { openPathFromOs } from "./state/store";
export { beforeQuit, registerQuitGuard, type QuitGuard } from "./state/quit";
export { checkForUpdates, useUpdate } from "./update/updateService";
export type * from "./platform/types";
export { registerCommand, executeCommand } from "./commands/registry";
export { startedWorkers, selfCheckWorkers } from "./monaco/setup";
export { PREVIEW_MESSAGE_KEY, injectIntoHead, shimTag } from "./preview/compose";
export { composeReactPage } from "./preview/page";
export { loadTests, runTests } from "./run/testService";
export { startExam, parseLaunchLink, stopExam, submitExam, checkExamInProgress } from "./exam/session";
export { getPlatform as getPlatformForSelfTest } from "./state/store";
export type { JournalEntry } from "./platform/types";
export { useExam } from "./exam/state";
export { isAllowedApi } from "./exam/api";
export { DapSession } from "./debug/dapSession";
export { runUiProbe, watchCspViolations, type UiCheck } from "./selftest/uiProbe";
export { parseProjectLink, openProjectLink } from "./projects/service";
export { parseAssignmentLink, openAssignmentLink } from "./projects/assignments";
// Native self-test (apps/desktop/src/selftest.ts, TMCODE_DEV_SELFTEST=projects).
export * as projectsForSelfTest from "./projects/service";
export * as assignmentsForSelfTest from "./projects/assignments";
// Native self-test (TMCODE_DEV_SELFTEST=exthost).
export * as exthostForSelfTest from "./exthost/selftestApi";
