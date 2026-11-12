#!/bin/sh
# Fails when any ast-grep rule in the repo's residue rules dir still matches the tree.
# The dir comes from .factory/config.json ("residue": {"rules": "<dir>"}) or RESIDUE_RULES.
# Prints one line the runner parses: FACTORY_GATES: status=... failed_gates=residue residue=<n>
# Exit code: 0 no residue, 1 residue found, 2 the check could not run.

emit() { # status passed failed failed_gates residue
  echo "FACTORY_GATES: status=$1 passed=$2 failed=$3 skipped=0 failed_gates=$4 residue=$5"
}
stop() { echo "$1" >&2; emit RED 0 1 residue -1; exit 2; }

rules=${RESIDUE_RULES:-}
if [ -z "$rules" ] && [ -f .factory/config.json ] && command -v jq >/dev/null 2>&1; then
  rules=$(jq -r '.residue.rules // empty' .factory/config.json)
fi
[ -n "$rules" ] || stop "residue: no rules dir; set residue.rules in .factory/config.json or RESIDUE_RULES"
[ -d "$rules" ] || stop "residue: rules dir $rules does not exist"

command -v ast-grep >/dev/null 2>&1 || stop "residue: ast-grep is not installed; install it with: npm install --global @ast-grep/cli"

total=0
for rule in "$rules"/*.yml "$rules"/*.yaml; do
  [ -f "$rule" ] || continue
  out=$(ast-grep scan --rule "$rule" --json=stream .) || stop "residue: ast-grep scan failed on $rule"
  n=$(printf '%s\n' "$out" | grep -c .)
  total=$((total + n))
done

if [ "$total" -gt 0 ]; then
  echo "residue: $total old-pattern matches remain" >&2
  emit RED 0 1 residue "$total"
  exit 1
fi
emit GREEN 1 0 - 0
