import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { EXIT, successJson } from "./cli-output";
import type { CliContext } from "./cli-runtime";
import { decodeStatement, type Envelope, generateReceiptKey, keyId, RECEIPT_KEY_ENV, verifyEnvelope } from "./receipt";

// `factory receipt`: the key that signs acceptance receipts, and a quick check of one. The independent check
// is verify/ (kaas-verify), which a reviewer runs with no factory code; see docs/receipts.md.
export async function cmdReceipt(cli: CliContext): Promise<void> {
  const sub = cli.args[1];
  if (sub === "keygen") {
    const out = cli.flag("out");
    if (!out) throw new Error("usage: factory receipt keygen --out <key.pem>");
    if (existsSync(out)) throw new Error(`${out} exists; a new key would orphan every receipt it signed`);
    const { privateKeyPem, publicKeyPem } = generateReceiptKey();
    writeFileSync(out, privateKeyPem, { mode: 0o600 });
    writeFileSync(`${out}.pub`, publicKeyPem);
    if (cli.has("json")) console.log(successJson({ key: out, pub: `${out}.pub`, keyid: keyId(publicKeyPem) }));
    else
      console.log(
        `factory receipt: wrote ${out} (keep it secret) and ${out}.pub (commit it as .factory/receipt.pub)\nset ${RECEIPT_KEY_ENV}=${out} on the runner`,
      );
    return;
  }
  if (sub === "verify" && cli.args[2]) {
    const pub = cli.flag("pubkey");
    if (!pub) throw new Error("usage: factory receipt verify <receipt.dsse.json> --pubkey <key.pub>");
    const envelope = JSON.parse(readFileSync(cli.args[2], "utf8")) as Envelope;
    const ok = verifyEnvelope(envelope, readFileSync(pub, "utf8"));
    const { verdict } = decodeStatement(envelope).predicate;
    if (cli.has("json")) console.log(successJson({ signed: ok, ...verdict }));
    else console.log(`${ok ? "signed" : "NOT SIGNED by this key"}; ${verdict.proven ? "proven" : "not proven"}`);
    if (!ok) process.exit(EXIT.error);
    return;
  }
  console.log(
    "usage: factory receipt (keygen --out <key.pem> | verify <receipt.dsse.json> --pubkey <key.pub>) [--json]",
  );
  if (!cli.has("help")) process.exit(EXIT.error);
}
