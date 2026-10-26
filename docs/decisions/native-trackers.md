# Native tracker adapters

Tracker API v1 needed a bridge per tracker, which no team would run. The five most asked-for trackers
are adapters under `src/adapters/trackers/`, each implementing the same `TrackerPort` as GitHub.

- **One kit, no SDKs.** `kit.ts` holds the HTTP client, the body codec and the id map. A vendor SDK per
  tracker would add five dependency trees for a few routes each.
- **The token is read per call** from the env var `tokenEnv` names, so it never sits in config, an argv
  or a log, and errors name the path but never the query or more than 200 characters of a reply.
- **Markers survive editors that strip HTML comments.** The runner keeps state in `<!-- factory -->`
  markers; the codec adds a `factory-data:` footer line and restores them on read.
- **Numbers, not strings.** The port speaks numeric issue and comment ids. Keys like `ENG-42` give their
  number; ClickUp ids are read as base 36; anything past a safe integer is refused rather than rounded,
  and vendor-wide UUIDs go through a 48-bit hash map that refills itself after a restart.
- **Fail closed on trust.** A label counts only when the history names who added it under that name;
  a rename names no one, and ClickUp, with no history API, needs an explicit `labelTrust`.
- **One contract.** `tests/ports/tracker.contract.ts` runs against every adapter's fixture, and
  `tests/adapters.test.ts` fails when an adapter has no contract run.
