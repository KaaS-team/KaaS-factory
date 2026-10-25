// Machine-readable CLI contract, after jiractrl's SPEC.md "JSON and exit
// contract" (owainlewis/jiractrl@c5ee78c, MIT): with `--json`, success is
// {"ok":true,"data":...} on stdout and failure is {"ok":false,"error":{kind,message}}
// on stderr. Exit codes are stable and listed in the README; a test keeps both in step.
// Deviations: the codes are the factory's own, and 1 keeps meaning "failed" so CI steps still fail.

import { ConfigError } from "./config";
import { plain } from "./display";

export const EXIT = {
  ok: 0,
  error: 1, // usage, config, gh/git failure, anything unexpected
  runFailed: 2, // `run`: the issue ended in factory:failed
  paused: 3, // `tick`/`watch --once`: STOP_IF paused new pickups
  checksFailed: 4, // `doctor`: at least one check failed
} as const;

export type ErrorKind = "config" | "usage" | "error";

export class UsageError extends Error {}

export function errorKind(err: unknown): ErrorKind {
  if (err instanceof ConfigError) return "config";
  if (err instanceof UsageError) return "usage";
  return "error";
}

export function successJson(data: unknown, ok = true): string {
  return JSON.stringify({ ok, data }, null, 2);
}

export function failureJson(err: unknown): string {
  const message = plain(err instanceof Error ? err.message : String(err));
  return JSON.stringify({ ok: false, error: { kind: errorKind(err), message } }, null, 2);
}
