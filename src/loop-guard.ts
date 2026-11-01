// What the self-improvement loop may never do: delete a file (a check, a test, a skill) or edit the
// calibration labels. It may add and edit; it never removes or relabels.

import { outsideAllowedPaths } from "./boundary";

export const CALIBRATION_PATHS = ["tests/fixtures/judge-calibration/**"];

export function loopRefusals(changed: readonly string[], exists: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const f of changed) {
    if (!exists(f)) out.push(`${f}: deleted`);
    if (outsideAllowedPaths([f], CALIBRATION_PATHS).length === 0) out.push(`${f}: calibration label`);
  }
  return out;
}
