import { useState } from "react";
import { extensionHost, installExtension, useExtensions } from "../extensions/service";
import { useAiExtensionsBlockedReason } from "../parts/extensions/ExtensionsView";
import { getGalleryExtension } from "../extensions/gallery";
import { showContainer, useViews } from "../exthost/views/model";
import { useInstallLabel } from "../parts/extensions/InstallProgress";
import { notify } from "../state/store";
import { Codicon } from "../widgets/icons";

/**
 * Other AI assistants, one click away: the coding agents people use in VS Code, from Open VSX.
 * Install (this computer's build, with progress: they ship their agent as a native program), then
 * Open shows their own chat (Claude Code's and Codex's in the secondary side bar).
 */

const ASSISTANTS = [
  { id: "anthropic.claude-code", name: "Claude Code", by: "Anthropic", note: "Claude account or API key" },
  { id: "openai.chatgpt", name: "Codex (ChatGPT)", by: "OpenAI", note: "ChatGPT account (no Windows build on Open VSX)" },
  { id: "google.geminicodeassist", name: "Gemini Code Assist", by: "Google", note: "Google account, free tier" },
  { id: "saoudrizwan.claude-dev", name: "Cline", by: "Cline", note: "Bring your own key" },
  { id: "continue.continue", name: "Continue", by: "Continue", note: "Bring your own model" },
];

function Row({ a }: { a: (typeof ASSISTANTS)[number] }) {
  const installed = useExtensions((s) => s.installed.find((e) => e.id === a.id));
  const busy = useExtensions((s) => s.busy[a.id]);
  const label = useInstallLabel(a.id, busy);
  const container = useViews((s) => s.containers.find((c) => c.extensionId === a.id && c.location === "secondarySidebar") ?? s.containers.find((c) => c.extensionId === a.id));
  const [error, setError] = useState<string | null>(null);
  const blockedReason = useAiExtensionsBlockedReason();

  const install = async () => {
    setError(null);
    const host = extensionHost();
    if (!host) return notify("info", "Extensions install in the TMCode desktop app.");
    try {
      const g = await getGalleryExtension(host, a.id, true);
      await installExtension(g);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  return (
    <div className="tm-aihub-row" data-testid={`aihub-${a.id}`}>
      <div className="tm-aihub-text">
        <div className="tm-aihub-name">
          {a.name} <span className="tm-aihub-by">{a.by}</span>
        </div>
        <div className="tm-aihub-note">{error ?? (blockedReason && !installed ? blockedReason : a.note)}</div>
      </div>
      {busy ? (
        <span className="tm-aihub-busy" role="status">
          <Codicon name="loading" className="codicon-modifier-spin" /> {label}
        </span>
      ) : installed ? (
        <button type="button" className="tm-chat-starter tm-aihub-btn" onClick={() => (container ? showContainer(container.key) : notify("info", `${a.name} is starting. Open it from the activity bar or the secondary side bar.`))} disabled={!installed.enabled || !!blockedReason} title={blockedReason ?? undefined}>
          <Codicon name="link-external" /> Open
        </button>
      ) : (
        <button type="button" className="tm-chat-starter tm-aihub-btn" onClick={() => void install()} disabled={!!blockedReason} title={blockedReason ?? undefined} data-testid={`aihub-install-${a.id}`}>
          <Codicon name="cloud-download" /> Install
        </button>
      )}
    </div>
  );
}

export function AiExtensions() {
  const [open, setOpen] = useState(false);
  return (
    <div className="tm-aihub">
      <button type="button" className="tm-aihub-head" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="aihub-toggle">
        <Codicon name={open ? "chevron-down" : "chevron-right"} /> Use other AI assistants (Claude Code, Codex, Gemini…)
      </button>
      {open && (
        <div className="tm-aihub-list">
          {ASSISTANTS.map((a) => (
            <Row key={a.id} a={a} />
          ))}
          <p className="tm-chat-note">They use their own accounts. What they do in your project is in the Activity log too.</p>
        </div>
      )}
    </div>
  );
}
