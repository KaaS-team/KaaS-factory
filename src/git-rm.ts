import { isAbsolute, relative, resolve } from "node:path";
import { ALWAYS_PROTECTED_PATHS, touchesProtectedPath } from "./boundary";

// Build may `git rm` a file its plan removes (#52). The allow rule matches only the prefix, so
// the path limits live here and in guard-paths.sh, which applies the same ones to a stage's Bash.
const GLOB_CHARS = /[*?[\]{}$`~]/;

// A path is protected when it matches, when it is a directory holding a match, or when a pattern lives under it.
function reachesProtected(rel: string, protectedPaths: readonly string[]): boolean {
  if (touchesProtectedPath([rel, `${rel}/x`], protectedPaths).length) return true;
  return [...protectedPaths, ...ALWAYS_PROTECTED_PATHS].some((glob) =>
    (glob.split(/[*?[{]/)[0] ?? "").startsWith(`${rel}/`),
  );
}

// The reason one `git rm` command is refused, or undefined when every path is inside root and unprotected.
export function gitRmProblem(command: string, root: string, protectedPaths: readonly string[]): string | undefined {
  const words = command.trim().split(/\s+/);
  if (words[0] !== "git" || words[1] !== "rm") return "not a git rm command";
  const paths: string[] = [];
  let flags = true;
  for (const word of words.slice(2)) {
    if (flags && word === "--") flags = false;
    else if (flags && word.startsWith("-")) {
      if (!/^-[rfq]+$|^--(quiet|ignore-unmatch)$/.test(word)) return `flag ${word} is not allowed`;
    } else paths.push(word.replace(/^(['"])(.*)\1$/, "$2"));
  }
  if (!paths.length) return "no path given";
  for (const path of paths) {
    if (GLOB_CHARS.test(path)) return `${path} is a pattern, name each file`;
    const rel = relative(root, resolve(root, path));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return `${path} is outside the worktree`;
    if (reachesProtected(rel, protectedPaths)) return `${path} is a protected path`;
  }
  return undefined;
}
