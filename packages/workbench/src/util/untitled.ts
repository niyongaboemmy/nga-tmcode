/**
 * Untitled buffers (⌘N): editors on "tmcode-untitled:Untitled-N" paths that
 * live only in memory until Save asks where to put them.
 */
export const UNTITLED_SCHEME = "tmcode-untitled";
const PREFIX = `${UNTITLED_SCHEME}:`;

export function isUntitled(path: string | null | undefined): boolean {
  return !!path && path.startsWith(PREFIX);
}

/** "tmcode-untitled:Untitled-2" → "Untitled-2". */
export function untitledName(path: string): string {
  return path.slice(PREFIX.length);
}

/** The first free "Untitled-N" among the open paths. */
export function nextUntitledPath(openPaths: Iterable<string>): string {
  const used = new Set([...openPaths].filter(isUntitled).map(untitledName));
  let n = 1;
  while (used.has(`Untitled-${n}`)) n++;
  return `${PREFIX}Untitled-${n}`;
}
