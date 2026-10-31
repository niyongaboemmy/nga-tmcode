import { getDocument } from "../monaco/documents";
import { getPlatform, notify, openFile, useWorkbench } from "../state/store";
import { nextUntitledPath } from "../util/untitled";

/**
 * Help › Report a Problem…: a report you read, edit and copy yourself —
 * TMCode's version, the computer, recent errors and warnings — so a teacher
 * or the TMCode team can help. Nothing is sent anywhere by TMCode.
 */

const recent: { at: number; text: string }[] = [];
let wired = false;

/** Keeps the last errors the page reports (window errors, failed promises). */
export function wireErrorCapture() {
  if (wired) return;
  wired = true;
  const keep = (text: string) => {
    recent.push({ at: Date.now(), text: text.slice(0, 600) });
    if (recent.length > 20) recent.shift();
  };
  window.addEventListener("error", (e) => keep(`${e.message}${e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : ""}`));
  window.addEventListener("unhandledrejection", (e) => keep(`Unhandled: ${String((e.reason as Error)?.message ?? e.reason)}`));
}

/** The report's text (pure on what it is given). */
export function reportText(info: { version: string; os: string; kind: string; locale: string; extensions: number; errors: { at: number; text: string }[]; log: { t: number; channel: string; text: string; level: string }[] }): string {
  const when = (t: number) => new Date(t).toISOString().replace("T", " ").slice(0, 19);
  const lines = [
    "# Problem report",
    "",
    "## What happened",
    "",
    "<!-- Say what you did, what you expected, and what happened instead. -->",
    "",
    "## Steps to see it again",
    "",
    "1. ",
    "",
    "## About this computer",
    "",
    `- TMCode ${info.version} (${info.kind === "desktop" ? "desktop app" : "browser"})`,
    `- System: ${info.os}`,
    `- Language: ${info.locale}`,
    `- Extensions installed: ${info.extensions}`,
    "",
    "## Recent errors",
    "",
    ...(info.errors.length ? info.errors.map((e) => `- ${when(e.at)} ${e.text}`) : ["- none"]),
    "",
    "## Recent warnings in the log",
    "",
    ...(info.log.length ? info.log.map((l) => `- ${when(l.t)} [${l.channel}] ${l.text.replace(/\n/g, " ").slice(0, 300)}`) : ["- none"]),
    "",
  ];
  return lines.join("\n");
}

export async function openReport() {
  const s = useWorkbench.getState();
  const p = getPlatform();
  const extensions = await p.extensions?.list().then((l) => l.length).catch(() => 0) ?? 0;
  const text = reportText({
    version: p.version,
    os: p.os,
    kind: p.kind,
    locale: s.settings.locale ?? "en",
    extensions,
    errors: recent,
    log: s.output.filter((l) => l.level === "warn" || l.level === "error").slice(-15),
  });
  const open = s.groups.flatMap((g) => g.editors).flatMap((e) => (e.kind === "file" ? [e.path] : []));
  const path = nextUntitledPath(open);
  openFile(path, { pinned: true });
  for (let i = 0; i < 50 && !getDocument(path); i++) await new Promise((r) => setTimeout(r, 20));
  getDocument(path)?.setValue(text);
  notify("info", "Your problem report is open. Fill in what happened, then copy it to your teacher or the TMCode team. TMCode doesn't send it.", [
    {
      label: "Copy Report",
      run: () => {
        const t = getDocument(path)?.getValue() ?? text;
        const clip = getPlatform().clipboard;
        void (clip ? clip.writeText(t) : navigator.clipboard.writeText(t)).catch(() => notify("warning", "Could not copy the report."));
      },
    },
  ]);
}
