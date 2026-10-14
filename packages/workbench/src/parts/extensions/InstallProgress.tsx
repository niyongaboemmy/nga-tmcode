import { useInstallProgress } from "../../extensions/service";

/** "Installing 45% · 48 of 107 MB" while a large extension downloads, then "Unpacking". */
export function installLabel(id: string, busy: "installing" | "uninstalling"): string {
  const p = useInstallProgress.getState()[id];
  if (busy !== "installing") return "Uninstalling";
  if (!p) return "Installing";
  if (p.phase === "unpack") return "Unpacking…";
  const mb = (n: number) => (n / 1_048_576).toFixed(n < 10_485_760 ? 1 : 0);
  return p.total ? `Installing ${Math.floor((p.received / p.total) * 100)}% · ${mb(p.received)} of ${mb(p.total)} MB` : `Installing · ${mb(p.received)} MB`;
}

export function useInstallLabel(id: string, busy: "installing" | "uninstalling" | undefined) {
  useInstallProgress((s) => s[id]);
  return busy ? installLabel(id, busy) : "";
}
