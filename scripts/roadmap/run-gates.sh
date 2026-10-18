#!/bin/sh
# Runs every verification gate fresh and saves raw output + exit codes to
# .hermes/evidence/roadmap/<label>/ (default label: gates-<UTC timestamp>).
# Never runs wiz:build / wiz:capture (they would overwrite the original Wiz output).
cd "$(dirname "$0")/../.." || exit 1
LABEL="${1:-gates-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT=".hermes/evidence/roadmap/$LABEL"
mkdir -p "$OUT"
: > "$OUT/summary.txt"
run() {
  name="$1"; shift
  "$@" > "$OUT/$name.log" 2>&1
  code=$?
  counts=$(grep -E '^ℹ (tests|pass|fail) ' "$OUT/$name.log" | tr '\n' ' ')
  echo "$name exit=$code $counts" | tee -a "$OUT/summary.txt"
}
run preservation python3 -I scripts/roadmap/check_preservation.py
run unit npm test
run typecheck npm run typecheck
run build npm run build
run e2e npm run test:e2e
run wiz npm run test:wiz
echo "saved to $OUT"
