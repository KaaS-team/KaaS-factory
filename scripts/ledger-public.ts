// Writes the public ledger (dashboard/ledger-public.ts) for every repo with a state DB, or the --repo
// ones, and refuses to write when any field could leak operator detail.
//   bun scripts/ledger-public.ts [--repo owner/name]... [--out shipped.json]

import { writeFileSync } from "node:fs";
import { publicLeaks, publicLedger } from "../dashboard/ledger-public";
import { defaultStatePath, discoverRepos } from "../src/paths";
import { FactoryState } from "../src/state";

const args = process.argv.slice(2);
const values = (flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]!] : []));
const repos = values("--repo").length ? values("--repo") : discoverRepos();
const states = repos.map((r) => new FactoryState(defaultStatePath(process.env, r)));
const ledger = publicLedger(states);
const leaks = publicLeaks(ledger);
if (leaks.length) {
  console.error(`ledger-public: refusing to write, ${leaks.length} leaks:\n${leaks.map((l) => `  ${l}`).join("\n")}`);
  process.exit(1);
}
const json = `${JSON.stringify(ledger, null, 2)}\n`;
const out = values("--out")[0];
if (out) writeFileSync(out, json);
else process.stdout.write(json);
