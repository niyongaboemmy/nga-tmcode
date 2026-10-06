import { registerCommand } from "../commands/registry";
import { inExam } from "../exam/state";
import { getPlatform, notify, openPathFromOs, revealView, useWorkbench } from "../state/store";
import { showInputBox, showQuickPick } from "../widgets/QuickPick";
import {
  checkSync,
  connectFolder,
  createProject,
  linkableActivities,
  linkActivity,
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
import { TEMPLATES, templateById } from "./templates";
import type { Link, ProjectKind } from "./types";

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

export async function submitFromView(linkId: number) {
  const b = useProjects.getState().binding;
  if (!b) return;
  try {
    const res = await submitLink(b.project_id, linkId);
    const late = (res.submission as { is_late?: boolean } | null)?.is_late;
    notify("info", `Submitted to Task Mentor${late ? " (late)" : ""}. Your teacher sees exactly this version.`);
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "project";

/** New Project: a template in a new folder, the open folder, or a GitHub repository. */
async function newProject() {
  if (!signedIn()) return void signIn();
  const ws = useWorkbench.getState().workspace;
  const choice = await showQuickPick({
    placeholder: "Create a Task Mentor project",
    items: [
      ...TEMPLATES.map((t, i) => ({ id: `tpl:${t.id}`, label: t.label, description: t.description, icon: t.icon, separator: i === 0 ? "from a template" : undefined })),
      ...(ws ? [{ id: "folder", label: `This folder (${ws.name})`, description: "Save the open folder to Task Mentor", icon: "folder-opened", separator: "from your work" }] : []),
      { id: "github", label: "A GitHub repository", description: "Task Mentor follows your git pushes", icon: "github", separator: ws ? undefined : "from your work" },
    ],
  });
  if (!choice) return;
  const name = await showInputBox({ title: "New Project", prompt: "Project name", value: choice.id === "folder" ? ws?.name : "", validate: (v) => (v.trim().length < 2 ? "Enter a name (2 characters or more)." : v.length > 120 ? "The name is too long." : null) });
  if (!name) return;
  let kind: ProjectKind = "tm";
  let repo_url: string | undefined;
  if (choice.id === "github") {
    kind = "github";
    const gitRemote = useWorkbench.getState().workspace ? await guessRemote() : null;
    repo_url = await showInputBox({ title: "GitHub repository", prompt: "Repository URL", value: gitRemote ?? "https://github.com/", validate: (v) => (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/.test(v.trim()) ? null : "Enter a https://github.com/owner/repo URL.") });
    if (!repo_url) return;
  }
  const tpl = choice.id.startsWith("tpl:") ? templateById(choice.id.slice(4)) : null;
  try {
    const project = await createProject({ name: name.trim(), kind, repo_url: repo_url?.trim(), language: tpl?.language });
    if (!project) return;
    if (tpl) {
      const host = getPlatform().account!;
      const folder = await host.newFolder(slugify(name));
      await openPathFromOs(folder);
      const fs = getPlatform().fs;
      for (const [path, content] of Object.entries(tpl.files)) {
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) await fs.createDir(parts.slice(0, i).join("/")).catch(() => {});
        await fs.writeFile(path, content);
      }
      await connectFolder(project);
      await saveToTaskMentor({ message: `Created from the ${tpl.label} template`, quiet: true });
      notify("info", `Created ${project.name} from the ${tpl.label} template and saved it to Task Mentor.`);
    } else if (choice.id === "folder" || kind === "github") {
      if (useWorkbench.getState().workspace) await connectFolder(project);
      if (kind === "tm") await saveToTaskMentor({ message: "First save from TMCode" });
      else notify("info", `${project.name} is linked to ${repo_url}. Task Mentor now follows your pushes.`);
    }
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
  const items = [
    { id: "new", label: "New Project from This Folder…", icon: "add", description: "Create a Task Mentor project and save this folder to it" },
    ...(mine ?? []).map((p, i) => ({ id: String(p.id), label: p.name, description: p.kind === "github" ? p.repo_full_name ?? "GitHub" : "Task Mentor", icon: p.kind === "github" ? "github" : "cloud", separator: i === 0 ? "existing projects" : undefined })),
  ];
  const pick = await showQuickPick({ placeholder: "Connect this folder to a Task Mentor project", items, matchOnDescription: true });
  if (!pick) return;
  if (pick.id === "new") return newProject();
  const project = mine?.find((p) => String(p.id) === pick.id);
  if (project) {
    await connectFolder(project);
    notify("info", project.kind === "tm" ? `Connected to ${project.name}. Save to Task Mentor uploads your changes; Get Latest brings newer ones.` : `Connected to ${project.name} (GitHub).`);
  }
}

async function linkToActivity() {
  const b = useProjects.getState().binding;
  if (!b) return notify("info", "Connect this folder to a Task Mentor project first.");
  try {
    const picked = await showQuickPick({
      placeholder: "Link this project to an activity",
      matchOnDescription: true,
      items: linkableActivities().then((list) =>
        list.map((a) => ({
          id: `${a.activity_type}:${a.activity_id}`,
          label: a.title,
          description: [a.course_name, a.due_date ? `due ${new Date(a.due_date).toLocaleDateString()}` : null].filter(Boolean).join(" · "),
          icon: a.activity_type === "quiz" ? "checklist" : a.activity_type === "assignment" ? "notebook" : "graph",
          separator: { quiz: "quizzes", assignment: "assignments", manual_assessment: "recorded assessments" }[a.activity_type],
        })),
      ),
    });
    if (!picked) return;
    const [type, id] = picked.id.split(":");
    await linkActivity(b.project_id, { activity_type: type as Link["activity_type"], activity_id: Number(id) });
    notify("info", `Linked to ${picked.label}. Submit when your work is ready.`);
  } catch (e) {
    notify("error", (e as Error).message);
  }
}

export function registerProjectCommands() {
  registerCommand({ id: "workbench.view.projects", title: "Show Task Mentor Projects", category: "View", keybinding: "mod+shift+j", enabled: usable, run: () => revealView("projects") });
  registerCommand({ id: "projects.signIn", title: "Sign in with NGA (Central MIS + Task Mentor)", category: "Accounts", enabled: () => usable() && !signedIn(), run: signIn });
  registerCommand({ id: "projects.signOut", title: "Sign Out of NGA", category: "Accounts", enabled: () => signedIn(), run: signOut });
  registerCommand({ id: "projects.new", title: "New Project…", category: "Projects", enabled: usable, run: newProject });
  registerCommand({ id: "projects.connectFolder", title: "Connect This Folder to Task Mentor…", category: "Projects", enabled: () => usable() && !!useWorkbench.getState().workspace, run: connect });
  registerCommand({ id: "projects.save", title: "Save to Task Mentor", category: "Projects", keybinding: "mod+alt+u", enabled: bound, run: () => saveToTaskMentor() });
  registerCommand({ id: "projects.pull", title: "Get Latest from Task Mentor", category: "Projects", enabled: bound, run: () => pullFromTaskMentor() });
  registerCommand({ id: "projects.refresh", title: "Refresh Projects", category: "Projects", enabled: () => usable() && signedIn(), run: async () => (await refreshProjects(), await checkSync()) });
  registerCommand({ id: "projects.linkActivity", title: "Link to an Activity…", category: "Projects", enabled: bound, run: linkToActivity });
  registerCommand({
    id: "projects.openInTaskMentor",
    title: "Open Project in Task Mentor",
    category: "Projects",
    enabled: bound,
    run: () => openInTaskMentor(useProjects.getState().binding!.project_id),
  });
  // A reminder for exam safety: nothing here runs during an exam (projectsSupported checks inExam()).
  void inExam;
}
