<!-- factory:planned v1 -->
Repo: KaaS-team/KaaS-factory
Blocked by: mc-1 (not filed yet)
Deps: none
Epic: E14 Mission control
Milestone: Phase 7 mission control
Runner: factory

## Risk: high

## Why
Every mission control adapter calls a vendor API with a key and copies vendor text (titles, summaries, errors) into rows that a phone, a share link or a public ledger may show. Three rules must hold before the first adapter lands: a key is read by name and never reaches a URL, an argv, a log line or a row; an outbound call goes only to the host its connection names, over https, with no redirect and no private address; and every string an adapter copies is scrubbed of token shapes. This slice adds the three modules and a structural test that holds every file under `src/mc/` to them.

## Today
- `src/ports/secrets.ts:4` `SecretsPort.get(name)` reads a secret by name; `docs/runtimes.md` (the http protocol) says a token "is read by name when the step runs, so it never appears in `machine.json`, an argv or a log".
- `src/machine.ts:18` `MachineConfig` and `:51` `loadMachineConfig` read `FACTORY_HOME/machine.json` and validate it at boot; it has no `sessions` key.
- `dashboard/ledger-public.ts:28-38` `FORBIDDEN_TEXT` and `scrubText` redact model names, URLs, hosts, token counts and stack frames for the public ledger; nothing redacts credential shapes (bearer values, `ghp_`, `sk-`, JWTs, URL userinfo, `token=` query parameters).
- `src/egress.ts` is the guest-side allow-list proxy; no host-side outbound guard exists, and `src/integrations/otel.ts:108` `exportTrace` calls `fetch` on a configured endpoint with redirects followed.
- Nothing exists under `src/mc/` but what mc-1 adds.

## Change
### T1: Credential redaction
Files: `src/mc/redact.ts`, `tests/mc-redact.test.ts`
Model: sonnet
1. `CREDENTIAL_TEXT: readonly RegExp[]` matches `Bearer <value>`, `Basic <value>`, `gh[pousr]_` and `github_pat_` tokens, `sk-` and `sk-ant-` keys, `AKIA` key ids, `xox[abpr]-` tokens, three-part JWTs starting `eyJ`, URL userinfo (`//user:pass@`), and query parameters named `token`, `access_token`, `key`, `api_key`, `secret`, `sig`, `signature`, `code` and `auth`.
2. `redactText(s, known: readonly string[] = [])` replaces each match and each literal value in `known` (the secrets this process resolved, each at least 8 characters) with `[redacted]`, after NFKC folding as `scrubText` does.
3. `redactRow<T>(row: T, known)` walks a session or event object and applies `redactText` to every string field.
4. Tests: one sample of each shape is redacted inside a longer sentence; a value passed in `known` is redacted wherever it appears; a 40-character commit sha and an issue URL with no query survive unchanged.

### T2: Outbound guard
Files: `src/mc/safe-fetch.ts`, `tests/mc-safe-fetch.test.ts`
Model: opus
1. `safeFetch(url, init, policy: { hosts: readonly string[]; allowPrivate?: boolean; secret?: string; timeoutMs?: number; maxBytes?: number }, deps = { fetch, lookup })` refuses, before any request: a scheme other than `https:` (loopback `http:` only when `allowPrivate`); a host not in `policy.hosts`; URL userinfo; a URL whose text contains `policy.secret`.
2. It resolves the host with `deps.lookup` and refuses loopback, RFC 1918, link-local (including `169.254.169.254`), CGNAT `100.64.0.0/10`, `fc00::/7` and `fe80::/10` addresses unless `allowPrivate`.
3. It sends with `redirect: "manual"` and treats any 3xx as an error, aborts at `timeoutMs` (default 10000), and stops reading the body past `maxBytes` (default 1 MiB).
4. Every error it throws passes its message through `redactText` with `[policy.secret]`.
5. Tests with an injected `fetch` and `lookup`: each refusal case throws before `fetch` is called; a 302 is an error; a body over the cap is an error; a host resolving to `10.0.0.5` is refused; a thrown error never contains the secret.

### T3: Connections in machine.json
Files: `src/mc/connections.ts`, `src/machine.ts`, `tests/mc-connections.test.ts`
Model: sonnet
Deps: T1
1. `machine.json` gains `sessions: { connections: Record<string, Connection> }` where `Connection = { kind: string; tokenEnv?: string; webhookSecretEnv?: string; url?: string; allowPrivate?: boolean; repos?: string[] }`. Hosts and keys belong to the machine, as runtimes do, so no repo or team file holds a connection.
2. `connectionProblems(raw)` returns sentences: a name outside `^[a-z][a-z0-9-]{0,31}$`; a `*Env` value outside `^[A-Z][A-Z0-9_]{1,63}$`; any key named like `token`, `key`, `secret` or `password` that holds a value instead of an env name ("name the environment variable, never the value"); a `url` that is not https (or loopback http with `allowPrivate`).
3. `connectionHashInput(connections)` returns `{name: {kind, url, tokenEnv, webhookSecretEnv, repos}}` so the config hash sees which variable is named, never its value.
4. `src/machine.ts` accepts the `sessions` key and adds `connectionProblems` to its boot problems.
5. Tests: a connection with `"token": "ghp_..."` is refused with the sentence; a lower-case env name is refused; `connectionHashInput` of a connection is identical whether or not its variable is set.

### T4: The structural test
Files: `tests/mc-structure.test.ts`, `tests/mutations/mc-private-addresses-reachable.json`, `tests/mutations/mc-redirects-followed.json`, `tests/mutations/mc-known-secrets-not-redacted.json`
Model: sonnet
Deps: T2
1. Walk every `.ts` file under `src/mc/`. Fail on a bare `fetch(` outside `src/mc/safe-fetch.ts`; on `console.` outside `src/mc/log.ts` (added by mc-8); on `process.env[` or `process.env.` outside `src/mc/connections.ts`; on a template string that puts a variable named like `token`, `key` or `secret` into a URL.
2. Save each entry under Mutation as its own file (`tests/mutations/mc-private-addresses-reachable.json`, `tests/mutations/mc-redirects-followed.json`, `tests/mutations/mc-known-secrets-not-redacted.json`), a single JSON object each. Never edit the old mutations list.

## Tests
- `tests/mc-redact.test.ts`: [permanent] each credential shape and each known value is redacted; ordinary ids survive.
- `tests/mc-safe-fetch.test.ts`: [permanent] scheme, host, userinfo, secret-in-URL, private address, redirect, size and timeout refusals.
- `tests/mc-connections.test.ts`: [permanent] values are refused where names belong; the hash input carries names only.
- `tests/mc-structure.test.ts`: [permanent] no file under `src/mc/` fetches, logs or reads the environment outside its one module.

## Mutation
```json
{"name":"mc: private addresses reachable","file":"src/mc/safe-fetch.ts","find":"if (isPrivate(addr) && !policy.allowPrivate)","replace":"if (false)","test":"tests/mc-safe-fetch.test.ts"}
```
```json
{"name":"mc: redirects followed","file":"src/mc/safe-fetch.ts","find":"redirect: \"manual\"","replace":"redirect: \"follow\"","test":"tests/mc-safe-fetch.test.ts"}
```
```json
{"name":"mc: known secrets not redacted","file":"src/mc/redact.ts","find":"for (const k of known)","replace":"for (const k of [])","test":"tests/mc-redact.test.ts"}
```

## Acceptance
- AC-1: every credential shape and every resolved secret value is redacted from copied text: checked by `make test FILES=tests/mc-redact.test.ts` (T1)
- AC-2: outbound calls reach only the configured https host, never a private address, a redirect target or a URL holding the key: checked by `make test FILES=tests/mc-safe-fetch.test.ts` (T2)
- AC-3: machine.json names secrets by variable only, and the hash input holds names: checked by `make test FILES=tests/mc-connections.test.ts` (T3)
- AC-4: no file under src/mc fetches, logs or reads the environment outside its one module: checked by `make test FILES=tests/mc-structure.test.ts` (T4)

## Non-goals
- NG-1: no vault adapter; `SecretsPort` over the environment stays the only reader.
- NG-2: no change to `dashboard/ledger-public.ts`; its scrubber and leak check stay separate on purpose.
- NG-3: no DNS pinning across the resolve and the connect; the host allow-list per connection is the primary control, the address check the second.

## Files
- `src/mc/redact.ts` (new)
- `src/mc/safe-fetch.ts` (new)
- `src/mc/connections.ts` (new)
- `tests/mc-redact.test.ts` (new)
- `tests/mc-safe-fetch.test.ts` (new)
- `tests/mc-connections.test.ts` (new)
- `tests/mc-structure.test.ts` (new)
- `src/machine.ts` (edit: accept `sessions`, add its problems)
- `tests/mutations/mc-private-addresses-reachable.json` (new)
- `tests/mutations/mc-redirects-followed.json` (new)
- `tests/mutations/mc-known-secrets-not-redacted.json` (new)
