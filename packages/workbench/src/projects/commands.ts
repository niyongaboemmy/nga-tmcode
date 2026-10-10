import { registerCommand } from "../commands/registry";
import { inExam } from "../exam/state";
import { confirmLeaveWorkspace, getPlatform, notify, openFile, openPathFromOs, openRecent, revealView, showDialog, showPanel, useWorkbench } from "../state/store";
import { showInputBox, showQuickPick } from "../widgets/QuickPick";
import {
  checkSync,
  compareConflict,
  connectFolder,
  createProject,
  disconnectFolder,
  setSharePresence,
  withdrawSubmission,
  removeProject,
  restoreProject,
  projectsSupported,
  pullFromTaskMentor,
  refreshProjects,
  saveToTaskMentor,
  signIn,
  signOut,
  signedIn,
  submitLink,
  useProjects,
} from "./service";
import { CATEGORY_ORDER, TEMPLATES, templateById, type Template } from "./templates";
import { publishAsStarter, refreshAssignments, startAssignment, useAssignments } from "./assignments";
import { closeReview, refreshGrading, useGrading } from "../grading/service";
import { changeAssessment, linkProject, pickAssessment, startQuizPractical, submitProject } from "./matching";
import { explainSubmitError, notifySubmitted } from "./submitFlow";
import type { ProjectKind } from "./types";

const usable = () => projectsSupported() && useWorkbench.getState().policy.mode === "practice";
const bound = () => usable() && !!useProjects.getState().binding;

/** Task Mentor's web app for an API origin (taskmentor-api.x → taskmentor.x). */
export function taskMentorWeb(api: string) {
  if (/^https:\/\/taskmentor-api\./.test(api)) return api.replace("://taskmentor-api.", "://taskmentor.");
  return "http://localhost:5173/taskmentor";
}

export function openInTaskMentor(projectId: number) {
  const api = useProjects.getState().account?.tm_api ?? "https://taskmentor-api.amashuri.com";
  const url = `${taskMentorWeb(api)}/projects/${projectId}`;
  const p = getPlatform();
  if (p.openExternal) void p.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/** A Task Mentor web page (`/assignments/create`, `/assignments`) in the system browser. */
export function openTaskMentorPage(path: string) {
  const api = useProjects.getState().account?.tm_api ?? "https://taskmentor-api.amashuri.com";
  const url = `${taskMentorWeb(api)}${path}`;
  const p = getPlatform();
  if (p.openExternal) void p.openExternal(url);
  else window.open(url, "_blank", "noopener");
}

export function openAssignmentInTaskMentor(assignmentId: number) {
  const api = useProjects.getState().account?.tm_api ?? "https://taskmentor-api.amashuri.com";
  const url = `${taskMentorWeb(api)}/assignments/${assignmentId}`;
  const p = getPlatform();
  if (p.openExternal) void p.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export async function submitFromView(linkId: number) {
  const b = useProjects.getState().binding;
  if (!b) return;
  try {
    const res = await submitLink(b.project_id, linkId);
    notifySubmitted(`"${b.name}"`, res.submission);
  } catch (e) {
    const link = useProjects.getState().current?.links;
    await explainSubmitError(e, Array.isArray(link) ? link.find((l) => l.id === linkId) : undefined);
  }
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "project";

/** Template items grouped by category, with the tools each needs. */
function templateItems() {
  return CATEGORY_ORDER.flatMap((cat) =>
    TEMPLATES.filter((t) => t.category === cat).map((t, i) => ({
      id: `tpl:${t.id}`,
      label: t.label,
      description: t.description,
      detail: t.tools?.length ? `Needs ${t.tools.join(", ")}${t.setup ? ` · setup: ${t.setup.command}` : ""}` : undefined,
      icon: t.icon,
      separator: i === 0 ? cat : undefined,
    })),
  );
}

/** Writes a template's files into the open folder. */
export async function writeTemplate(tpl: Template) {
  const fs = getPlatform().fs;
  for (const [path, content] of Object.entries(tpl.files)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) await fs.createDir(parts.slice(0, i).join("/")).catch(() => {});
    await fs.writeFile(path, content).catch(async () => {
      await fs.createFile(path);
      await fs.writeFile(path, content);
    });
  }
  // The explorer lists the new files at once (the watcher would, a moment later, on the desktop only).
  const { applyExternalChanges } = await import("../monaco/external");
  await applyExternalChanges(Object.keys(tpl.files));
  const readme = Object.keys(tpl.files).find((p) => /^readme\.md$/i.test(p));
  const main = Object.keys(tpl.files).find((p) => !p.startsWith(".") && !/readme\.md$/i.test(p) && !/^(package|tsconfig|angular|nest-cli)\.json$|\.(toml|xml|yaml|csproj|mod)$|^Makefile$|^Gemfile$|^Package\.swift$|^requirements\.txt$/.test(p.split("/").pop()!));
  if (tpl.main && tpl.files[tpl.main] !== undefined) openFile(tpl.main, { pinned: true });
  else if (main) openFile(main, { pinned: true });
  else if (readme) openFile(readme, { pinned: true });
}

/** Runs the template's setup (npm install, flutter create …) in a terminal, when the user agrees. */
export async function offerSetup(tpl: Template) {
  if (!tpl.setup) return;
  if (!getPlatform().terminal) {
    notify("info", `Next: run \`${tpl.setup.command}\` in a terminal (${tpl.setup.note.toLowerCase()}).`);
    return;
  }
  const go = await showDialog({
    severity: "info",
    message: `Set up ${tpl.label} now?`,
    detail: `${tpl.setup.note}. TMCode runs this in a terminal:\n\n${tpl.setup.command}${tpl.tools?.length ? `\n\nNeeds ${tpl.tools.join(", ")} on this computer (Run and Debug › How to Install… if missing).` : ""}`,
    buttons: [
      { id: "run", label: "Run Setup", primary: true },
      { id: "later", label: "Later" },
    ],
    cancelId: "later",
  });
  if (go !== "run") return;
  showPanel("terminal");
  window.dispatchEvent(new CustomEvent("tmcode:new-terminal", { detail: { command: tpl.setup.command, cwd: "", name: `Setup: ${tpl.label}` } }));
}

/** New Project from Template (no Task Mentor needed): a new folder with the files, opened. */
export async function newProjectFromTemplate() {
  const pick = await showQuickPick({ placeholder: "Create a project from a template", matchOnDescription: true, items: templateItems() });
  if (!pick) return;
  const tpl = templateById(pick.id.slice(4))!;
  const name = await showInputBox({ title: `New ${tpl.label} project`, prompt: "Folder name", value: tpl.id, validate: (v) => (v.trim().length < 2 ? "Enter a name (2 characters or more)." : /[\\/:*?"<>|]/.test(v) ? "Use letters, numbers, - and _." : null) });
  if (!name) return;
  const host = getPlatform().account;
  if (!host) return notify("info", "New projects from templates need the TMCode desktop app.");
  if (!(await confirmLeaveWorkspace())) return;
  try {
    const folder = await host.newFolder(slugify(name));
    // Kept the current folder (Cancel on unsaved files): never write the template into it.
    if (!(await (getPlatform().openPath ? openPathFromOs(folder) : openRecent(folder)))) return;
    await writeTemplate(tpl);
    notify("info", `Created ${name} from the ${tpl.label} template. Run Project: ⌘/Ctrl+Shift+F10.`);
    await offerSetup(tpl);
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

/** New Project: the open folder, a GitHub repository, or a template in a new folder. `from: "folder"` skips the choice. */
async function newProject(opts: { from?: "folder" } = {}) {
  if (!signedIn()) return void signIn();
  const ws = useWorkbench.getState().workspace;
  // Your own work first: with a folder open, saving it is what you most likely want.
  const choice =
    opts.from === "folder" && ws
      ? { id: "folder" }
      : await showQuickPick({
          placeholder: "Create a Task Mentor project",
          items: [
            ...(ws ? [{ id: "folder", label: `This folder (${ws.name})`, description: "Save the open folder to Task Mentor", icon: "folder-opened", separator: "from your work" }] : []),
            { id: "github", label: "A GitHub repository", description: "Task Mentor follows your git pushes", icon: "github", separator: ws ? undefined : "from your work" },
            ...templateItems(),
          ],
        });
  if (!choice) return;
  const name = await showInputBox({ title: choice.id === "folder" ? `Connect "${ws?.name}" to Task Mentor` : "New Project", prompt: "Project name (as your teacher will see it)", value: choice.id === "folder" ? ws?.name : "", validate: (v) => (v.trim().length < 2 ? "Enter a name (2 characters or more)." : v.length > 120 ? "The name is too long." : null) });
  if (!name) return;
  let kind: ProjectKind = "tm";
  let repo_url: string | undefined;
  if (choice.id === "github") {
    kind = "github";
    const gitRemote = useWorkbench.getState().workspace ? await guessRemote() : null;
    repo_url = await showInputBox({ title: "GitHub repository", prompt: "Repository URL", value: gitRemote ?? "https://github.com/", validate: (v) => (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/.test(v.trim()) ? null : "Enter a https://github.com/owner/repo URL.") });
    if (!repo_url) return;
  }
  // Which assessment is this project for? (Optional: personal projects stay unmatched.)
  const assessment = await pickAssessment({ title: `Which assessment is "${name.trim()}" for?`, allowNone: true });
  if (!assessment) return;
  if (assessment !== "none" && assessment.question) {
    // A quiz's TMCode practical: Task Mentor creates the project from the question's starter files.
    const go = await showDialog({
      severity: "info",
      message: `"${assessment.question.title}" is a TMCode practical`,
      detail: `Start it to get your teacher's starter files in a workspace linked to the quiz "${assessment.title}". The name you typed isn't needed: Task Mentor names the workspace after the question.`,
      buttons: [
        { id: "start", label: "Start the Practical", primary: true },
        { id: "cancel", label: "Cancel" },
      ],
      cancelId: "cancel",
    });
    if (go === "start") await startQuizPractical(assessment, assessment.question);
    return;
  }
  if (assessment !== "none" && assessment.activity_type === "assignment") {
    // A TMCode practical with the teacher's starter files is started, not created from scratch.
    const practical = useAssignments.getState().student?.find((a) => a.id === assessment.activity_id);
    if (practical) {
      const go = await showDialog({
        severity: "info",
        message: `"${practical.title}" is a TMCode practical`,
        detail: "Start it from the Assignments view instead: you get your teacher's starter files and the brief beside your code.",
        buttons: [
          { id: "start", label: "Start the Practical", primary: true },
          { id: "cancel", label: "Cancel" },
        ],
        cancelId: "cancel",
      });
      if (go === "start") await startAssignment(practical.id);
      return;
    }
  }
  const tpl = choice.id.startsWith("tpl:") ? templateById(choice.id.slice(4)) : null;
  try {
    const project = await createProject({ name: name.trim(), kind, repo_url: repo_url?.trim(), language: tpl?.language });
    if (!project) return;
    const matched = assessment !== "none" ? await linkProject(project.id, assessment).catch((e) => (notify("warning", `Created, but not matched: ${(e as Error).message}`), null)) : null;
    if (tpl) {
      const host = getPlatform().account!;
      const folder = await host.newFolder(slugify(name));
      if (!(await (getPlatform().openPath ? openPathFromOs(folder) : openRecent(folder)))) {
        notify("info", `Created ${project.name} in Task Mentor. Open it from Projects to start.`);
        return;
      }
      await writeTemplate(tpl);
      await connectFolder(project);
      await saveToTaskMentor({ message: `Created from the ${tpl.label} template`, quiet: true });
      notify("info", `Created ${project.name} from the ${tpl.label} template and saved it to Task Mentor.`);
      await offerSetup(tpl);
    } else if (choice.id === "folder" || kind === "github") {
      if (useWorkbench.getState().workspace) await connectFolder(project);
      if (kind === "tm") await saveToTaskMentor({ message: "First save from TMCode", quiet: true });
    }
    // One message for the whole thing (saved + matched), not one per step.
    const where = kind === "github" ? `linked to ${repo_url}: Task Mentor follows your pushes` : "saved to Task Mentor";
    const forWhat = matched && assessment !== "none" ? ` for "${assessment.question?.title ?? assessment.title}". Submit it when your work is ready.` : ".";
    if (!tpl) notify("info", `${project.name} is ${where}${forWhat}`);
    if (matched) await checkSync();
    revealView("projects");
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

async function guessRemote(): Promise<string | null> {
  try {
    const text = await getPlatform().fs.readFile(".git/config");
    const m = /url\s*=\s*(\S*github\.com[:/][\w.-]+\/[\w.-]+?)(\.git)?\s*$/m.exec(text);
    return m ? m[1].replace(/^git@github\.com:/, "https://github.com/") : null;
  } catch {
    return null;
  }
}

async function connect() {
  if (!signedIn()) return void signIn();
  const { mine } = useProjects.getState();
  // Nothing to choose from: straight to naming the new project.
  if (!mine?.length) return newProject({ from: "folder" });
  const items = [
    { id: "new", label: "New Project from This Folder…", icon: "add", description: "Create a Task Mentor project and save this folder to it" },
    ...(mine ?? []).map((p, i) => ({ id: String(p.id), label: p.name, description: p.kind === "github" ? p.repo_full_name ?? "GitHub" : "Task Mentor", icon: p.kind === "github" ? "github" : "cloud", separator: i === 0 ? "existing projects" : undefined })),
  ];
  const pick = await showQuickPick({ placeholder: "Connect this folder to a Task Mentor project", items, matchOnDescription: true });
  if (!pick) return;
  if (pick.id === "new") return newProject({ from: "folder" });
  const project = mine?.find((p) => String(p.id) === pick.id);
  if (project) {
    await connectFolder(project);
    notify("info", project.kind === "tm" ? `Connected to ${project.name}. Save to Task Mentor uploads your changes; Get Latest brings newer ones.` : `Connected to ${project.name} (GitHub).`);
  }
}

export function registerProjectCommands() {
  registerCommand({ id: "workbench.view.projects", title: "Show Task Mentor Projects", category: "View", keybinding: "mod+shift+j", enabled: usable, run: () => revealView("projects") });
  registerCommand({ id: "projects.signIn", title: "Sign in with NGA (Central MIS + Task Mentor)", category: "Accounts", enabled: () => usable() && !signedIn(), run: signIn });
  registerCommand({ id: "projects.signOut", title: "Sign Out of NGA", category: "Accounts", enabled: () => signedIn(), run: signOut });
  registerCommand({ id: "projects.new", title: "New Project…", category: "Projects", enabled: usable, run: () => newProject() });
  registerCommand({ id: "projects.connectFolder", title: "Connect This Folder to Task Mentor…", category: "Projects", enabled: () => usable() && !!useWorkbench.getState().workspace, run: connect });
  registerCommand({ id: "projects.save", title: "Save to Task Mentor", category: "Projects", keybinding: "mod+alt+u", enabled: bound, run: () => saveToTaskMentor() });
  registerCommand({ id: "projects.pull", title: "Get Latest from Task Mentor", category: "Projects", enabled: bound, run: () => pullFromTaskMentor() });
  // Conflicts › Compare: Task Mentor's copy against this folder's (picks a conflict when there are several;
  // the Projects view's per-file button calls compareConflict(path) directly).
  registerCommand({
    id: "projects.compareConflict",
    title: "Compare Conflict with Task Mentor's Copy…",
    category: "Projects",
    enabled: () => bound() && (useProjects.getState().plan?.conflicts.length ?? 0) > 0,
    run: () => compareConflict(),
  });
  registerCommand({ id: "projects.refresh", title: "Refresh Projects", category: "Projects", enabled: () => usable() && signedIn(), run: async () => (await refreshProjects(), await checkSync()) });
  registerCommand({ id: "projects.linkActivity", title: "Change Assessment…", category: "Projects", enabled: bound, run: changeAssessment });
  registerCommand({
    id: "projects.submit",
    title: "Submit Project…",
    category: "Projects",
    enabled: () => bound() && !["submitted", "graded", "removed"].includes(useProjects.getState().current?.status ?? "draft"),
    run: submitProject,
  });
  registerCommand({
    id: "projects.remove",
    title: "Remove Project…",
    category: "Projects",
    enabled: () => bound() && !!useProjects.getState().current && ["draft", undefined].includes(useProjects.getState().current?.status),
    run: () => removeProject(useProjects.getState().current!).then(() => undefined),
  });
  registerCommand({
    id: "projects.restore",
    title: "Restore Project",
    category: "Projects",
    enabled: () => bound() && useProjects.getState().current?.status === "removed",
    run: () => restoreProject(useProjects.getState().current!.id),
  });
  registerCommand({
    id: "projects.openInTaskMentor",
    title: "Open Project in Task Mentor",
    category: "Projects",
    enabled: bound,
    run: () => openInTaskMentor(useProjects.getState().binding!.project_id),
  });
  registerCommand({ id: "projects.disconnect", title: "Disconnect This Folder from Task Mentor…", category: "Projects", enabled: bound, run: disconnectFolder });
  registerCommand({
    id: "projects.toggleSharePresence",
    title: "Toggle Sharing Live Status with Teachers",
    category: "Projects",
    enabled: () => bound() && !!useProjects.getState().current,
    run: () => {
      const p = useProjects.getState().current!;
      return setSharePresence(p.id, p.share_presence === false);
    },
  });
  registerCommand({
    id: "projects.withdraw",
    title: "Withdraw to Edit",
    category: "Projects",
    enabled: () => bound() && useProjects.getState().current?.status === "submitted",
    run: () => withdrawSubmission(useProjects.getState().current!.id),
  });
  registerCommand({ id: "workbench.action.newProjectFromTemplate", title: "New Project from Template…", category: "File", enabled: () => !!getPlatform().account && !inExam(), run: newProjectFromTemplate });
  registerCommand({ id: "workbench.view.grading", title: "Show Grading", category: "View", enabled: () => usable() && useGrading.getState().grader, run: () => revealView("grading") });
  registerCommand({ id: "grading.refresh", title: "Refresh Grading", category: "Grading", enabled: () => usable() && signedIn(), run: () => refreshGrading() });
  registerCommand({ id: "grading.closeReview", title: "Close Review (Back to My Folder)", category: "Grading", enabled: () => !!useGrading.getState().review, run: closeReview });
  registerCommand({ id: "workbench.view.assignments", title: "Show Assignments", category: "View", enabled: usable, run: () => revealView("assignments") });
  registerCommand({ id: "assignments.refresh", title: "Refresh Assignments", category: "Assignments", enabled: () => usable() && signedIn(), run: refreshAssignments });
  registerCommand({ id: "assignments.useAsStarter", title: "Use as Starter for an Assignment…", category: "Assignments", enabled: () => bound() && useProjects.getState().binding?.kind === "tm" && useAssignments.getState().staff === true, run: publishAsStarter });
  // A reminder for exam safety: nothing here runs during an exam (projectsSupported checks inExam()).
  void inExam;
}
