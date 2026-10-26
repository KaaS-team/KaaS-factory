#!/bin/bash
# Spec 10 (internal-apps/plan) once kept its own verify for factory work and went stale; every
# spec 10 row that names a goal here must run this ledger instead. SPEC10 overrides the path.
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
spec="${SPEC10:-$here/../../../internal-apps/plan/specs/10-goals.json}"
bun -e '
const [spec, ours] = process.argv.slice(1).map((p) => JSON.parse(require("fs").readFileSync(p, "utf8")));
const ids = new Set(ours.goals.map((g) => g.id));
const shared = spec.goals.filter((g) => ids.has(g.id));
const bad = shared.filter((g) => g.verify !== `cd "$FACTORY" && bun scripts/goals.ts --run --ids ${g.id}`);
for (const g of bad) console.error(`spec 10 row ${g.id} does not delegate: ${g.verify}`);
if (shared.length < 6) console.error(`only ${shared.length} spec 10 rows name a factory goal, want 6`);
process.exit(bad.length || shared.length < 6 ? 1 : 0);
' "$spec" "$here/goals.json"
