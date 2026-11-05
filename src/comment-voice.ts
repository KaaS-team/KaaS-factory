// A pure check for the voice of a factory comment (#145): a maintainer reads one plain
// sentence first, and never sees a model id, a dollar amount or a run id.

const MARKER = /^[<]!--\s*factory:[^>]*-->\s*$/;
const MODEL_ID = /\b(claude-[a-z0-9.-]+|gpt-\d[\w.-]*|gemini-[\w.-]+|(?:fable|opus|sonnet|haiku)(?:[ -]\d[\d.]*)?)\b/i;
// A dollar, euro or pound sign before a digit, or a number next to a currency word or code.
const MONEY = /[$€£]\s?\d|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|dollars?|euros?)\b|\b(?:USD|EUR|GBP)\s?\d/i;
const RUN_ID =
  /\b(run[-_ ]?id|runid|run-[a-z0-9]{4,}|wf_[a-z0-9-]{6,}|[a-z]+-\d+-\d{10,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

const REDACTED = "[removed]";

// Operator detail (a model, an amount, a run id) cut out of a comment before it is posted.
// The hidden marker lines are left alone.
export function stripOperatorDetail(text: string): string {
  return text
    .split("\n")
    .map((l) =>
      MARKER.test(l.trim())
        ? l
        : [MODEL_ID, MONEY, RUN_ID].reduce((t, re) => t.replace(new RegExp(re.source, "gi"), REDACTED), l),
    )
    .join("\n");
}

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
  if (MONEY.test(body)) problems.push("shows a dollar amount");
  if (RUN_ID.test(body)) problems.push("shows a run id");
  return problems;
}
