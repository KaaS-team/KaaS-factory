// Keeps the head and the tail of a long text and says how many bytes sat between them.
const enc = new TextEncoder();
const dec = new TextDecoder();
const NL = 0x0a;

// A UTF-8 continuation byte starts with 10; a cut before one would split a character.
function continuation(b: number | undefined): boolean {
  return b !== undefined && (b & 0xc0) === 0x80;
}

// The head ends after its last newline within `budget` bytes, else at the last whole character.
function headLength(bytes: Uint8Array, budget: number): number {
  let end = budget;
  while (end > 0 && continuation(bytes[end])) end--;
  const nl = bytes.subarray(0, end).lastIndexOf(NL);
  return nl >= 0 ? nl + 1 : end;
}

// The tail starts after the first newline within its `budget` bytes, else at the first whole character.
function tailStart(bytes: Uint8Array, budget: number, floor: number): number {
  let start = Math.max(bytes.length - budget, floor);
  while (start < bytes.length && continuation(bytes[start])) start++;
  const nl = bytes.subarray(start).indexOf(NL);
  return nl >= 0 ? start + nl + 1 : start;
}

// The line that stands where bytes were cut; `head` is what came before it.
export function dropMarker(head: string, droppedBytes: number): string {
  const sep = head === "" || head.endsWith("\n") ? "" : "\n";
  return `${sep}[... ${droppedBytes} bytes dropped ...]\n`;
}

export function capOutput(text: string, max: number, headShare = 0.25): { text: string; droppedBytes: number } {
  const bytes = enc.encode(text);
  if (bytes.length <= max) return { text, droppedBytes: 0 };
  const share = Math.min(Math.max(headShare, 0), 1);
  const headBudget = Math.floor(max * share);
  const headBytes = headLength(bytes, headBudget);
  const tailFrom = tailStart(bytes, max - headBudget, headBytes);
  const headEnd = dec.decode(bytes.subarray(0, headBytes)).length;
  const tailAt = text.length - dec.decode(bytes.subarray(tailFrom)).length;
  const droppedBytes = tailFrom - headBytes;
  const head = text.slice(0, headEnd);
  return { text: `${head}${dropMarker(head, droppedBytes)}${text.slice(tailAt)}`, droppedBytes };
}
