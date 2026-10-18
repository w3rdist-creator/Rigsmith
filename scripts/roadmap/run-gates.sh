#!/bin/sh
# Runs every verification gate fresh and saves raw output + exit codes to
# .hermes/evidence/roadmap/<label>/ (default label: gates-<UTC timestamp>), or to the
# given directory when the argument is an absolute path.
# Exits 0 only if every gate exited 0; otherwise exits 1 and names the failed gates.
# Never runs wiz:build / wiz:capture (they would overwrite the original Wiz output).
#
# Test outputs of this run go to <out>/run-evidence (RIGSMITH_EVIDENCE). The browser
# tests record which data-testid controls they interact with into a cleared
# <out>/testid-interactions tagged with a fresh run id; the test-id audit runs last and
# checks that recording (post-review FR-004). Last, no browser profile may have been
# written under .hermes/evidence/ (FR-006).
cd "$(dirname "$0")/../.." || exit 1
LABEL="${1:-gates-$(date -u +%Y%m%dT%H%M%SZ)}"
case "$LABEL" in
  /*) OUT="$LABEL" ;;
  *) OUT="$(pwd)/.hermes/evidence/roadmap/$LABEL" ;;
esac
mkdir -p "$OUT" || exit 1
: > "$OUT/summary.txt"
RIGSMITH_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RIGSMITH_TESTID_RECORD="$OUT/testid-interactions"
RIGSMITH_EVIDENCE="$OUT/run-evidence"
export RIGSMITH_RUN_ID RIGSMITH_TESTID_RECORD RIGSMITH_EVIDENCE
rm -rf "$RIGSMITH_TESTID_RECORD" || exit 1
mkdir -p "$RIGSMITH_TESTID_RECORD" "$RIGSMITH_EVIDENCE" || exit 1
echo "$RIGSMITH_RUN_ID" > "$RIGSMITH_TESTID_RECORD/run-id"
echo "run $RIGSMITH_RUN_ID" | tee -a "$OUT/summary.txt"
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
run unit npm test
run typecheck npm run typecheck
run build npm run build
run e2e npm run test:e2e
run cli npm run test:cli
run wiz npm run test:wiz
run testid-audit node scripts/roadmap/testid-audit.ts --recorded "$RIGSMITH_TESTID_RECORD"
run profiles node scripts/roadmap/check-profiles.ts
echo "saved to $OUT"
if [ -n "$FAILED" ]; then
  echo "GATES FAILED:$FAILED" | tee -a "$OUT/summary.txt"
  exit 1
fi
echo "ALL GATES PASSED" | tee -a "$OUT/summary.txt"
exit 0
