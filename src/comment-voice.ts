// A pure check for the voice of a factory comment (#145): a maintainer reads one plain
// sentence first, and never sees a model id, a dollar amount or a run id.

const MARKER = /^<!--\s*factory:[^>]*-->\s*$/;
const MODEL_ID = /\b(claude-[a-z0-9.-]+|gpt-\d[\w.-]*|gemini-[\w.-]+|(?:fable|opus|sonnet|haiku)(?:[ -]\d[\d.]*)?)\b/i;
const DOLLARS = /\$\s?\d/;
const RUN_ID =
  /\b(run[-_ ]?id|runid|run-[a-z0-9]{4,}|wf_[a-z0-9-]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

// The first line after the hidden marker, which must read as a sentence rather than a heading,
// a bullet, a table row, a code span or a `**Field:** value` line.
export function openingLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  const first = lines.findIndex((l) => l !== "" && !MARKER.test(l));
  return first === -1 ? "" : (lines[first] as string);
}

function isSentence(line: string): boolean {
  if (!/^[A-Z][^|]*[.!?]$/.test(line)) return false;
  return !/^\w[\w ]{0,20}:\s/.test(line);
}

export function commentProblems(text: string): string[] {
  const problems: string[] = [];
  const open = openingLine(text);
  if (!isSentence(open)) problems.push("opens with something other than one plain sentence");
  const body = text
    .split("\n")
    .filter((l) => !MARKER.test(l.trim()))
    .join("\n");
  if (MODEL_ID.test(body)) problems.push("names a model");
  if (DOLLARS.test(body)) problems.push("shows a dollar amount");
  if (RUN_ID.test(body)) problems.push("shows a run id");
  return problems;
}
