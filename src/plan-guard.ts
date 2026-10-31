// The check between "spec pushed" and "run started": a planned body that is a stub never reaches an agent.

import type { FactoryConfig } from "./config";
import { lintPlanned } from "../scripts/lint-planned";

const MIN_BYTES = 1500;
const HEADINGS = ["Why", "Change", "Tests", "Acceptance", "Files"];

export type Guard = { ok: true } | { ok: false; reasons: string[] };

export function guardPlan(body: string, config: FactoryConfig): Guard {
  const reasons: string[] = [];
  const size = Buffer.byteLength(body);
  if (size < MIN_BYTES) reasons.push(`The body is ${size} bytes; a plan needs at least ${MIN_BYTES}.`);
  for (const h of HEADINGS)
    if (!new RegExp(`^## ${h}\\s*$`, "m").test(body)) reasons.push(`The body has no "## ${h}" heading.`);
  reasons.push(...lintPlanned(body, config));
  return reasons.length ? { ok: false, reasons } : { ok: true };
}
