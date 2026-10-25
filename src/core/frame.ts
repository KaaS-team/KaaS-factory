// A runtime that merges a command's streams or wraps them in its own log
// (lwpr prints "[lwpr] ..." lines around one combined stream) still has to
// hand back stdout, stderr and the exit code apart. `framed` wraps the command
// so it prints all three, base64'd, after a marker; `unframe` reads them back.

const START = "@@FACTORY-FRAME@@";
const END = "@@FACTORY-FRAME-END@@";

// A bash word that reads back as exactly `s`.
export function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export function framed(cmd: string): string {
  return [
    `f=$(mktemp -d)`,
    `bash -c ${shq(cmd)} >"$f/o" 2>"$f/e"; c=$?`,
    `printf '\\n%s\\n' ${START}`,
    `base64 <"$f/o" | tr -d '\\n'; printf '\\n'`,
    `base64 <"$f/e" | tr -d '\\n'; printf '\\n%s %d\\n' ${END} "$c"`,
    `rm -rf "$f"; exit "$c"`,
  ].join("; ");
}

export interface Unframed {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

// The last frame in `output`. No frame means the command never ran (the
// runtime failed first), so everything the runtime printed is the error.
export function unframe(output: string, runtimeCode: number): Unframed {
  const lines = output.split("\n");
  const at = lines.lastIndexOf(START);
  const end = lines[at + 3]?.match(new RegExp(`^${END} (\\d+)$`));
  if (at < 0 || !end) return { stdout: "", stderr: output, code: runtimeCode === 0 ? 1 : runtimeCode };
  const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf8");
  return { stdout: decode(lines[at + 1]!), stderr: decode(lines[at + 2]!), code: Number(end[1]) };
}
