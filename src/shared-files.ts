// Files every parallel branch tends to edit. A plan that names one needs a shard or an excuse.

export const SHARED_FILES: readonly string[] = [
  "tests/mutations.json",
  "tests/ci-wiring.test.ts",
  "tests/mutation-list.test.ts",
  "tests/skip-count.test.ts",
  "quality-baseline.json",
  "Makefile",
];

// An ok line is `Shared-ok: <path>: <reason>`, with a reason.
function excused(okLines: string[]): Set<string> {
  const out = new Set<string>();
  for (const line of okLines) {
    const m = /^\s*Shared-ok:\s*(\S+?):\s*(.*)$/i.exec(line);
    if (m && m[2]!.trim()) out.add(m[1]!);
  }
  return out;
}

export function sharedClaims(files: string[], okLines: string[]): string[] {
  const ok = excused(okLines);
  return [...new Set(files)].filter((f) => SHARED_FILES.includes(f) && !ok.has(f));
}
