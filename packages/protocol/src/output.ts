/**
 * How program output is compared with expected output — the same rule in
 * TMCode's local test runs and in Task Mentor's judge, so a test can't pass
 * locally and fail on the server over line endings or a trailing newline.
 */
export function normalizeOutput(s: string | null | undefined): string {
  return (s ?? "").replace(/\r\n/g, "\n").trimEnd();
}

export function outputsMatch(actual: string | null | undefined, expected: string | null | undefined): boolean {
  return normalizeOutput(actual) === normalizeOutput(expected);
}
