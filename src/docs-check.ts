// A boundary change (a public API, a schema, a config format) needs a decision record in the same diff.
// The charter's optional `## Boundaries` section lists the globs; without it nothing is checked.

export function boundaryGlobs(charterText: string): string[] {
  const m = /^## Boundaries[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(charterText);
  if (!m) return [];
  return (m[1] ?? "")
    .split("\n")
    .map((l) => /^\s*[-*]\s+`([^`]+)`/.exec(l)?.[1])
    .filter((g): g is string => g !== undefined && !g.includes("TODO"));
}

// The boundary paths changed when no path under docs/decisions/ changed in the same diff.
export function docsMissing(changed: readonly string[], globs: readonly string[]): string[] {
  if (changed.some((p) => p.startsWith("docs/decisions/"))) return [];
  const hit = globs.map((g) => new Bun.Glob(g));
  return changed.filter((p) => hit.some((g) => g.match(p)));
}
