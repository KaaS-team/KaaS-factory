// The run's acceptance receipt: an in-toto Statement v1 in a DSSE envelope, signed with Ed25519, that a
// reviewer re-checks offline with verify/ (kaas-verify), a Rust checker that shares no code with this file.
// Every number in the predicate is derived from the run's own artifacts, and the verifier recomputes the
// verdict from the rows, so a receipt that claims more than its rows prove is refused even when signed.
// Why this shape: docs/decisions/signed-acceptance-receipts.md.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AcceptanceRow, AcceptanceVerdict } from "./acceptance";
import { shq } from "./core/frame";
import type { ExecutionPort } from "./ports/execution";
import type { ProofResult } from "./proof";
import type { StageRun } from "./state";

export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const PREDICATE_TYPE = "https://kaas.team/attestations/acceptance/v1";
export const PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const CONTEXT = "https://kaas.team/attestations/acceptance/v1/context.jsonld";
export const RECEIPT_FILE = "receipt.dsse.json";
export const RECEIPT_KEY_ENV = "FACTORY_RECEIPT_KEY";

export type CriterionProof = "fails-before-passes-after" | "holds" | "already-passed" | "fails" | "no-holdout";

export interface ReceiptCriterion {
  readonly id: string;
  readonly spec: string;
  readonly text: string;
  readonly holdout: readonly string[];
  readonly new: boolean;
  readonly base: "pass" | "fail" | null;
  readonly head: "pass" | "fail";
  readonly proof: CriterionProof;
  readonly ok: boolean;
}

export interface ReceiptStep {
  readonly stage: string;
  readonly agent: string;
  readonly model: string | null;
  readonly exitCode: number;
  readonly costUsd: number | null;
}

export interface AcceptancePredicate {
  readonly "@context": string;
  readonly run: {
    readonly repo: string;
    readonly issue: number;
    readonly base: { readonly ref: string; readonly sha: string };
    readonly head: { readonly sha: string };
    readonly at: string;
  };
  readonly criteria: readonly ReceiptCriterion[];
  readonly holdout: { readonly required: boolean; readonly ran: boolean; readonly ok: boolean | null };
  readonly mutationProof: { readonly status: string; readonly tests: number };
  readonly steps: readonly ReceiptStep[];
  readonly artifacts: Readonly<Record<string, string>>;
  readonly verdict: {
    readonly proven: boolean;
    readonly criteria: number;
    readonly failed: number;
    readonly errors: readonly string[];
    readonly notProven: readonly string[];
  };
}

export interface Statement {
  readonly _type: typeof STATEMENT_TYPE;
  readonly subject: readonly { readonly name: string; readonly digest: Readonly<Record<string, string>> }[];
  readonly predicateType: typeof PREDICATE_TYPE;
  readonly predicate: AcceptancePredicate;
}

export interface Envelope {
  readonly payloadType: string;
  readonly payload: string;
  readonly signatures: readonly { readonly keyid: string; readonly sig: string }[];
}

export interface ReceiptInput {
  readonly repo: string;
  readonly issue: number;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly at: string;
  readonly acceptance?: AcceptanceVerdict;
  readonly holdout?: { readonly ok: boolean };
  // Config enables a holdout, so a run without its result is not proven.
  readonly holdoutRequired: boolean;
  readonly proof?: Pick<ProofResult, "status" | "tests">;
  readonly runs: readonly StageRun[];
  // Raw bytes of each run-dir file the predicate stands on, hashed so the receipt pins them.
  readonly files: Readonly<Record<string, string>>;
  // Off when config.prRunSummary is off: the receipt then carries no model or spend.
  readonly operatorDetail: boolean;
}

export function criterionProof(r: Pick<AcceptanceRow, "holdout" | "new" | "base" | "head">): CriterionProof {
  if (!r.holdout.length) return "no-holdout";
  if (r.head !== "pass") return "fails";
  if (!r.new) return "holds";
  return r.base === "pass" ? "already-passed" : "fails-before-passes-after";
}

// The kit's rule (check-acceptance.py), applied again on both sides: the head passes and the base did not.
export function criterionOk(proof: CriterionProof): boolean {
  return proof === "fails-before-passes-after" || proof === "holds";
}

// What the receipt does not prove, in words a reviewer acts on; the PR's "Not proven" section.
export function notProven(
  p: Omit<AcceptancePredicate["verdict"], "notProven" | "proven">,
  input: {
    criteria: readonly ReceiptCriterion[];
    holdout: AcceptancePredicate["holdout"];
    mutationProof: AcceptancePredicate["mutationProof"];
    steps: readonly ReceiptStep[];
  },
): string[] {
  const out: string[] = [];
  if (!p.criteria) out.push("no acceptance criteria were found for this change");
  for (const c of input.criteria) if (!c.ok) out.push(`${c.id}: ${c.proof}`);
  for (const e of p.errors) out.push(`acceptance error: ${e}`);
  if (!input.holdout.ran) out.push("holdout tests did not run");
  else if (input.holdout.ok === false) out.push("holdout tests failed");
  if (input.mutationProof.status !== "bites") out.push(`mutation proof: ${input.mutationProof.status}`);
  return out;
}

// Proven is the acceptance gate's own bar plus the holdout, when config requires one; a missing mutation
// proof, or a holdout the repo never set up, is listed under "Not proven" without failing it.
export function isProven(
  v: Pick<AcceptancePredicate["verdict"], "criteria" | "failed" | "errors">,
  holdout: AcceptancePredicate["holdout"],
): boolean {
  const holdoutHeld = holdout.ran ? holdout.ok !== false : !holdout.required;
  return v.criteria > 0 && v.failed === 0 && v.errors.length === 0 && holdoutHeld;
}

export function buildStatement(input: ReceiptInput): Statement {
  const criteria: ReceiptCriterion[] = (input.acceptance?.acs ?? []).map((r) => {
    const proof = criterionProof(r);
    return {
      id: `${r.spec}#${r.ac}`,
      spec: r.spec,
      text: r.text,
      holdout: [...r.holdout],
      new: r.new,
      base: r.base ?? null,
      head: r.head,
      proof,
      ok: criterionOk(proof),
    };
  });
  const holdout = { required: input.holdoutRequired, ran: input.holdout !== undefined, ok: input.holdout?.ok ?? null };
  const mutationProof = { status: input.proof?.status ?? "unavailable", tests: input.proof?.tests.length ?? 0 };
  const steps = input.runs.map((r) => ({
    stage: r.stage,
    agent: r.agent,
    model: input.operatorDetail ? r.model : null,
    exitCode: r.exit_code,
    costUsd: input.operatorDetail ? r.cost_usd : null,
  }));
  const errors = [...(input.acceptance?.errors ?? [])];
  const counts = { criteria: criteria.length, failed: criteria.filter((c) => !c.ok).length, errors };
  const missing = notProven(counts, { criteria, holdout, mutationProof, steps });
  const artifacts = Object.fromEntries(
    Object.entries(input.files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, body]) => [name, sha256(body)]),
  );
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: `git+https://github.com/${input.repo}@${input.headSha}`, digest: { gitCommit: input.headSha } }],
    predicateType: PREDICATE_TYPE,
    predicate: {
      "@context": CONTEXT,
      run: {
        repo: input.repo,
        issue: input.issue,
        base: { ref: input.baseRef, sha: input.baseSha },
        head: { sha: input.headSha },
        at: input.at,
      },
      criteria,
      holdout,
      mutationProof,
      steps,
      artifacts,
      verdict: { proven: isProven(counts, holdout), ...counts, notProven: missing },
    },
  };
}

export function sha256(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

// DSSE pre-authentication encoding; lengths are byte lengths.
export function pae(payloadType: string, payload: Buffer): Buffer {
  const head = `DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `;
  return Buffer.concat([Buffer.from(head), payload]);
}

// The key id is the SHA-256 of the raw 32-byte public key, so the verifier derives it without parsing DER.
export function keyId(publicKeyPem: string): string {
  return sha256(rawPublicKey(publicKeyPem));
}

export function rawPublicKey(publicKeyPem: string): Buffer {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32);
}

export function signStatement(statement: Statement, privateKeyPem: string): Envelope {
  const payload = Buffer.from(`${JSON.stringify(statement)}\n`);
  const key = createPrivateKey(privateKeyPem);
  const pub = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  const sig = sign(null, pae(PAYLOAD_TYPE, payload), key);
  return {
    payloadType: PAYLOAD_TYPE,
    payload: payload.toString("base64"),
    signatures: [{ keyid: keyId(pub), sig: sig.toString("base64") }],
  };
}

export function unsignedEnvelope(statement: Statement): Envelope {
  return {
    payloadType: PAYLOAD_TYPE,
    payload: Buffer.from(`${JSON.stringify(statement)}\n`).toString("base64"),
    signatures: [],
  };
}

export function verifyEnvelope(envelope: Envelope, publicKeyPem: string): boolean {
  const payload = Buffer.from(envelope.payload, "base64");
  const want = keyId(publicKeyPem);
  return envelope.signatures.some(
    (s) =>
      s.keyid === want && verify(null, pae(envelope.payloadType, payload), publicKeyPem, Buffer.from(s.sig, "base64")),
  );
}

export function generateReceiptKey(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

// FACTORY_RECEIPT_KEY holds the PEM itself or a path to it; unset means the receipt goes out unsigned
// and kaas-verify says UNSIGNED, never VERIFIED.
export function receiptKey(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const raw = env[RECEIPT_KEY_ENV]?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("-----BEGIN")) return raw;
  if (!existsSync(raw)) throw new Error(`${RECEIPT_KEY_ENV} names a file that does not exist`);
  return readFileSync(raw, "utf8");
}

export function decodeStatement(envelope: Envelope): Statement {
  return JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as Statement;
}

// The PR body's section: the verdict, what is not proven, and the envelope a reviewer feeds to kaas-verify.
export function renderReceipt(envelope: Envelope): string {
  const { predicate } = decodeStatement(envelope);
  const v = predicate.verdict;
  const lines = ["## Receipt", ""];
  lines.push(
    envelope.signatures.length
      ? `Signed by key \`${envelope.signatures[0]!.keyid.slice(0, 16)}\`. ${v.proven ? "Proven" : "Not proven"}: ${v.criteria - v.failed} of ${v.criteria} criteria.`
      : `Unsigned (no ${RECEIPT_KEY_ENV} on the runner). ${v.proven ? "Proven" : "Not proven"}: ${v.criteria - v.failed} of ${v.criteria} criteria.`,
  );
  if (v.notProven.length) lines.push("", "### Not proven", "", ...v.notProven.map((n) => `- ${n}`));
  lines.push(
    "",
    "<details><summary>Envelope for kaas-verify</summary>",
    "",
    "```json",
    JSON.stringify(envelope),
    "```",
    "",
    "</details>",
  );
  return lines.join("\n");
}

// A receipt that could not be built still gets its section, so a reviewer never mistakes silence for proof.
export function missingReceipt(reason: string): string {
  return [
    "## Receipt",
    "",
    `No receipt: ${reason.replace(/\s+/g, " ").slice(0, 200)}`,
    "",
    "### Not proven",
    "",
    "- nothing in this run is attested",
  ].join("\n");
}

// Reads the receipt envelope back out of a PR body, for `factory receipt verify --pr`.
export function envelopeFromBody(body: string): Envelope | undefined {
  const m = /## Receipt[\s\S]*?```json\n(.+)\n```/.exec(body);
  return m ? (JSON.parse(m[1]!) as Envelope) : undefined;
}

const RUN_FILES = ["acceptance.json", "holdout.json", "proof.json"] as const;

// What verify left, fixed before any later agent stage can touch the worktree: the commit it checked and
// the sha256 of each run file (null when absent). Kept in runner state, never in the worktree.
export interface RunSeal {
  readonly head: string | null;
  readonly files: Readonly<Record<string, string | null>>;
}

export const sealKey = (repo: string, issue: number): string => `receipt-seal:${repo}#${issue}`;

// A run file's bytes, or undefined when absent. A symlink or directory is refused, so an agent cannot
// point the receipt at a file outside the run dir.
function readRunFile(dir: string, name: string): string | undefined {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(join(dir, name));
  } catch {
    return undefined;
  }
  if (!st.isFile()) throw new Error(`receipt: ${name} is not a regular file`);
  return readFileSync(join(dir, name), "utf8");
}

function readRunFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of RUN_FILES) {
    const body = readRunFile(dir, name);
    if (body !== undefined) files[name] = body;
  }
  return files;
}

// Errors name the ref only: git's stderr can carry host paths, and this text reaches the PR.
async function revParse(exec: ExecutionPort, cwd: string, ref: string): Promise<string> {
  const out = await exec.run(`git rev-parse ${shq(ref)}`, cwd);
  if (out.code !== 0) throw new Error(`receipt: git rev-parse ${ref} failed`);
  return out.stdout.trim();
}

export async function sealRunFiles(exec: ExecutionPort, worktree: string, runDir: string): Promise<RunSeal> {
  const files = readRunFiles(join(worktree, runDir));
  return {
    head: await revParse(exec, worktree, "HEAD").catch(() => null),
    files: Object.fromEntries(RUN_FILES.map((n) => [n, files[n] === undefined ? null : sha256(files[n]!)])),
  };
}

export function readSeal(raw: string | undefined): RunSeal | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as RunSeal;
  } catch {
    return undefined;
  }
}

export interface RunReceiptOptions {
  readonly worktree: string;
  readonly runDir: string;
  readonly repo: string;
  readonly issue: number;
  readonly base: string;
  readonly runs: readonly StageRun[];
  readonly operatorDetail: boolean;
  readonly holdoutRequired: boolean;
  // From sealRunFiles at the end of verify; without one, nothing is signed.
  readonly seal: RunSeal | undefined;
  readonly at?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

// Builds the run's receipt from the files verify sealed, signs it when a key is set, and writes it beside
// them so `kaas-verify --artifacts <run dir>` re-hashes the same bytes. Any drift from the seal refuses.
export async function writeRunReceipt(exec: ExecutionPort, o: RunReceiptOptions): Promise<Envelope> {
  const dir = join(o.worktree, o.runDir);
  if (!o.seal) throw new Error("receipt: verify did not seal this run's files");
  const files = readRunFiles(dir);
  for (const name of RUN_FILES) {
    const now = files[name] === undefined ? null : sha256(files[name]!);
    if (now !== o.seal.files[name]) throw new Error(`receipt: ${name} changed after verify`);
  }
  const headSha = await revParse(exec, o.worktree, "HEAD");
  if (headSha !== o.seal.head) throw new Error("receipt: the head moved after verify");
  const parse = <T>(name: string): T | undefined => {
    if (files[name] === undefined) return undefined;
    try {
      return JSON.parse(files[name]!) as T;
    } catch {
      throw new Error(`receipt: ${name} is not valid JSON`);
    }
  };
  const statement = buildStatement({
    repo: o.repo,
    issue: o.issue,
    baseRef: o.base,
    baseSha: await revParse(exec, o.worktree, `origin/${o.base}`),
    headSha,
    at: o.at ?? new Date().toISOString(),
    acceptance: parse<AcceptanceVerdict>("acceptance.json"),
    holdout: parse<{ ok: boolean }>("holdout.json"),
    holdoutRequired: o.holdoutRequired,
    proof: parse<ProofResult>("proof.json"),
    runs: o.runs,
    files,
    operatorDetail: o.operatorDetail,
  });
  const key = receiptKey(o.env);
  const envelope = key ? signStatement(statement, key) : unsignedEnvelope(statement);
  const out = join(dir, RECEIPT_FILE);
  // Removed first, so a symlink an agent left at this name is replaced, never written through.
  rmSync(out, { force: true });
  writeFileSync(out, `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx" });
  return envelope;
}
