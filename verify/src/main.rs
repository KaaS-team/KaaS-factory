// kaas-verify: re-checks a KaaS Factory acceptance receipt offline. It shares no code with the
// engine (src/receipt.ts): it re-derives every criterion's proof, the counts, the verdict and the
// "not proven" list from the rows, so a receipt that claims more than it proves is refused even when
// its signature is good. Exit codes: 0 VERIFIED, 1 TAMPERED, 2 UNCHECKED (no trusted key), 3 UNSIGNED.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::process::ExitCode;

const PAYLOAD_TYPE: &str = "application/vnd.in-toto+json";
const STATEMENT_TYPE: &str = "https://in-toto.io/Statement/v1";
const PREDICATE_TYPE: &str = "https://kaas.team/attestations/acceptance/v1";

struct Tampered(String);

fn tampered<T>(field: &str, why: impl Into<String>) -> Result<T, Tampered> {
    Err(Tampered(format!("{field}: {}", why.into())))
}

fn get<'a>(v: &'a Value, path: &str) -> Result<&'a Value, Tampered> {
    let mut cur = v;
    for key in path.split('.') {
        cur = match cur.get(key) {
            Some(next) => next,
            None => return tampered(path, "missing"),
        };
    }
    Ok(cur)
}

fn text<'a>(v: &'a Value, path: &str) -> Result<&'a str, Tampered> {
    get(v, path)?
        .as_str()
        .map_or_else(|| tampered(path, "not a string"), Ok)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn proof_of(c: &Value) -> Result<&'static str, Tampered> {
    let holdout = c
        .get("holdout")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let head = c.get("head").and_then(Value::as_str).unwrap_or("");
    let is_new = c.get("new").and_then(Value::as_bool).unwrap_or(false);
    let base = c.get("base").and_then(Value::as_str);
    Ok(if holdout == 0 {
        "no-holdout"
    } else if head != "pass" {
        "fails"
    } else if !is_new {
        "holds"
    } else if base == Some("pass") {
        "already-passed"
    } else {
        "fails-before-passes-after"
    })
}

fn check_predicate(p: &Value, artifacts_dir: Option<&str>) -> Result<(), Tampered> {
    let criteria = get(p, "criteria")?
        .as_array()
        .map_or_else(|| tampered("criteria", "not a list"), Ok)?;
    let mut failed = 0u64;
    let mut not_proven: Vec<String> = Vec::new();
    if criteria.is_empty() {
        not_proven.push("no acceptance criteria were found for this change".into());
    }
    for (i, c) in criteria.iter().enumerate() {
        let proof = proof_of(c)?;
        let ok = proof == "fails-before-passes-after" || proof == "holds";
        if c.get("proof").and_then(Value::as_str) != Some(proof) {
            return tampered(
                &format!("criteria[{i}].proof"),
                format!("the rows say {proof}"),
            );
        }
        if c.get("ok").and_then(Value::as_bool) != Some(ok) {
            return tampered(
                &format!("criteria[{i}].ok"),
                format!("{proof} gives ok={ok}"),
            );
        }
        if !ok {
            failed += 1;
            not_proven.push(format!("{}: {proof}", text(c, "id")?));
        }
    }
    let errors = get(p, "verdict.errors")?
        .as_array()
        .map_or_else(|| tampered("verdict.errors", "not a list"), Ok)?;
    for e in errors {
        not_proven.push(format!("acceptance error: {}", e.as_str().unwrap_or("")));
    }
    let holdout_required = get(p, "holdout.required")?.as_bool().unwrap_or(true);
    let holdout_ran = get(p, "holdout.ran")?.as_bool().unwrap_or(false);
    let holdout_failed = get(p, "holdout.ok")?.as_bool() == Some(false);
    if !holdout_ran {
        not_proven.push("holdout tests did not run".into());
    } else if holdout_failed {
        not_proven.push("holdout tests failed".into());
    }
    let holdout_held = if holdout_ran {
        !holdout_failed
    } else {
        !holdout_required
    };
    let mutation = text(p, "mutationProof.status")?;
    if mutation != "bites" {
        not_proven.push(format!("mutation proof: {mutation}"));
    }

    let count = |path: &str| get(p, path).map(|v| v.as_u64());
    if count("verdict.criteria")? != Some(criteria.len() as u64) {
        return tampered(
            "verdict.criteria",
            format!("the receipt lists {} criteria", criteria.len()),
        );
    }
    if count("verdict.failed")? != Some(failed) {
        return tampered(
            "verdict.failed",
            format!("{failed} criteria are not proven"),
        );
    }
    let proven = !criteria.is_empty() && failed == 0 && errors.is_empty() && holdout_held;
    if get(p, "verdict.proven")?.as_bool() != Some(proven) {
        return tampered("verdict.proven", format!("the rows give proven={proven}"));
    }
    let listed: Vec<&str> = get(p, "verdict.notProven")?
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if listed != not_proven.iter().map(String::as_str).collect::<Vec<_>>() {
        return tampered("verdict.notProven", format!("the rows give {not_proven:?}"));
    }

    if let Some(dir) = artifacts_dir {
        let pinned = get(p, "artifacts")?
            .as_object()
            .map_or_else(|| tampered("artifacts", "not an object"), Ok)?;
        for (name, digest) in pinned {
            if name.contains('/') || name.starts_with('.') {
                return tampered(&format!("artifacts.{name}"), "not a plain file name");
            }
            let body = match std::fs::read(format!("{dir}/{name}")) {
                Ok(b) => b,
                Err(e) => {
                    return tampered(&format!("artifacts.{name}"), format!("cannot read it: {e}"))
                }
            };
            if Some(hex(&Sha256::digest(&body)).as_str()) != digest.as_str() {
                return tampered(&format!("artifacts.{name}"), "the file's sha256 differs");
            }
        }
    }
    Ok(())
}

// The signed merge decision must judge this head, and a "merge" carries no refusal reason.
fn check_merge(p: &Value, head: &str) -> Result<(), Tampered> {
    let Some(m) = p.get("merge") else {
        return Ok(());
    };
    if text(m, "headSha")? != head {
        return tampered("merge.headSha", "does not name run.head.sha");
    }
    let reasons = get(m, "reasons")?
        .as_array()
        .map_or_else(|| tampered("merge.reasons", "not a list"), Ok)?;
    if text(m, "outcome")? == "merge" && !reasons.is_empty() {
        return tampered("merge.outcome", "merge with refusal reasons");
    }
    Ok(())
}

fn public_key(pem: &str) -> Result<VerifyingKey, Tampered> {
    let b64: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    let der = B64
        .decode(b64.trim())
        .map_err(|e| Tampered(format!("pubkey: not base64 PEM: {e}")))?;
    // An Ed25519 SPKI is a fixed 12-byte header followed by the 32-byte key.
    if der.len() != 44
        || der[..12]
            != [
                0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
            ]
    {
        return tampered("pubkey", "not an Ed25519 public key");
    }
    let raw: [u8; 32] = der[12..].try_into().expect("44 - 12 is 32");
    VerifyingKey::from_bytes(&raw).map_err(|e| Tampered(format!("pubkey: {e}")))
}

fn pae(payload_type: &str, payload: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "DSSEv1 {} {payload_type} {} ",
        payload_type.len(),
        payload.len()
    )
    .into_bytes();
    out.extend_from_slice(payload);
    out
}

enum Outcome {
    Verified(String),
    Unchecked(String),
    Unsigned(String),
}

fn run(
    envelope_raw: &str,
    pubkey_pem: Option<&str>,
    artifacts_dir: Option<&str>,
) -> Result<Outcome, Tampered> {
    let env: Value = serde_json::from_str(envelope_raw)
        .map_err(|e| Tampered(format!("envelope: not JSON: {e}")))?;
    if text(&env, "payloadType")? != PAYLOAD_TYPE {
        return tampered("payloadType", format!("want {PAYLOAD_TYPE}"));
    }
    let payload = B64
        .decode(text(&env, "payload")?)
        .map_err(|e| Tampered(format!("payload: not base64: {e}")))?;
    let statement: Value = serde_json::from_slice(&payload)
        .map_err(|e| Tampered(format!("payload: not JSON: {e}")))?;
    if text(&statement, "_type")? != STATEMENT_TYPE {
        return tampered("_type", format!("want {STATEMENT_TYPE}"));
    }
    if text(&statement, "predicateType")? != PREDICATE_TYPE {
        return tampered("predicateType", format!("want {PREDICATE_TYPE}"));
    }
    let p = get(&statement, "predicate")?;
    let head = text(p, "run.head.sha")?;
    let subject = statement.get("subject").and_then(|s| s.get(0));
    if subject
        .and_then(|s| s.get("digest"))
        .and_then(|d| d.get("gitCommit"))
        .and_then(Value::as_str)
        != Some(head)
    {
        return tampered("subject[0].digest.gitCommit", "does not name run.head.sha");
    }
    check_predicate(p, artifacts_dir)?;
    check_merge(p, head)?;

    let summary = format!(
        "{}#{} at {} proven={}",
        text(p, "run.repo")?,
        get(p, "run.issue")?,
        &head[..head.len().min(12)],
        get(p, "verdict.proven")?
    );
    let sigs = get(&env, "signatures")?
        .as_array()
        .map_or_else(|| tampered("signatures", "not a list"), Ok)?;
    if sigs.is_empty() {
        return Ok(Outcome::Unsigned(summary));
    }
    let Some(pem) = pubkey_pem else {
        return Ok(Outcome::Unchecked(summary));
    };
    let key = public_key(pem)?;
    let want = hex(&Sha256::digest(key.as_bytes()));
    let message = pae(PAYLOAD_TYPE, &payload);
    for (i, s) in sigs.iter().enumerate() {
        if s.get("keyid").and_then(Value::as_str) != Some(want.as_str()) {
            continue;
        }
        let sig = B64
            .decode(text(s, "sig")?)
            .map_err(|e| Tampered(format!("signatures[{i}].sig: not base64: {e}")))?;
        let sig = Signature::from_slice(&sig)
            .map_err(|e| Tampered(format!("signatures[{i}].sig: {e}")))?;
        return match key.verify(&message, &sig) {
            Ok(()) => Ok(Outcome::Verified(summary)),
            Err(_) => tampered(
                &format!("signatures[{i}].sig"),
                "does not match the payload",
            ),
        };
    }
    tampered("signatures", format!("no signature by key {}", &want[..16]))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut file = None;
    let mut pubkey = None;
    let mut artifacts = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--pubkey" => pubkey = it.next().cloned(),
            "--artifacts" => artifacts = it.next().cloned(),
            "-h" | "--help" => {
                println!("usage: kaas-verify <receipt.dsse.json|-> [--pubkey key.pub] [--artifacts run-dir]");
                return ExitCode::SUCCESS;
            }
            _ => file = Some(a.clone()),
        }
    }
    let Some(file) = file else {
        eprintln!(
            "usage: kaas-verify <receipt.dsse.json|-> [--pubkey key.pub] [--artifacts run-dir]"
        );
        return ExitCode::from(64);
    };
    let read = |path: &str| -> std::io::Result<String> {
        if path == "-" {
            std::io::read_to_string(std::io::stdin())
        } else {
            std::fs::read_to_string(path)
        }
    };
    let (envelope, pem) = match (read(&file), pubkey.as_deref().map(read).transpose()) {
        (Ok(e), Ok(k)) => (e, k),
        (Err(e), _) | (_, Err(e)) => {
            eprintln!("kaas-verify: {e}");
            return ExitCode::from(64);
        }
    };
    match run(&envelope, pem.as_deref(), artifacts.as_deref()) {
        Ok(Outcome::Verified(s)) => {
            println!("VERIFIED  {s}");
            ExitCode::from(0)
        }
        Ok(Outcome::Unchecked(s)) => {
            println!("UNCHECKED  {s}: signed, but no --pubkey to check it against");
            ExitCode::from(2)
        }
        Ok(Outcome::Unsigned(s)) => {
            println!("UNSIGNED  {s}");
            ExitCode::from(3)
        }
        Err(Tampered(why)) => {
            println!("TAMPERED  {why}");
            ExitCode::from(1)
        }
    }
}
