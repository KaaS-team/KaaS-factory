// Steering from the web. Every command is a comment on the issue, posted before the route answers,
// so a runner that only polls the tracker obeys it and the tracker stays the one record of who
// asked for what (docs/control-plane.md).
import type { ScmPort } from "../../src/github";
import { act, buildInbox, type InboxAction, InboxError } from "../../src/inbox";
import { LABEL, TYPE_LABELS } from "../../src/labels";
import { signedBy } from "../../src/chatops";
import { type Actor, BREAK_GLASS, LOCAL, type Route } from "./access";
import type { Role } from "./store";

export interface CommandDeps {
  github: Pick<ScmPort, "getIssue" | "commentIssue" | "createIssue">;
  // The repo the access gate resolved for this request (dashboard/plane/repo-scope.ts).
  repoOf: (req: Request) => string;
  actorOf: (req: Request) => Actor | undefined;
  invalidate: (repo: string) => void;
}

// Approving a plan is the one command an approver may send; the rest change what the agent does.
export const COMMANDS: Readonly<Record<string, { action: InboxAction; role: Role }>> = {
  "approve-plan": { action: "approve", role: "approver" },
  revise: { action: "revise", role: "operator" },
  answer: { action: "answer", role: "operator" },
  retry: { action: "retry", role: "operator" },
  cancel: { action: "cancel", role: "operator" },
};

const TITLE_MAX = 256;
const BODY_MAX = 20_000;

// The comment goes out under the runner's tracker account, so it names the person instead.
export function senderName(actor: Actor | undefined): string {
  if (!actor || actor.login === LOCAL) return "the local owner";
  return actor.login === BREAK_GLASS ? "the break-glass token" : `@${actor.login}`;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export function commandRoutes(deps: CommandDeps): Route[] {
  const command = ([name, { action, role }]: [string, { action: InboxAction; role: Role }]): Route => ({
    method: "POST",
    pattern: new RegExp(`^/api/issues/(\\d+)/${name}$`),
    label: `POST /api/issues/:n/${name}`,
    role,
    repo: "body",
    handler: async (req, _url, m) => {
      const repo = deps.repoOf(req);
      const n = Number(m[1]);
      const body = (await req.json().catch(() => ({}))) as { text?: unknown };
      // Read the issue fresh: a cached state could let a command through that the issue no longer takes.
      const item = buildInbox([await deps.github.getIssue(repo, n)])[0];
      if (!item?.actions.includes(action))
        return json({ error: `#${n} is not waiting for ${name}${item ? ` (it is ${item.kind})` : ""}` }, 409);
      try {
        const text = typeof body.text === "string" ? body.text : "";
        const posted = await act(deps.github, repo, item, action, text, senderName(deps.actorOf(req)));
        deps.invalidate(repo);
        return json({ ok: true, posted });
      } catch (err) {
        if (err instanceof InboxError) return json({ error: err.message }, 400);
        throw err;
      }
    },
  });

  return [
    {
      method: "POST",
      pattern: /^\/api\/tasks$/,
      label: "POST /api/tasks",
      role: "operator",
      repo: "body",
      // A task is an issue labelled ready, so the runner picks it up the same way as one filed by hand.
      handler: async (req) => {
        const repo = deps.repoOf(req);
        const body = (await req.json().catch(() => ({}))) as { title?: unknown; body?: unknown; type?: unknown };
        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (!title || title.length > TITLE_MAX)
          return json({ error: `title must be 1 to ${TITLE_MAX} characters` }, 400);
        const text = typeof body.body === "string" ? body.body.trim() : "";
        if (text.length > BODY_MAX) return json({ error: `body must be at most ${BODY_MAX} characters` }, 400);
        const type = body.type ?? null;
        if (type !== null && !TYPE_LABELS.includes(type as (typeof TYPE_LABELS)[number]))
          return json({ error: `type must be one of ${TYPE_LABELS.join(", ")}` }, 400);
        const labels = [LABEL.ready, ...(type ? [type as string] : [])];
        const issue = await deps.github.createIssue(repo, title, signedBy(text, senderName(deps.actorOf(req))), labels);
        deps.invalidate(repo);
        return json({ ok: true, issue });
      },
    },
    ...Object.entries(COMMANDS).map(command),
  ];
}
