#!/bin/sh
# Runs every verification gate fresh and saves raw output + exit codes to
# .hermes/evidence/roadmap/<label>/ (default label: gates-<UTC timestamp>), or to the
# given directory when the argument is an absolute path.
# Exits 0 only if every gate exited 0; otherwise exits 1 and names the failed gates.
# Never runs wiz:build / wiz:capture (they would overwrite the original Wiz output).
cd "$(dirname "$0")/../.." || exit 1
LABEL="${1:-gates-$(date -u +%Y%m%dT%H%M%SZ)}"
case "$LABEL" in
  /*) OUT="$LABEL" ;;
  *) OUT=".hermes/evidence/roadmap/$LABEL" ;;
esac
mkdir -p "$OUT" || exit 1
: > "$OUT/summary.txt"
FAILED=""
run() {
  name="$1"; shift
  "$@" > "$OUT/$name.log" 2>&1
  code=$?
  [ "$code" -eq 0 ] || FAILED="$FAILED $name"
  counts=$(grep -E '^ℹ (tests|pass|fail|skipped|cancelled) ' "$OUT/$name.log" | tr '\n' ' ')
  echo "$name exit=$code $counts" | tee -a "$OUT/summary.txt"
}
run preservation python3 -I scripts/roadmap/check_preservation.py
run testid-audit node scripts/roadmap/testid-audit.ts
run unit npm test
run typecheck npm run typecheck
run build npm run build
run e2e npm run test:e2e
run cli npm run test:cli
run wiz npm run test:wiz
echo "saved to $OUT"
if [ -n "$FAILED" ]; then
  echo "GATES FAILED:$FAILED" | tee -a "$OUT/summary.txt"
  exit 1
fi
echo "ALL GATES PASSED" | tee -a "$OUT/summary.txt"
exit 0
