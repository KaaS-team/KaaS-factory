// The port the plane offers to code it does not ship: sign-in schemes, custom roles, tenancy.
// ee/ implements it and registers itself (`bun --preload ./ee/register.ts`), so the core never
// names ee/ and runs unchanged without it.
import type { Actor, Route } from "./access";
import type { PlaneStore } from "./store";

export interface PlaneContext {
  readonly store: PlaneStore;
  readonly env: Record<string, string | undefined>;
  readonly fetch: typeof fetch;
  // Opens a session for a login and redirects to `to`; the caller has already proved who it is.
  startSession(req: Request, login: string, to?: string): Response;
  actorOf(req: Request): Actor | undefined;
  // The member behind a login, custom roles resolved; null when the plane does not know them.
  member(login: string): Actor | null;
}

export interface PlaneExtension {
  readonly name: string;
  routes?(ctx: PlaneContext): Route[];
  // True when this extension signs people in, so a plane on a network counts as guarded.
  guards?(): boolean;
  // Turns a stored role the ladder does not know (a custom role) into an actor; null refuses.
  actor?(login: string, storedRole: string): Actor | null;
  // false refuses, true allows, undefined leaves it to the role ladder; any false beats any true.
  // A Response refuses a malformed request with that answer. It may be async, to read the body.
  allows?(who: Actor, route: Route, req: Request): Verdict | Promise<Verdict>;
  // Narrows a list route's repos to those the caller may see.
  visibleRepos?(who: Actor, repos: readonly string[]): string[];
}

type Verdict = boolean | undefined | Response;

const registered: PlaneExtension[] = [];

export function registerPlaneExtension(ext: PlaneExtension): void {
  if (!registered.some((e) => e.name === ext.name)) registered.push(ext);
}

export const planeExtensions = (): readonly PlaneExtension[] => registered;
