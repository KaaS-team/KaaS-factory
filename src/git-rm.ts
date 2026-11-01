import { isAbsolute, relative, resolve } from "node:path";
import { touchesProtectedPath } from "./boundary";

// Build may `git rm` a file its plan removes (#52). The allow rule matches only the prefix, so
// the path limits live here and in guard-paths.sh, which applies the same ones to a stage's Bash.
// Plain path characters only: no glob, no pathspec magic, no quoting tricks.
const PLAIN_PATH = /^[\w@%+=,./-]+$/;

// The reason one `git rm` command is refused, or undefined when every path is inside root and unprotected.
export function gitRmProblem(command: string, root: string, protectedPaths: readonly string[]): string | undefined {
  const words = command.trim().split(/\s+/);
  if (words[0] !== "git" || words[1] !== "rm") return "not a git rm command";
  const paths: string[] = [];
  let flags = true;
  for (const word of words.slice(2)) {
    if (flags && word === "--") flags = false;
    else if (flags && word.startsWith("-")) {
      if (!/^-[fq]+$|^--(quiet|ignore-unmatch)$/.test(word)) return `flag ${word} is not allowed`;
    } else paths.push(word.replace(/^(['"])(.*)\1$/, "$2"));
  }
  if (!paths.length) return "no path given";
  for (const path of paths) {
    if (!PLAIN_PATH.test(path)) return `${path} is a pattern, name each file`;
    const rel = relative(root, resolve(root, path));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return `${path} is outside the worktree`;
    if (touchesProtectedPath([rel], protectedPaths).length) return `${path} is a protected path`;
  }
  return undefined;
}
