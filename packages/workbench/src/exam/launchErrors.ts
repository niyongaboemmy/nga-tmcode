/**
 * Launch failures (review E5): every error code gets a plain title, one line
 * of explanation and the actions that can actually help. Never raw server
 * text or a schema dump as the title.
 */

export type LaunchAction = "retry" | "taskmentor" | "update";

export interface LaunchErrorCopy {
  title: string;
  body: string;
  actions: LaunchAction[];
}

const AGAIN = "Go back to Task Mentor and choose Open in TMCode again.";

export function launchErrorCopy(code: string | null, message: string, data: Record<string, unknown> = {}): LaunchErrorCopy {
  switch (code) {
    case "TICKET_USED":
    case "TICKET_INVALID":
    case "TICKET_EXPIRED":
      return { title: "This exam link has expired", body: `An exam link works once, for 2 minutes. ${AGAIN}`, actions: ["taskmentor"] };
    case "OFFLINE":
      return { title: "TMCode can't reach Task Mentor", body: "Check the Wi-Fi or network cable, then try again.", actions: ["retry", "taskmentor"] };
    case "UNKNOWN_SERVER":
      return { title: "This link isn't from Task Mentor", body: `${message} ${AGAIN}`.trim(), actions: ["taskmentor"] };
    case "APP_TOO_OLD": {
      const min = typeof data.min_app_version === "string" ? data.min_app_version : null;
      return {
        title: min ? `This exam needs TMCode ${min} or newer` : "TMCode is out of date for this exam",
        body: "Update TMCode, then open the exam from Task Mentor again. Your attempt is kept.",
        actions: ["update", "taskmentor"],
      };
    }
    case "UNSUPPORTED_PROFILE":
      return { title: "TMCode can't open a language in this exam", body: "Update TMCode. If it's already up to date, tell your teacher.", actions: ["update", "taskmentor"] };
    case "ATTEMPT_TIME_EXPIRED":
      return { title: "The time for this exam is over", body: "Your saved work stays with Task Mentor. Check your result there.", actions: ["taskmentor"] };
    case "SESSION_SUPERSEDED":
      return { title: "This exam was opened somewhere else", body: `It was opened again on another computer or window. To continue here: ${AGAIN.toLowerCase()}`, actions: ["taskmentor"] };
    case "SESSION_REVOKED":
    case "SESSION_SCOPE":
    case "TOKEN_MISSING":
    case "TOKEN_INVALID":
    case "TOKEN_EXPIRED":
    case "UNAUTHORISED":
    case "HTTP_401":
      return { title: "Your exam session isn't valid any more", body: AGAIN, actions: ["taskmentor"] };
    case "QUIZ_NOT_FOUND":
    case "QUIZ_NOT_AVAILABLE":
      return { title: "This exam isn't open", body: "It may not have started yet, or it has closed. Check the times in Task Mentor.", actions: ["taskmentor"] };
    case "NOT_ENROLLED":
    case "FORBIDDEN":
      return { title: "This exam isn't for your account", body: "Check that you're signed in to Task Mentor as yourself, or ask your teacher.", actions: ["taskmentor"] };
    case "MAX_ATTEMPTS_REACHED":
      return { title: "You have no attempts left", body: "Ask your teacher if you need another attempt.", actions: ["taskmentor"] };
    case "TMCODE_NOT_ENABLED":
      return { title: "This quiz is answered in Task Mentor", body: "It doesn't use TMCode. Answer it on the quiz page in Task Mentor.", actions: ["taskmentor"] };
    case "LOCKDOWN_REQUIRED":
      return { title: "This exam needs Safe Exam Browser", body: "Open it from Safe Exam Browser, as your teacher asked.", actions: ["taskmentor"] };
    case "WORKSPACE_DIRTY":
      return { title: "Save your files first", body: "TMCode couldn't save the files you were working on. Save or close them, then try again.", actions: ["retry"] };
    case "JUDGE_UNAVAILABLE":
    case "SERVER_ERROR":
    case "MOCK_ERROR":
      return { title: "Task Mentor had a problem", body: "This is not your fault. Wait a moment, then try again.", actions: ["retry", "taskmentor"] };
    default:
      if (code && /^HTTP_5\d\d$/.test(code)) return { title: "Task Mentor had a problem", body: "This is not your fault. Wait a moment, then try again.", actions: ["retry", "taskmentor"] };
      return { title: "The exam could not be opened", body: message || "Something went wrong.", actions: ["retry", "taskmentor"] };
  }
}
