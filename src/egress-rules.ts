// The egress allowlist, rendered from the team's config instead of written by hand per runtime.
// Docker and microsandbox both take `allow` (and microsandbox `secrets`) from renderEgress, so one
// function decides what a run may reach. The proxy filters by host today; the path rules here are
// what egressViolations checks, so a write rule can never name a repo the team did not configure.

export interface TeamEgress {
  readonly githubHost?: string;
  readonly repos: readonly string[]; // "owner/name", the only repos a run may write to
  readonly modelHost: string;
  readonly modelPath: string;
  readonly secrets: readonly { readonly env: string; readonly hosts: readonly string[] }[];
}

export type EgressRule =
  | { readonly kind: "git-read"; readonly host: string; readonly path: string }
  | { readonly kind: "git-write" | "api-write"; readonly host: string; readonly repo: string; readonly path: string }
  | { readonly kind: "model-post"; readonly host: string; readonly path: string }
  | { readonly kind: "secret"; readonly env: string; readonly hosts: readonly string[] };

export interface RenderedEgress {
  readonly rules: readonly EgressRule[];
  readonly allow: string[];
  readonly secrets: string[];
}

const REPO = /^[\w.-]+\/[\w.-]+$/;
const HOST = /^[\w.-]+$/;

export const writePath = (kind: "git-write" | "api-write", repo: string): string =>
  kind === "git-write" ? `/${repo}.git/git-receive-pack` : `/repos/${repo}/**`;

const apiHost = (gh: string): string => (gh === "github.com" ? "api.github.com" : gh);

export function renderEgress(cfg: TeamEgress): RenderedEgress {
  const gh = cfg.githubHost ?? "github.com";
  for (const r of cfg.repos) if (!REPO.test(r)) throw new Error(`egress: "${r}" is not owner/name`);
  for (const h of [gh, cfg.modelHost, ...cfg.secrets.flatMap((s) => s.hosts)])
    if (!HOST.test(h)) throw new Error(`egress: "${h}" is not a hostname`);
  const rules: EgressRule[] = [
    { kind: "git-read", host: gh, path: "/**/git-upload-pack" },
    ...cfg.repos.flatMap((repo): EgressRule[] => [
      { kind: "git-write", host: gh, repo, path: writePath("git-write", repo) },
      { kind: "api-write", host: apiHost(gh), repo, path: writePath("api-write", repo) },
    ]),
    { kind: "model-post", host: cfg.modelHost, path: cfg.modelPath },
    ...cfg.secrets.map((s): EgressRule => ({ kind: "secret", env: s.env, hosts: s.hosts })),
  ];
  const hosts = rules.flatMap((r) => (r.kind === "secret" ? r.hosts : [r.host]));
  return {
    rules,
    allow: [...new Set(hosts)],
    secrets: cfg.secrets.map((s) => `${s.env}@${s.hosts.join(",")}`),
  };
}

// Empty when every rule is one the config permits.
export function egressViolations(rules: readonly EgressRule[], cfg: TeamEgress): string[] {
  const repos = new Set(cfg.repos.map((r) => r.toLowerCase()));
  const out: string[] = [];
  for (const r of rules) {
    if (r.kind === "git-write" || r.kind === "api-write") {
      if (!repos.has(r.repo.toLowerCase())) out.push(`${r.kind} names unconfigured repo ${r.repo}`);
      else if (r.path !== writePath(r.kind, r.repo)) out.push(`${r.kind} path ${r.path} is not ${r.repo}'s own`);
    } else if (r.kind === "secret") {
      const own = cfg.secrets.find((s) => s.env === r.env)?.hosts;
      if (!own) out.push(`secret ${r.env} is not configured`);
      else for (const h of r.hosts) if (!own.includes(h)) out.push(`secret ${r.env} swapped on unlisted host ${h}`);
    } else if (r.kind === "model-post" && (r.host !== cfg.modelHost || r.path !== cfg.modelPath)) {
      out.push(`model-post ${r.host}${r.path} is not the configured endpoint`);
    }
  }
  const posts = rules.filter((r) => r.kind === "model-post").length;
  if (posts !== 1) out.push(`expected one model-post rule, found ${posts}`);
  return out;
}
