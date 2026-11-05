// A tracker's own status names (Jira "In Review", Linear "Backlog") mapped to the factory's Source
// states, by the team file's `source.statuses`. The map is the whole rule: a status it does not name
// is reported by name, never guessed.

export const SOURCE_STATES = ["todo", "in-progress", "blocked", "in-review", "done", "cancelled"] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

export type StatusImport = { readonly state: SourceState } | { readonly unmapped: string };

export function isSourceState(v: unknown): v is SourceState {
  return typeof v === "string" && (SOURCE_STATES as readonly string[]).includes(v);
}

// One status. The name must match a key exactly.
export function importStatus(statuses: Readonly<Record<string, string>> | undefined, status: string): StatusImport {
  const state = statuses?.[status];
  return isSourceState(state) ? { state } : { unmapped: status };
}

// Many issues' statuses: the mapped ones by index, and each unmapped name once, in first-seen order.
export function importStatuses(
  statuses: Readonly<Record<string, string>> | undefined,
  seen: readonly string[],
): { states: (SourceState | undefined)[]; unmapped: string[] } {
  const unmapped: string[] = [];
  const states = seen.map((s) => {
    const r = importStatus(statuses, s);
    if ("state" in r) return r.state;
    if (!unmapped.includes(s)) unmapped.push(s);
    return undefined;
  });
  return { states, unmapped };
}

// The config check: every value names a Source state.
export function statusMapProblems(path: string, statuses: unknown): string[] {
  if (typeof statuses !== "object" || statuses === null || Array.isArray(statuses)) return [];
  return Object.entries(statuses).flatMap(([name, state]) =>
    isSourceState(state)
      ? []
      : [`${path}.${name} must be one of ${SOURCE_STATES.join(", ")}, got ${JSON.stringify(state)}.`],
  );
}
