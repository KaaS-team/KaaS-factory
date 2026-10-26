// Setting a repo's autonomy from the web. Like every command, it is written to the tracker first: a
// `factory:mode` comment on the repo's control issue, which the runner reads before each merge
// decision (src/autonomy.ts webMode), so a runner that only polls still obeys it.
import { AUTONOMY_MODES, type Autonomy, CONTROL_LABEL, modeMarker, webMode } from "../../src/autonomy";
import { signedBy } from "../../src/chatops";
import type { ScmPort } from "../../src/github";
import type { Actor, Route } from "./access";
import { type CommandDeps, commandRoutes, senderName } from "./commands";

export interface ModeDeps {
  github: Pick<ScmPort, "listIssuesByLabel" | "createIssue" | "commentIssue" | "currentLogin" | "roleOf">;
  repoOf: (req: Request) => string;
  actorOf: (req: Request) => Actor | undefined;
  senderName: (actor: Actor | undefined) => string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const CONTROL_BODY = "The factory reads this repo's settings from this issue. Leave it open.";

export function modeRoutes(deps: ModeDeps): Route[] {
  return [
    {
      method: "GET",
      pattern: /^\/api\/mode$/,
      label: "GET /api/mode",
      role: "viewer",
      repo: "query",
      handler: async (req) => json({ mode: (await webMode(deps.github, deps.repoOf(req))) ?? null }),
    },
    {
      method: "POST",
      pattern: /^\/api\/mode$/,
      label: "POST /api/mode",
      // Autonomy decides whether a person merges at all, so only an owner moves it.
      role: "owner",
      repo: "body",
      handler: async (req) => {
        const repo = deps.repoOf(req);
        const body = (await req.json().catch(() => ({}))) as { mode?: unknown };
        if (!AUTONOMY_MODES.includes(body.mode as Autonomy))
          return json({ error: `mode must be one of ${AUTONOMY_MODES.join(", ")}` }, 400);
        const mode = body.mode as Autonomy;
        const found = (await deps.github.listIssuesByLabel(repo, CONTROL_LABEL))[0]?.number;
        const issue = found ?? (await deps.github.createIssue(repo, "Factory control", CONTROL_BODY, [CONTROL_LABEL]));
        const text = signedBy(
          `Autonomy is now **${mode}**.\n\n${modeMarker(mode)}`,
          deps.senderName(deps.actorOf(req)),
        );
        await deps.github.commentIssue(repo, issue, text);
        return json({ ok: true, mode, issue });
      },
    },
  ];
}

export { senderName };

// Every web command route, the mode included, so the server registers the plane in one place.
export function planeRoutes(deps: CommandDeps & Omit<ModeDeps, "senderName">): Route[] {
  return [...commandRoutes(deps), ...modeRoutes({ ...deps, senderName })];
}
