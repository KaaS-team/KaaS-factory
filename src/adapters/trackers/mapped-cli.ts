// The generic tracker's CLI transport: a mapped call is one run of a tool the repo declares in
// .factory/cli-tools.json, with the call's argv templates filled in. The tool prints JSON on stdout.

import { runCliTool } from "../../cli-tools";
import { type CallTransport, MappedTrackerError, parseAnswer } from "./mapped";
import { fillTemplate, type MappedCall, type Vars } from "./mapping";

// An argv entry is text: a list (labels) is comma separated, anything else its JSON or string form.
const argvText = (v: unknown): string =>
  typeof v === "string"
    ? v
    : Array.isArray(v)
      ? v.join(",")
      : typeof v === "object" && v !== null
        ? JSON.stringify(v)
        : String(v ?? "");

export class CliTransport implements CallTransport {
  constructor(
    private readonly dir: string,
    private readonly tool: string,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  async call(call: MappedCall, vars: Vars): Promise<unknown> {
    const argv = (call.argv ?? []).map((a) => argvText(fillTemplate(a, vars)));
    const r = await runCliTool(this.dir, this.tool, argv, this.env);
    if (!r.ok)
      throw new MappedTrackerError(
        `${this.tool} ${argv[0] ?? ""} ${r.reason}: ${(r.stderr || r.stdout).slice(0, 200)}`,
      );
    return parseAnswer(r.stdout, `${this.tool} ${argv[0] ?? ""}`);
  }
}
