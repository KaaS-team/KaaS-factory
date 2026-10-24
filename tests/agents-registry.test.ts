// One loop over PRESETS: adding a preset without its fixture, pin, install target, docs row and README
// mention fails here. docs/agents.md's table is generated, so it must equal the registry.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PRESETS } from "../src/agents/presets";
import { agentsTable, renderAgentsDoc } from "../src/agents/docs";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const dockerVar = (name: string) => (name === "claude" ? "CLAUDE_CODE_VERSION" : `${name.toUpperCase()}_VERSION`);

describe("every preset is fully registered", () => {
  const docker = read("Dockerfile");
  const ci = read("template-ci/factory.yml.example");
  const installSh = read("install.sh");
  const agentsDoc = read("docs/agents.md");
  const readme = read("README.md");
  const runbook = read("docs/verify-an-agent.md");

  for (const p of Object.values(PRESETS)) {
    describe(p.name, () => {
      test("has a fixture dir with a jsonl and a fixture.json", () => {
        const dir = join(root, "tests/fixtures/agents", p.name);
        expect(existsSync(dir)).toBe(true);
        expect(readdirSync(dir).some((f) => f.endsWith(".jsonl"))).toBe(true);
        expect(JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"))).toHaveProperty("synthetic");
      });
      test("declares binary, version, envKeys, skills dir and how a read-only stage is held", () => {
        expect(p.binary).toBeTruthy();
        expect(p.version).toMatch(/^\d/);
        expect(p.envKeys.length).toBeGreaterThan(0);
        expect(p.skillsDir).toMatch(/^\.[a-z]+.*\/skills$/);
        expect(p.readOnlyBy.length).toBeGreaterThan(0);
      });
      test("the Dockerfile and the CI template pin its version, or it says docker: false", () => {
        if (p.docker === false) {
          expect(docker).not.toContain(`ARG ${dockerVar(p.name)}=`);
          return;
        }
        expect(new RegExp(`ARG ${dockerVar(p.name)}=${p.version.replaceAll(".", "\\.")}\\s`).test(docker)).toBe(true);
        expect(ci).toContain(`${dockerVar(p.name)}: "${p.version}"`);
      });
      test("install.sh links its skills dir", () => {
        expect(installSh).toContain(`${p.name}) echo "${p.skillsDir} `);
      });
      test("docs/agents.md and the README mention it, and the runbook covers it until it is verified", () => {
        expect(agentsDoc).toContain(`| \`${p.name}\` |`);
        expect(readme).toContain(`"preset": "${p.name}"`);
        if (!p.verified) expect(runbook).toContain(`\`${p.name}\``);
      });
    });
  }

  for (const p of Object.values(PRESETS)) {
    if (p.ownsPrompt) continue;
    test(`${p.name}: its prompt delivery is backed by a captured line and matches its argv`, () => {
      expect(p.promptVia).toBeDefined();
      const [file = "", line] = (p.evidence ?? "").split(":");
      const cited = read(file).split("\n")[Number(line) - 1] ?? "";
      expect(cited).toMatch(p.promptVia === "stdin" ? /stdin/i : /positional/i);
      const marker = "PROMPT-MARKER";
      const inv = p.command({ cwd: "/w", issue: 1, stage: "build" } as never, { model: undefined } as never, marker);
      expect(inv.stdin === marker).toBe(p.promptVia === "stdin");
      expect(inv.argv.includes(marker)).toBe(p.promptVia === "argv");
    });
  }

  test("docs/agents.md's generated table equals the registry", () => {
    expect(agentsDoc).toContain(agentsTable());
    expect(renderAgentsDoc(agentsDoc)).toBe(agentsDoc);
  });

  test("the CI template pins, installs and passes the key of every preset", () => {
    const pkg = (text: string, name: string) =>
      new RegExp(`\\b${name}\\) pkg="([^"]+)"`).exec(text)?.[1]?.replace(/\$\{[A-Z_]+\}/, "");
    const secrets = new Set(Object.values(PRESETS).flatMap((p) => p.envKeys));
    for (const p of Object.values(PRESETS)) {
      if (p.docker !== false) {
        expect(ci).toContain(`${dockerVar(p.name)}: "${p.version}"`);
        expect(pkg(ci, p.name), `${p.name}: install case`).toBeDefined();
        expect(pkg(ci, p.name), `${p.name}: same package as the Dockerfile`).toBe(pkg(docker, p.name));
      }
    }
    // Every job that runs an agent passes every key: 3 jobs (run-issue, tick, manual).
    for (const key of secrets) expect(ci.split(`${key}: \${{ secrets.${key} }}`).length - 1, key).toBe(3);
  });
});
