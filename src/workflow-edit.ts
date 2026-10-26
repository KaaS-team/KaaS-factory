// A workflow change from the dashboard's form: the form names a step and the fields to set, the
// file is rewritten, checked by the same parser the watcher uses, and goes out as a PR. Nothing
// writes the repo's workflows directly, so the Workflows page stays read-only.

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isWorkflowMd } from "./core/workflow-md";
import { BUNDLED_DIR, parseWorkflowText } from "./engine/workflows";
import { proposeFiles, type ProposeDeps } from "./propose-pr";

export const WORKFLOW_FIELDS = ["agent", "timeout", "retries", "approval", "gates"] as const;
export type WorkflowField = (typeof WORKFLOW_FIELDS)[number];
// Per step: a value to set, or null to remove the field.
export type WorkflowForm = Readonly<Record<string, Partial<Record<WorkflowField, unknown>>>>;

const NAME = /^[\w-]+$/;
const POISON = new Set(["__proto__", "constructor", "prototype"]);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export interface WorkflowSource {
  readonly name: string;
  readonly path: string;
  readonly text: string;
  readonly bundled: boolean;
}

// The repo's file when it has one, else the bundled one an edit would copy into the repo.
export function workflowSource(cloneDir: string, name: string): WorkflowSource | undefined {
  if (!NAME.test(name)) return undefined;
  for (const [dir, bundled] of [
    [join(cloneDir, ".factory", "workflows"), false] as const,
    [BUNDLED_DIR, true] as const,
  ])
    for (const ext of [".yml", ".md"]) {
      const file = join(dir, `${name}${ext}`);
      if (!existsSync(file)) continue;
      // A repo can plant the file as a symlink to anything on the runner; it is never followed.
      if (lstatSync(file).isSymbolicLink()) return undefined;
      return { name, path: `.factory/workflows/${name}${ext}`, text: readFileSync(file, "utf8"), bundled };
    }
  return undefined;
}

const dump = (v: unknown) => `${Bun.YAML.stringify(v, null, 2).replace(/ +$/gm, "").trimEnd()}\n`;

export function applyForm(text: string, form: WorkflowForm): { text: string } | { problems: string[] } {
  const md = isWorkflowMd(text);
  const end = md ? text.indexOf("\n---", 3) : -1;
  const raw = Bun.YAML.parse(md ? text.slice(text.indexOf("\n") + 1, end) : text) as Record<string, unknown>;
  const steps = raw?.[md ? "stages" : "steps"];
  if (!isObj(steps)) return { problems: ["the workflow has no steps to edit"] };
  const problems: string[] = [];
  for (const [step, fields] of Object.entries(form)) {
    const target = NAME.test(step) && !POISON.has(step) && Object.hasOwn(steps, step) ? steps[step] : undefined;
    if (!isObj(target)) problems.push(`${step}: no such step`);
    else
      for (const [k, v] of Object.entries(fields ?? {})) {
        if (POISON.has(k) || !(WORKFLOW_FIELDS as readonly string[]).includes(k))
          problems.push(`${step}.${k}: not an editable field`);
        else if (v === null || v === "") delete target[k];
        else target[k] = v;
      }
  }
  if (problems.length > 0) return { problems };
  return { text: md ? `---\n${dump(raw)}---\n${text.slice(text.indexOf("\n", end + 1) + 1)}` : dump(raw) };
}

export interface EditRequest {
  readonly repo: string;
  readonly base: string;
  readonly name: string;
  readonly form: WorkflowForm;
  readonly by: string;
}

export async function proposeWorkflowEdit(
  deps: ProposeDeps,
  req: EditRequest,
): Promise<{ prUrl: string; branch: string } | { problems: string[] }> {
  const src = workflowSource(deps.cloneDir, req.name);
  if (!src) return { problems: [`no workflow "${req.name}"`] };
  const edited = applyForm(src.text, req.form);
  if ("problems" in edited) return edited;
  const parsed = parseWorkflowText(edited.text);
  if (!parsed.ok) return { problems: parsed.problems };
  if (edited.text === src.text) return { problems: ["the form changes nothing"] };
  return proposeFiles(deps, {
    repo: req.repo,
    base: req.base,
    branch: `factory/workflow-${req.name}-${new Bun.CryptoHasher("sha256").update(edited.text).digest("hex").slice(0, 8)}`,
    files: { [src.path]: edited.text },
    allowed: [".factory/workflows/**"],
    title: `factory: edit workflow ${req.name}`,
    body: [
      `Proposed by ${req.by} from the dashboard's workflow form.`,
      "",
      `Changes ${Object.keys(req.form).join(", ")} in \`${src.path}\`${src.bundled ? " (copied from the bundled workflow)" : ""}.`,
      "The file is rewritten from its parsed form, so comments in it are not kept. Review before merging.",
    ].join("\n"),
  });
}
