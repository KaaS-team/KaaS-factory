import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcceptanceVerdict } from "../src/acceptance";
import {
  buildStatement,
  decodeStatement,
  type Envelope,
  envelopeFromBody,
  generateReceiptKey,
  missingReceipt,
  type ReceiptInput,
  renderReceipt,
  signStatement,
  type Statement,
  unsignedEnvelope,
  verifyEnvelope,
  writeRunReceipt,
} from "../src/receipt";
import { sanitizeEnv } from "../src/agents/env";
import { ShellSetupRunner } from "../src/setup";
import type { StageRun } from "../src/state";

const ROOT = join(import.meta.dir, "..");
// Shared across the mutation copies so each one rebuilds only the crate, never its dependencies.
const TARGET = process.env.CARGO_TARGET_DIR ?? join(tmpdir(), "kaas-verify-target");
const BIN = join(TARGET, "release", "kaas-verify");

beforeAll(() => {
  const built = Bun.spawnSync(
    [
      "cargo",
      "build",
      "--release",
      "--locked",
      "--quiet",
      "--manifest-path",
      join(ROOT, "verify/Cargo.toml"),
      "--target-dir",
      TARGET,
    ],
    { stderr: "pipe" },
  );
  if (built.exitCode !== 0) throw new Error(`cargo build of verify/ failed: ${built.stderr.toString()}`);
}, 300_000);

const acceptance: AcceptanceVerdict = {
  base: "origin/main",
  acs: [
    {
      spec: "specs/07-pricing.md",
      ac: "AC-1",
      text: "yearly shows $297",
      holdout: ["holdout/07/AC-1.test.ts"],
      new: true,
      base: "fail",
      head: "pass",
      ok: true,
    },
    {
      spec: "specs/07-pricing.md",
      ac: "AC-2",
      text: "no struck prices",
      holdout: ["holdout/07/AC-2.test.ts"],
      new: false,
      head: "pass",
      ok: true,
    },
  ],
  errors: [],
};

const run = (stage: string, model: string, cost: number | null): StageRun =>
  ({ stage, agent: "claude", model, exit_code: 0, cost_usd: cost }) as unknown as StageRun;

function input(over: Partial<ReceiptInput> = {}): ReceiptInput {
  return {
    repo: "acme/shop",
    issue: 42,
    baseRef: "main",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    at: "2026-10-25T00:00:00.000Z",
    acceptance,
    holdout: { ok: true },
    proof: { status: "bites", tests: ["tests/price.test.ts"] },
    runs: [run("build", "claude-haiku-5-5", 0.12), run("verify", "claude-sonnet-5-5", null)],
    files: { "acceptance.json": JSON.stringify(acceptance) },
    operatorDetail: true,
    ...over,
  };
}

const key = generateReceiptKey();
const dir = mkdtempSync(join(tmpdir(), "factory-receipt-"));
writeFileSync(join(dir, "key.pub"), key.publicKeyPem);

function kaasVerify(envelope: Envelope | string, ...args: string[]): { code: number; out: string } {
  const file = join(dir, `e-${crypto.randomUUID()}.json`);
  writeFileSync(file, typeof envelope === "string" ? envelope : JSON.stringify(envelope));
  const r = Bun.spawnSync([BIN, file, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
}

// A runner that signs a lie: the statement edited after it was built, then signed with the real key.
function forge(edit: (s: Statement) => void): Envelope {
  const s = JSON.parse(JSON.stringify(buildStatement(input()))) as Statement;
  edit(s);
  return signStatement(s, key.privateKeyPem);
}

describe("receipt statement", () => {
  test("every number is derived from the rows", () => {
    const { predicate: p } = buildStatement(input());
    expect(p.criteria.map((c) => [c.id, c.proof, c.ok])).toEqual([
      ["specs/07-pricing.md#AC-1", "fails-before-passes-after", true],
      ["specs/07-pricing.md#AC-2", "holds", true],
    ]);
    expect(p.verdict).toEqual({ proven: true, criteria: 2, failed: 0, errors: [], notProven: [] });
  });

  test("a criterion that already passed on the base is not proven, and says so", () => {
    const acs = [{ ...acceptance.acs[0]!, base: "pass" as const }];
    const { predicate: p } = buildStatement(input({ acceptance: { ...acceptance, acs } }));
    expect(p.verdict.proven).toBe(false);
    expect(p.verdict.notProven).toEqual(["specs/07-pricing.md#AC-1: already-passed"]);
  });

  test("a missing mutation proof is listed as not proven without failing the verdict", () => {
    const { predicate: p } = buildStatement(input({ proof: undefined }));
    expect(p.verdict.proven).toBe(true);
    expect(p.verdict.notProven).toEqual(["mutation proof: unavailable"]);
  });

  test("a failed holdout is never proven, whatever the criteria say", () => {
    const { predicate: p } = buildStatement(input({ holdout: { ok: false } }));
    expect(p.verdict.proven).toBe(false);
    expect(p.verdict.notProven).toEqual(["holdout tests failed"]);
  });

  test("prRunSummary off leaves no model or spend in the receipt", () => {
    const { predicate: p } = buildStatement(input({ operatorDetail: false }));
    expect(p.steps.every((s) => s.model === null && s.costUsd === null)).toBe(true);
  });

  // The context is the open vocabulary: every term a receipt uses resolves to PROV-O or the kaas: namespace.
  test("verify/context.jsonld defines every key a predicate carries", () => {
    const ctx = JSON.parse(readFileSync(join(ROOT, "verify/context.jsonld"), "utf8"))["@context"] as Record<
      string,
      unknown
    >;
    const keys = new Set<string>();
    const walk = (v: unknown, inArtifacts = false): void => {
      if (Array.isArray(v)) v.forEach((x) => walk(x));
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          if (!inArtifacts && k !== "@context") keys.add(k);
          walk(x, k === "artifacts");
        }
    };
    walk(buildStatement(input()).predicate);
    expect([...keys].filter((k) => !(k in ctx))).toEqual([]);
  });

  test("the subject is the head commit", () => {
    expect(buildStatement(input()).subject[0]!.digest.gitCommit).toBe("b".repeat(40));
  });
});

describe("DSSE signing", () => {
  // An agent that held the key could sign a receipt for work it never proved.
  test("no agent stage ever sees the signing key", () => {
    expect(sanitizeEnv({ FACTORY_RECEIPT_KEY: key.privateKeyPem, PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });

  test("a signed envelope verifies with its key and not with another", () => {
    const env = signStatement(buildStatement(input()), key.privateKeyPem);
    expect(verifyEnvelope(env, key.publicKeyPem)).toBe(true);
    expect(verifyEnvelope(env, generateReceiptKey().publicKeyPem)).toBe(false);
  });

  test("the PR section round-trips the envelope and lists what is not proven", () => {
    const env = signStatement(buildStatement(input({ proof: undefined })), key.privateKeyPem);
    const body = `Closes #42\n\n${renderReceipt(env)}`;
    expect(body).toContain("### Not proven\n\n- mutation proof: unavailable");
    expect(envelopeFromBody(body)).toEqual(env);
    expect(decodeStatement(envelopeFromBody(body)!).predicate.run.issue).toBe(42);
  });

  test("a receipt that could not be built still says nothing is attested", () => {
    expect(missingReceipt("git rev-parse failed")).toContain("- nothing in this run is attested");
  });
});

describe("kaas-verify, the independent checker", () => {
  test("a signed honest receipt is VERIFIED", () => {
    const r = kaasVerify(signStatement(buildStatement(input()), key.privateKeyPem), "--pubkey", join(dir, "key.pub"));
    expect(r).toEqual({ code: 0, out: `VERIFIED  acme/shop#42 at ${"b".repeat(12)} proven=true` });
  });

  test("without a trusted key it is UNCHECKED, and unsigned is UNSIGNED", () => {
    expect(kaasVerify(signStatement(buildStatement(input()), key.privateKeyPem)).code).toBe(2);
    expect(kaasVerify(unsignedEnvelope(buildStatement(input())), "--pubkey", join(dir, "key.pub")).code).toBe(3);
  });

  test("a payload edited after signing is TAMPERED at the signature", () => {
    const env = signStatement(buildStatement(input()), key.privateKeyPem);
    const s = decodeStatement(env) as { predicate: { run: { issue: number } } };
    s.predicate.run.issue = 43;
    const edited = { ...env, payload: Buffer.from(`${JSON.stringify(s)}\n`).toString("base64") };
    const r = kaasVerify(edited, "--pubkey", join(dir, "key.pub"));
    expect(r.code).toBe(1);
    expect(r.out).toBe("TAMPERED  signatures[0].sig: does not match the payload");
  });

  test("a different key is TAMPERED, not VERIFIED", () => {
    const other = generateReceiptKey();
    writeFileSync(join(dir, "other.pub"), other.publicKeyPem);
    const r = kaasVerify(signStatement(buildStatement(input()), key.privateKeyPem), "--pubkey", join(dir, "other.pub"));
    expect(r.code).toBe(1);
    expect(r.out).toStartWith("TAMPERED  signatures: no signature by key");
  });

  // Each forged line is signed with the real key, so only the re-derivation can catch it.
  const forgeries: [string, (s: Statement) => void, string][] = [
    [
      "a failing criterion marked ok",
      (s) => Object.assign(s.predicate.criteria[0]!, { head: "fail" }),
      "criteria[0].proof: the rows say fails",
    ],
    [
      "a proof label that the rows do not give",
      (s) => Object.assign(s.predicate.criteria[0]!, { base: "pass" }),
      "criteria[0].proof: the rows say already-passed",
    ],
    [
      "an ok flag flipped on an unproven criterion",
      (s) => Object.assign(s.predicate.criteria[0]!, { base: "pass", proof: "already-passed" }),
      "criteria[0].ok: already-passed gives ok=false",
    ],
    [
      "a padded criteria count",
      (s) => Object.assign(s.predicate.verdict, { criteria: 3 }),
      "verdict.criteria: the receipt lists 2 criteria",
    ],
    [
      "a hidden failure count",
      (s) => Object.assign(s.predicate.verdict, { failed: 1 }),
      "verdict.failed: 0 criteria are not proven",
    ],
    [
      "proven claimed over a failed holdout",
      (s) => Object.assign(s.predicate.holdout, { ok: false }),
      "verdict.proven: the rows give proven=false",
    ],
    [
      "a not-proven line dropped",
      (s) => Object.assign(s.predicate.mutationProof, { status: "survives" }),
      'verdict.notProven: the rows give ["mutation proof: survives"]',
    ],
    [
      "a subject that is not the head",
      (s) => Object.assign(s.subject[0]!.digest, { gitCommit: "c".repeat(40) }),
      "subject[0].digest.gitCommit: does not name run.head.sha",
    ],
  ];
  for (const [name, edit, field] of forgeries)
    test(`refuses ${name}, naming the field`, () => {
      const r = kaasVerify(forge(edit), "--pubkey", join(dir, "key.pub"));
      expect(r).toEqual({ code: 1, out: `TAMPERED  ${field}` });
    });

  test("--artifacts re-hashes the run files the receipt pins", () => {
    const runDir = join(dir, "run");
    mkdirSync(runDir, { recursive: true });
    const body = JSON.stringify(acceptance);
    writeFileSync(join(runDir, "acceptance.json"), body);
    const env = signStatement(buildStatement(input({ files: { "acceptance.json": body } })), key.privateKeyPem);
    expect(kaasVerify(env, "--pubkey", join(dir, "key.pub"), "--artifacts", runDir).code).toBe(0);
    writeFileSync(join(runDir, "acceptance.json"), body.replace("AC-1", "AC-9"));
    expect(kaasVerify(env, "--pubkey", join(dir, "key.pub"), "--artifacts", runDir).out).toBe(
      "TAMPERED  artifacts.acceptance.json: the file's sha256 differs",
    );
  });
});

describe("writeRunReceipt", () => {
  test("signs from the run dir's own files and the worktree's commits", async () => {
    const repo = mkdtempSync(join(tmpdir(), "factory-receipt-repo-"));
    const git = (cmd: string) =>
      Bun.spawnSync(["sh", "-c", cmd], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    git(
      "git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base && git update-ref refs/remotes/origin/main HEAD",
    );
    git("git -c user.email=t@t -c user.name=t commit -q --allow-empty -m head");
    const runDir = ".factory/runs/issue-42";
    mkdirSync(join(repo, runDir), { recursive: true });
    writeFileSync(join(repo, runDir, "acceptance.json"), JSON.stringify(acceptance));
    writeFileSync(
      join(repo, runDir, "proof.json"),
      JSON.stringify({ status: "bites", tests: ["t"], reverted: [], cmd: "", tail: "" }),
    );
    const env = await writeRunReceipt(new ShellSetupRunner(), {
      worktree: repo,
      runDir,
      repo: "acme/shop",
      issue: 42,
      base: "main",
      runs: [],
      operatorDetail: true,
      env: { FACTORY_RECEIPT_KEY: key.privateKeyPem },
    });
    const head = git("git rev-parse HEAD").stdout.toString().trim();
    expect(decodeStatement(env).predicate.run.head.sha).toBe(head);
    expect(JSON.parse(readFileSync(join(repo, runDir, "receipt.dsse.json"), "utf8"))).toEqual(env);
    const r = kaasVerify(env, "--pubkey", join(dir, "key.pub"), "--artifacts", join(repo, runDir));
    expect(r.code).toBe(0);
  });
});
