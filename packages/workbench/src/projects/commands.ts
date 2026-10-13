import { registerCommand } from "../commands/registry";
import { msg } from "../messages/catalog";
import { inExam } from "../exam/state";
import { openInTaskMentor } from "./taskMentorLinks";
import { chooseBase, moveOpenProject } from "./location";
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
  resumeAfterSignIn,
  signedIn,
  useProjects,
  notifyError,
} from "./service";
import { firstOpenFile, PURPOSE_LABEL, starterById, starterFiles, starterLanguages, type Starter } from "./starters";
import { publishAsStarter, refreshAssignments, startAssignment, submitAssignment, useAssignments } from "./assignments";
import { closeReview, refreshGrading, useGrading } from "../grading/service";
import { changeAssessment, linkProject, pickAssessment, startQuizPractical, submitProject } from "./matching";
import type { ProjectKind } from "./types";

/** The open folder's quiz-practical link (its brief is the practical's). */
function practicalOfCurrent() {
  const cur = useProjects.getState().current;
  const links = cur ? (Array.isArray(cur.links) ? cur.links : (cur.links?.items ?? [])) : [];
  return links.find((l) => l.activity_type === "quiz" && !!l.question_id) ?? null;
}

const usable = () => projectsSupported() && useWorkbench.getState().policy.mode === "practice";
const bound = () => usable() && !!useProjects.getState().binding;

export { taskMentorWeb } from "./taskMentorLinks";

/**
 * One Submit (guided plan H): the palette, the brief and the menus all hand in the open folder
 * the same way — its assignment, its quiz practical, or the assessment it is matched with.
 */
export async function submit() {
  const { binding, current } = useProjects.getState();
  if (!binding || !current) return notify("info", "Open your project first, then Submit.");
  if (current.assignment) return submitAssignment(current.assignment.id);
  const links = Array.isArray(current.links) ? current.links : (current.links?.items ?? []);
  const practical = links.find((l) => l.activity_type === "quiz" && !!l.question_id);
  if (practical) return (await import("./quizPractical")).submitQuizPractical(practical.activity_id, practical.question_id!);
  return submitProject();
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "project";

/**
 * The starter picker: a language, then one of its starters (first program, exercise, project…),
 * in the Runtime Catalog's order. Null: cancelled.
 */
export async function pickStarter(title = "New project from a starter"): Promise<Starter | null> {
  const langs = starterLanguages();
  const firstMore = langs.find((l) => !l.common)?.key;
  const lang = await showQuickPick({
    title,
    placeholder: "Choose a language",
    matchOnDescription: true,
    items: langs.map((l) => ({
      id: l.key,
      label: l.label,
      description: `${l.starters.length} starter${l.starters.length === 1 ? "" : "s"}`,
      icon: l.starters.find((s) => s.icon)?.icon ?? "code",
      separator: l.key === langs[0]?.key ? "most used" : l.key === firstMore ? "more languages" : undefined,
    })),
  });
  if (!lang) return null;
  const list = langs.find((l) => l.key === lang.id)?.starters ?? [];
  const pick = await showQuickPick({
    title: `${langs.find((l) => l.key === lang.id)?.label ?? lang.id}: choose a starter`,
    placeholder: "Choose what your project starts with (you can change everything)",
    matchOnDescription: true,
    items: list.map((s) => ({
      id: s.id,
      label: s.title,
      description: PURPOSE_LABEL[s.purpose],
      detail: [s.description, s.tools?.length ? `needs ${s.tools.join(", ")}` : null, s.setup ? `then: ${s.setup.command}` : null].filter(Boolean).join(" · "),
      icon: s.icon ?? (s.purpose === "web" ? "globe" : s.purpose === "project" ? "beaker" : "file-code"),
    })),
  });
  return pick ? starterById(pick.id) : null;
}

/** Writes a starter's files into the open folder and opens its first file. */
export async function writeStarter(starter: Starter) {
  const fs = getPlatform().fs;
  const files = await starterFiles(starter);
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) await fs.createDir(parts.slice(0, i).join("/")).catch(() => {});
    await fs.writeFile(path, content).catch(async () => {
      await fs.createFile(path);
      await fs.writeFile(path, content);
    });
  }
  // The explorer lists the new files at once (the watcher would, a moment later, on the desktop only).
  const { applyExternalChanges } = await import("../monaco/external");
  await applyExternalChanges(Object.keys(files));
  const first = firstOpenFile(starter, files) ?? Object.keys(files).find((p) => /^readme\.md$/i.test(p));
  if (first) openFile(first, { pinned: true });
}

/** Runs the starter's setup (npm install, flutter create …) in a terminal, when the user agrees. */
export async function offerSetup(starter: Starter) {
  if (!starter.setup) return;
  if (!getPlatform().terminal) {
    notify("info", `Next: run \`${starter.setup.command}\` in a terminal (${starter.setup.note.toLowerCase()}).`);
    return;
  }
  const go = await showDialog({
    severity: "info",
    message: `Set up ${starter.title} now?`,
    detail: `${starter.setup.note}. TMCode runs this in a terminal:\n\n${starter.setup.command}${starter.tools?.length ? `\n\nNeeds ${starter.tools.join(", ")} on this computer (Run and Debug › How to Install… if missing).` : ""}`,
    buttons: [
      { id: "run", label: "Run Setup", primary: true },
      { id: "later", label: "Later" },
    ],
    cancelId: "later",
  });
  if (go !== "run") return;
  showPanel("terminal");
  window.dispatchEvent(new CustomEvent("tmcode:new-terminal", { detail: { command: starter.setup.command, cwd: "", name: `Setup: ${starter.title}` } }));
}

/** New Project from Starter (no Task Mentor needed): a new folder with the starter's files, opened. */
export async function newProjectFromStarter() {
  const starter = await pickStarter();
  if (!starter) return;
  const name = await showInputBox({ title: `New ${starter.title} project`, prompt: "Folder name", value: starter.id.replace(/^tmcode-/, ""), validate: (v) => (v.trim().length < 2 ? "Enter a name (2 characters or more)." : /[\\/:*?"<>|]/.test(v) ? "Use letters, numbers, - and _." : null) });
  if (!name) return;
  const host = getPlatform().account;
  if (!host) return notify("info", "New projects from starters need the TMCode desktop app.");
  // Where it goes: the Projects Folder, a folder of the student's choice, or (PHP) the web server's folder.
  const base = await chooseBase({ name, templateId: starter.aliases?.[0] ?? starter.id, language: starter.language, ask: true });
  if (base === null) return;
  if (!(await confirmLeaveWorkspace())) return;
  try {
    const folder = await host.newFolder(slugify(name), base);
    // Kept the current folder (Cancel on unsaved files): never write the starter into it.
    if (!(await (getPlatform().openPath ? openPathFromOs(folder) : openRecent(folder)))) return;
    await writeStarter(starter);
    notify("info", `Created ${name} from the ${starter.title} starter. Run: ⌘/Ctrl+Shift+F10.`);
    await offerSetup(starter);
  } catch (e) {
    notifyError(e);
  }
}

/** New Project: the open folder, a GitHub repository, or a starter in a new folder. `from: "folder"` skips the choice. */
async function newProject(opts: { from?: "folder" } = {}) {
  if (!signedIn()) {
    // W5: carries on once signed in.
    resumeAfterSignIn({ label: "New Project", notice: "Signed in. Starting your new project…", run: () => newProject(opts) });
    return void signIn();
  }
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
            { id: "starter", label: "From a starter…", description: "A first program, an exercise or a project, in any language", icon: "rocket", separator: "new" },
          ],
        });
  if (!choice) return;
  const tpl = choice.id === "starter" ? await pickStarter("New Task Mentor project from a starter") : null;
  if (choice.id === "starter" && !tpl) return;
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
      message: `"${assessment.question.title}" is a coding question`,
      detail: `Start it to get your teacher's starter files in a project linked to the quiz "${assessment.title}". The name you typed isn't needed: Task Mentor names the project after the question.`,
      buttons: [
        { id: "start", label: "Start the Question", primary: true },
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
        message: `"${practical.title}" is a code assignment`,
        detail: "Start it from the Assignments view instead: you get your teacher's starter files and the brief beside your code.",
        buttons: [
          { id: "start", label: "Start the Assignment", primary: true },
          { id: "cancel", label: "Cancel" },
        ],
        cancelId: "cancel",
      });
      if (go === "start") await startAssignment(practical.id);
      return;
    }
  }
  try {
    const project = await createProject({ name: name.trim(), kind, repo_url: repo_url?.trim(), language: tpl?.language });
    if (!project) return;
    const matched = assessment !== "none" ? await linkProject(project.id, assessment).catch((e) => (notify("warning", `Created, but not matched: ${(e as Error).message}`), null)) : null;
    if (tpl) {
      const host = getPlatform().account!;
      const base = await chooseBase({ name, templateId: tpl.aliases?.[0] ?? tpl.id, language: tpl.language });
      const folder = await host.newFolder(slugify(name), base ?? undefined);
      if (!(await (getPlatform().openPath ? openPathFromOs(folder) : openRecent(folder)))) {
        notify("info", `Created ${project.name} in Task Mentor. Open it from Projects to start.`);
        return;
      }
      await writeStarter(tpl);
      await connectFolder(project);
      await saveToTaskMentor({ message: `Created from the ${tpl.title} starter`, quiet: true });
      notify("info", `Created ${project.name} from the ${tpl.title} starter and saved it to Task Mentor.`);
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
    notifyError(e);
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
  if (!signedIn()) {
    resumeAfterSignIn({ label: "this folder", notice: "Signed in. Connecting this folder to Task Mentor…", run: () => connect() });
    return void signIn();
  }
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
  registerCommand({ id: "projects.signIn", title: msg("signin.button"), category: "Accounts", aliases: ["sign in with nga", "log in", "login"], enabled: () => usable() && !signedIn(), run: signIn });
  registerCommand({ id: "projects.signOut", title: "Sign Out of NGA", category: "Accounts", enabled: () => signedIn(), run: () => void import("./studentHome").then((m) => m.signOutOnPurpose()) });
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
  registerCommand({ id: "projects.moveFolder", title: "Move This Project…", category: "Projects", aliases: ["htdocs", "xampp", "change folder", "relocate"], enabled: () => !!useWorkbench.getState().workspace && !!getPlatform().account?.moveFolder, run: () => void moveOpenProject() });
  registerCommand({ id: "projects.findWebServer", title: "Find This Computer's Web Server (XAMPP, MAMP, WAMP…)", category: "Projects", run: async () => {
    const { webRoots } = await import("./location");
    const list = await webRoots(true);
    notify("info", list.length ? `Found ${list.map((r) => `${r.server} (${r.path}, ${r.url})`).join("; ")}. PHP websites can go there.` : "No web server folder found (XAMPP, MAMP, WAMP, Laragon). PHP websites run with PHP's own server instead.");
  } });
  registerCommand({
    id: "projects.submit",
    title: "Submit…",
    category: "Projects",
    aliases: ["submit project", "hand in"],
    enabled: () => bound() && !["submitted", "graded", "removed"].includes(useProjects.getState().current?.status ?? "draft"),
    run: submit,
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
    run: () => openInTaskMentor({ kind: "project", id: useProjects.getState().binding!.project_id }),
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
  registerCommand({ id: "workbench.action.newProjectFromTemplate", title: "New Project from Starter…", category: "File", aliases: ["template", "new project"], enabled: () => !!getPlatform().account && !inExam(), run: newProjectFromStarter });
  registerCommand({ id: "workbench.view.grading", title: "Show Grading", category: "View", enabled: () => usable() && useGrading.getState().grader, run: () => revealView("grading") });
  registerCommand({ id: "grading.refresh", title: "Refresh Grading", category: "Grading", enabled: () => usable() && signedIn(), run: () => refreshGrading() });
  registerCommand({ id: "grading.closeReview", title: "Close Review", aliases: ["back to my folder"], category: "Grading", enabled: () => !!useGrading.getState().review, run: closeReview });
  registerCommand({ id: "workbench.view.assignments", title: "Show Assignments", category: "View", enabled: usable, run: () => revealView("assignments") });
  // Palette doors to the brief's one main button (guided plan H): the same functions, the same words.
  registerCommand({
    id: "assignments.showBrief",
    title: "Show Brief",
    category: "Assignments",
    aliases: ["assignment brief", "instructions"],
    enabled: () => !!useProjects.getState().current?.assignment || !!practicalOfCurrent(),
    run: async () => {
      const cur = useProjects.getState().current;
      if (cur?.assignment) return (await import("./assignments")).showAssignment(cur.assignment.id, { toSide: true });
      const q = practicalOfCurrent();
      if (q) (await import("./quizPractical")).showQuizPractical(q.activity_id, q.question_id!, { toSide: true });
    },
  });
  registerCommand({
    id: "assignments.startOrContinue",
    title: "Start or Continue an Assignment…",
    category: "Assignments",
    enabled: () => usable() && signedIn() && (useAssignments.getState().student?.length ?? 0) > 0,
    run: async () => {
      const { studentStatus } = await import("./assignments");
      const list = (useAssignments.getState().student ?? []).filter((a) => !a.read_only && ["not_started", "in_progress", "returned"].includes(studentStatus(a)));
      if (!list.length) return notify("info", "Nothing to start or continue. Well done!");
      const pick = await showQuickPick({
        placeholder: "Choose an assignment",
        items: list.map((a) => ({ id: String(a.id), label: a.title, description: `${studentStatus(a) === "not_started" ? "Start" : "Continue"}${a.course_name ? ` · ${a.course_name}` : ""}`, icon: studentStatus(a) === "not_started" ? "play" : "arrow-right" })),
      });
      if (pick) void startAssignment(Number(pick.id));
    },
  });
  registerCommand({ id: "assignments.refresh", title: "Refresh Assignments", category: "Assignments", enabled: () => usable() && signedIn(), run: refreshAssignments });
  registerCommand({ id: "assignments.useAsStarter", title: "Use as Starter for an Assignment…", category: "Assignments", enabled: () => bound() && useProjects.getState().binding?.kind === "tm" && useAssignments.getState().staff === true, run: publishAsStarter });
  // A reminder for exam safety: nothing here runs during an exam (projectsSupported checks inExam()).
  void inExam;
}
