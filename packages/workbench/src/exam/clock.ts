/**
 * Server time that ignores the computer's clock (plan §13.3): anchored on the
 * server's time at the last contact and advanced by the monotonic
 * performance clock, so changing the OS clock changes nothing.
 */
export class ServerClock {
  private serverAt = Date.now();
  private perfAt = performance.now();

  sync(serverTimeIso: string) {
    const t = Date.parse(serverTimeIso);
    if (Number.isFinite(t)) {
      this.serverAt = t;
      this.perfAt = performance.now();
    }
  }

  now(): number {
    return this.serverAt + (performance.now() - this.perfAt);
  }

  iso(): string {
    return new Date(this.now()).toISOString();
  }
}

export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return h ? `${h}:${mm}:${String(sec).padStart(2, "0")}` : `${mm}:${String(sec).padStart(2, "0")}`;
}
