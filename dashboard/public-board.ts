// The public read-only board: a status link a client can open with no sign-in. Off unless
// FACTORY_PUBLIC_BOARD names the repos to show (owner/name, comma separated); a repo not named is
// a 404, the same as when the variable is unset. Each card is built from an allow-list (number,
// scrubbed title, column), so a label, a risk object, a model name or a host has no field to ride in on.

import type { Route } from "./plane/access";
import { scrubText } from "./ledger-public";

export const PUBLIC_BOARD_ENV = "FACTORY_PUBLIC_BOARD";
export const PUBLIC_BOARD_ROUTE = "GET /public/board";
export const PUBLIC_CARD_KEYS: readonly string[] = ["issue", "title", "column"];

export interface PublicCard {
  readonly issue: number;
  readonly title: string;
  readonly column: string;
}

export function publicRepos(env: Record<string, string | undefined>): string[] {
  return (env[PUBLIC_BOARD_ENV] ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r) => /^[\w-]+\/[\w.-]+$/.test(r));
}

const notFound = () => Response.json({ error: "not found" }, { status: 404 });

export function publicCard(card: { issue: number; title: string; column: string }): PublicCard {
  return { issue: card.issue, title: scrubText(card.title) || `Issue ${card.issue}`, column: card.column };
}

// `board` reads the plane's own board for a repo (in process); the route only filters it.
export function publicBoardRoutes(deps: {
  board: (repo: string) => Promise<Response>;
  env?: Record<string, string | undefined>;
}): Route[] {
  return [
    {
      method: "GET",
      pattern: /^\/public\/board(?:\/([\w-]+\/[\w.-]+))?$/,
      label: PUBLIC_BOARD_ROUTE,
      public: true,
      handler: async (_req, _url, m) => {
        const shown = publicRepos(deps.env ?? process.env);
        const repo = m[1] ?? shown[0] ?? "";
        if (!shown.includes(repo)) return notFound();
        const res = await deps.board(repo);
        if (!res.ok) return notFound();
        const body = (await res.json()) as { cards?: { issue: number; title: string; column: string }[] };
        return Response.json(
          { repo, cards: (body.cards ?? []).map(publicCard) },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  ];
}
