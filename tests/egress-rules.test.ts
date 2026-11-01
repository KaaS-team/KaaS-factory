// The egress allowlist is rendered from team config; a rule outside that config must fail here.
import { describe, expect, test } from "bun:test";
import { sandboxArgs } from "../src/adapters/microsandbox/execution";
import { type EgressRule, egressViolations, renderEgress, type TeamEgress } from "../src/egress-rules";

const CONFIGS: TeamEgress[] = [
  {
    repos: ["acme/app"],
    modelHost: "api.model.test",
    modelPath: "/v1/messages",
    secrets: [{ env: "MODEL_KEY", hosts: ["api.model.test"] }],
  },
  {
    githubHost: "ghe.acme.test",
    repos: ["acme/app", "acme/docs"],
    modelHost: "llm.acme.test",
    modelPath: "/chat",
    secrets: [
      { env: "MODEL_KEY", hosts: ["llm.acme.test"] },
      { env: "GH_TOKEN", hosts: ["ghe.acme.test"] },
    ],
  },
];

describe("rendered egress rules", () => {
  test("every rendered list is clean and writes only to configured repos", () => {
    for (const cfg of CONFIGS) {
      const { rules } = renderEgress(cfg);
      expect(egressViolations(rules, cfg)).toEqual([]);
      const written = rules.flatMap((r) => (r.kind === "git-write" || r.kind === "api-write" ? [r.repo] : []));
      expect([...new Set(written)]).toEqual([...cfg.repos]);
    }
  });

  test("git read is open to any repo, with no per-repo read rule", () => {
    const { rules } = renderEgress(CONFIGS[0]!);
    expect(rules.filter((r) => r.kind === "git-read")).toEqual([
      { kind: "git-read", host: "github.com", path: "/**/git-upload-pack" },
    ]);
  });

  test("adding an unconfigured repo to a write rule fails", () => {
    const cfg = CONFIGS[0]!;
    const extra: EgressRule = {
      kind: "git-write",
      host: "github.com",
      repo: "evil/other",
      path: "/evil/other.git/git-receive-pack",
    };
    const rules = [...renderEgress(cfg).rules, extra];
    expect(egressViolations(rules, cfg)).toEqual(["git-write names unconfigured repo evil/other"]);
    const api: EgressRule = {
      kind: "api-write",
      host: "api.github.com",
      repo: "evil/other",
      path: "/repos/evil/other/**",
    };
    expect(egressViolations([...renderEgress(cfg).rules, api], cfg)).toEqual([
      "api-write names unconfigured repo evil/other",
    ]);
  });

  test("a write rule whose path reaches past its repo fails", () => {
    const cfg = CONFIGS[0]!;
    const rules = renderEgress(cfg).rules.map((r) => (r.kind === "api-write" ? { ...r, path: "/repos/**" } : r));
    expect(egressViolations(rules, cfg)).toEqual(["api-write path /repos/** is not acme/app's own"]);
  });

  test("a secret rule for an unlisted host fails", () => {
    const cfg = CONFIGS[0]!;
    const rules = renderEgress(cfg).rules.map((r) =>
      r.kind === "secret" ? { ...r, hosts: [...r.hosts, "attacker.test"] } : r,
    );
    expect(egressViolations(rules, cfg)).toEqual(["secret MODEL_KEY swapped on unlisted host attacker.test"]);
    const stray: EgressRule = { kind: "secret", env: "OTHER", hosts: ["api.model.test"] };
    expect(egressViolations([...renderEgress(cfg).rules, stray], cfg)).toEqual(["secret OTHER is not configured"]);
  });

  test("exactly one model POST rule, on the configured endpoint", () => {
    const cfg = CONFIGS[0]!;
    const rules = renderEgress(cfg).rules;
    const second: EgressRule = { kind: "model-post", host: "api.model.test", path: "/v1/other" };
    expect(egressViolations([...rules, second], cfg)).toEqual([
      "model-post api.model.test/v1/other is not the configured endpoint",
      "expected one model-post rule, found 2",
    ]);
    expect(
      egressViolations(
        rules.filter((r) => r.kind !== "model-post"),
        cfg,
      ),
    ).toEqual(["expected one model-post rule, found 0"]);
  });

  test("docker and microsandbox take the same allow list from one render", () => {
    const cfg = CONFIGS[1]!;
    const out = renderEgress(cfg);
    expect(out.allow).toEqual(["ghe.acme.test", "llm.acme.test"]);
    expect(out.secrets).toEqual(["MODEL_KEY@llm.acme.test", "GH_TOKEN@ghe.acme.test"]);
    const args = sandboxArgs(
      { kind: "microsandbox", image: "node:22-slim", allow: out.allow, secrets: out.secrets },
      "true",
      "/w",
      "n",
    );
    const rules = args.flatMap((a, i) => (args[i - 1] === "--net-rule" && a.endsWith(":tcp:443") ? [a] : []));
    expect(rules).toEqual(out.allow.map((h) => `allow@${h}:tcp:443`));
    const secrets = args.flatMap((a, i) => (args[i - 1] === "--secret" ? [a] : []));
    expect(secrets).toEqual(out.secrets);
  });

  test("refuses a repo or host that is not well formed", () => {
    expect(() => renderEgress({ ...CONFIGS[0]!, repos: ["acme/app/../x"] })).toThrow("is not owner/name");
    expect(() => renderEgress({ ...CONFIGS[0]!, modelHost: "a.test,b.test" })).toThrow("is not a hostname");
  });
});
