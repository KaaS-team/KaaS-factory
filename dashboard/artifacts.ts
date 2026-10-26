// Files a stage left in .factory/runs/issue-N/ of the issue's worktree. The name must be a plain
// file name that resolves inside that directory, and it is only ever sent as text, never as HTML.
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { runDir } from "../src/artifacts";
import { plain } from "../src/display";

export const ARTIFACT_LIMIT = 1024 * 1024;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function artifactRoot(workspaces: string, issue: number): string | null {
  try {
    return realpathSync(join(workspaces, `issue-${issue}`, runDir(issue)));
  } catch {
    return null;
  }
}

export function artifacts(workspaces: string, issue: number, url: URL): Response {
  const root = artifactRoot(workspaces, issue);
  const name = url.searchParams.get("file");
  if (!root) return json({ files: [] });
  if (!name) {
    const files = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => ({ name: e.name, size: statSync(join(root, e.name)).size }));
    return json({ files });
  }
  let path: string;
  try {
    path = realpathSync(join(root, name));
  } catch {
    return json({ error: "no such artifact" }, 404);
  }
  if (name.includes("/") || name.includes("\\") || !path.startsWith(root + sep) || !statSync(path).isFile()) {
    return json({ error: "no such artifact" }, 404);
  }
  const bytes = readFileSync(path);
  const truncated = bytes.length > ARTIFACT_LIMIT;
  const body = bytes.subarray(0, ARTIFACT_LIMIT);
  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "x-artifact-truncated": String(truncated),
  };
  if (url.searchParams.get("download"))
    headers["content-disposition"] = `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`;
  // A preview is text for a person; a download stays byte for byte.
  return new Response(url.searchParams.get("download") ? body : plain(Buffer.from(body).toString("utf8")), {
    headers,
  });
}
