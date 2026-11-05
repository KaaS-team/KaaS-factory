// `factory onboard --json`: where onboarding stands, as completed, blocked or failed, each with the
// next action, and the doctor's verdict from a live check (Ready, Not checked or Needs setup).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { successJson } from "./cli-output";
import type { DoctorCheck } from "./doctor";
import { isFilledIn } from "./init";
import { scanForOnboard, scanLines } from "./onboard";

export type DoctorStatus = "Ready" | "Not checked" | "Needs setup";
export type StepState = "completed" | "blocked" | "failed";

export interface OnboardStep {
  readonly name: string;
  readonly state: StepState;
  readonly next?: string;
}

export interface OnboardReport {
  readonly status: StepState;
  readonly doctor: DoctorStatus;
  readonly steps: readonly OnboardStep[];
  readonly next: string;
  // Set by `factory onboard` from src/onboard.ts: what it read, what it wrote, what a person must still supply.
  readonly detected?: readonly string[];
  readonly wrote?: readonly string[];
  readonly missing?: readonly string[];
}

// No checks means doctor never ran live. A warning never fails a run, so it never means Needs setup.
export function doctorStatus(checks: readonly DoctorCheck[] | undefined): DoctorStatus {
  if (checks === undefined) return "Not checked";
  return checks.every((c) => c.ok || c.warn) ? "Ready" : "Needs setup";
}

export async function buildOnboardReport(
  dir: string,
  runChecks: () => Promise<readonly DoctorCheck[]>,
  writeStarter?: boolean,
): Promise<OnboardReport> {
  // Before the steps, so the starter config it writes counts as filled in.
  const scan = writeStarter === undefined ? {} : scanForOnboard(dir, writeStarter);
  const steps: OnboardStep[] = [];
  const installed = existsSync(join(dir, ".factory", "gates.sh"));
  steps.push(
    installed
      ? { name: "template installed", state: "completed" }
      : { name: "template installed", state: "blocked", next: `factory install ${dir}` },
  );
  const configPath = join(dir, ".factory", "config.json");
  const filled = isFilledIn(existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined);
  steps.push(
    filled
      ? { name: "config filled in", state: "completed" }
      : { name: "config filled in", state: "blocked", next: `factory init --repo-dir ${dir}` },
  );
  let doctor: DoctorStatus = "Not checked";
  if (installed && filled) {
    try {
      const checks = await runChecks();
      doctor = doctorStatus(checks);
      const bad = checks.find((c) => !c.ok && !c.warn);
      steps.push(
        bad
          ? { name: "doctor", state: "blocked", next: `${bad.name}: ${bad.detail}` }
          : { name: "doctor", state: "completed" },
      );
    } catch (err) {
      steps.push({
        name: "doctor",
        state: "failed",
        next: `factory doctor --repo-dir ${dir} (${err instanceof Error ? err.message : String(err)})`,
      });
    }
  } else steps.push({ name: "doctor", state: "blocked", next: "finish the steps above, then run doctor" });
  const status: StepState = steps.some((s) => s.state === "failed")
    ? "failed"
    : steps.some((s) => s.state === "blocked")
      ? "blocked"
      : "completed";
  const open = steps.find((s) => s.state !== "completed");
  return {
    ...scan,
    status,
    doctor,
    steps,
    next: open?.next ?? "label an issue factory:ready; an unlabelled issue starts nothing",
  };
}

// What `doctor` prints. A config that cannot load means nothing ran live, so the status stays Not checked.
export function doctorOutput(checks: readonly DoctorCheck[], json: boolean, live = true): string {
  if (json)
    return successJson(
      { checks, status: live ? doctorStatus(checks) : doctorStatus(undefined) },
      checks.every((c) => c.ok || c.warn),
    );
  return checks.map((c) => `  [${c.ok ? "ok" : c.warn ? "warn" : "FAIL"}] ${c.name} — ${c.detail}`).join("\n");
}

export function unusableConfigCheck(err: unknown): DoctorCheck {
  const detail = err instanceof Error ? err.message : String(err);
  return { name: ".factory/config.json is usable", ok: false, detail, fixable: false };
}

export function onboardOutput(report: OnboardReport, json: boolean): string {
  if (json) return successJson(report, report.status === "completed");
  const lines = scanLines({
    detected: report.detected ?? [],
    wrote: report.wrote ?? [],
    missing: report.missing ?? [],
  });
  lines.push(...report.steps.map((s) => `  [${s.state}] ${s.name}${s.next ? ` - ${s.next}` : ""}`));
  lines.push(`factory onboard: ${report.status}, doctor ${report.doctor}. next: ${report.next}`);
  return lines.join("\n");
}
