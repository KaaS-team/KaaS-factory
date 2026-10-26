// The tamper check on a PR diff: an agent can pass a gate by weakening it instead of fixing the
// code, so verify fails a diff that deletes tests, adds a skip, edits the runner's config or forces
// a zero exit (spec 10 tamper-guard). It reads only the diff, so it costs no test run.

import { isTestPath } from "./proof";

// Files that decide what "the tests pass" means. A change here needs a person.
const RUNNER_CONFIG = [
  /(^|\/)(bunfig\.toml|pytest\.ini|tox\.ini|setup\.cfg|\.mocharc\.[a-z]+|karma\.conf\.[a-z]+)$/,
  /(^|\/)(jest|vitest|playwright|cypress)\.config\.[cm]?[jt]s$/,
  /(^|\/)(Makefile|justfile)$/,
  /^\.factory\/(config\.json|gates\.sh|mutate\.sh)$/,
  /^\.github\/workflows\//,
  /^tests\/mutations\.json$/,
];

const SKIP = [
  /\b(test|it|describe)\.(skip|only|todo|failing)\s*\(/,
  /\b(xit|xdescribe|xtest)\s*\(/,
  /@pytest\.mark\.(skip|xfail)/,
  /\bt\.Skip(Now|f)?\(/,
  /#\[ignore\]/,
  /\bskip\s*\(\s*["'`]/,
];

const FORCED_PASS = [/\bprocess\.exit\(\s*0\s*\)/, /\bexit\s+0\b/, /\|\|\s*true\b/, /\bsys\.exit\(\s*0\s*\)/];
const ASSERTION = /\b(expect|assert\w*|should)\b|\b(test|it)\s*\(/;

interface FileDiff {
  path: string;
  deleted: boolean;
  added: string[];
  removed: string[];
}

function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  for (const line of diff.split("\n")) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (head) {
      cur = { path: head[2]!, deleted: false, added: [], removed: [] };
      files.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("deleted file mode")) cur.deleted = true;
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) cur.added.push(line.slice(1));
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
  }
  return files;
}

// Each hit names the file and why; an empty list means the diff leaves the proof as strong as it was.
export function tamperHits(diff: string): string[] {
  const hits: string[] = [];
  for (const f of parseDiff(diff)) {
    const test = isTestPath(f.path);
    if (RUNNER_CONFIG.some((re) => re.test(f.path))) hits.push(`${f.path}: runner config changed`);
    if (test && f.deleted) hits.push(`${f.path}: test file deleted`);
    if (f.added.some((l) => SKIP.some((re) => re.test(l)))) hits.push(`${f.path}: adds a skip marker`);
    if ((test || f.path.endsWith(".sh")) && f.added.some((l) => FORCED_PASS.some((re) => re.test(l))))
      hits.push(`${f.path}: forces a zero exit`);
    if (test && !f.deleted) {
      const lost = f.removed.filter((l) => ASSERTION.test(l)).length - f.added.filter((l) => ASSERTION.test(l)).length;
      if (lost > 0) hits.push(`${f.path}: removes ${lost} assertions`);
    }
    if (f.path.endsWith("package.json") && [...f.added, ...f.removed].some((l) => /"test[\w:-]*"\s*:/.test(l)))
      hits.push(`${f.path}: the test script changed`);
  }
  return hits;
}
