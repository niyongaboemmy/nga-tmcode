/**
 * Task Mentor writes the notes per criterion into the feedback the student
 * reads, after the teacher's own text:
 *
 *   Good work
 *
 *   Criteria notes:
 *   • Layout: neat
 *   • Links: one is broken
 *
 * Servers that keep `comment` on each rubric score send the notes there too;
 * older ones only have this block. The editor edits the teacher's text and the
 * notes separately, and the server composes the block again on save.
 */

const BLOCK = /(?:^|\n+)Criteria notes:\n/;

export function splitFeedback(feedback: string | null | undefined, criteria: string[]): { feedback: string; comments: string[] } {
  const text = feedback ?? "";
  const m = BLOCK.exec(text);
  const comments = criteria.map(() => "");
  if (!m) return { feedback: text, comments };
  const notes = text.slice(m.index + m[0].length);
  // Longest names first: "Code" must not take the note of "Code quality".
  const order = criteria.map((name, i) => ({ name, i })).sort((a, b) => b.name.length - a.name.length);
  let last = -1;
  for (const line of notes.split("\n")) {
    if (line.startsWith("• ")) {
      const body = line.slice(2);
      const hit = order.find((c) => body.startsWith(`${c.name}: `));
      const generic = /^Criterion (\d+): /.exec(body);
      const i = hit ? hit.i : generic ? Number(generic[1]) - 1 : -1;
      if (i >= 0 && i < criteria.length) {
        comments[i] = body.slice(hit ? hit.name.length + 2 : generic![0].length);
        last = i;
        continue;
      }
      last = -1;
    } else if (last >= 0) {
      // A note written over several lines.
      comments[last] += `\n${line}`;
    }
  }
  return { feedback: text.slice(0, m.index), comments: comments.map((c) => c.trim()) };
}
