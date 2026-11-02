// A change set: an issue body's "Repos: owner/name#12, owner/other#7" line
// names the pull-request issues, across repositories, that make up one piece
// of work. The listed order is the merge order. Pure parsing and a state
// check; nothing here fetches state or merges.

export interface ChangeSetEntry {
  readonly repo: string;
  readonly issue: number;
}

export type EntryState = "open" | "merged" | "closed";

const REPOS_LINE = /^.*Repos:\s*(.+?)\s*$/im;
const ENTRY = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/;

const keyOf = (e: ChangeSetEntry): string => `${e.repo}#${e.issue}`;

// The entries on the first "Repos:" line, in listed order. "none" or no line
// gives []. Malformed entries are skipped and duplicates collapse to the first.
export function parseRepos(body: string): ChangeSetEntry[] {
  const line = body.match(REPOS_LINE)?.[1];
  if (!line || /^none$/i.test(line)) return [];
  const seen = new Set<string>();
  const out: ChangeSetEntry[] = [];
  for (const raw of line.split(",")) {
    const m = raw.trim().match(ENTRY);
    if (!m) continue;
    const entry = { repo: m[1] as string, issue: Number(m[2]) };
    const key = keyOf(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

// The entries not yet merged, as "owner/name#N" keys in listed order. A closed
// entry and an entry with no known state both count as not merged.
export function waitingOn(set: readonly ChangeSetEntry[], state: Map<string, EntryState>): string[] {
  return set.map(keyOf).filter((key) => state.get(key) !== "merged");
}
