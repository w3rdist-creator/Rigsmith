"""Verify every protected original against .hermes/dispatch/roadmap/preservation-baseline.json
(SHA-256 and byte size). Read-only. Exit 0 only if all files match.

usage: python3 -I scripts/roadmap/check_preservation.py [baseline.json]
"""
import hashlib
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
baseline = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "..", "..", ".hermes", "dispatch", "roadmap", "preservation-baseline.json")
files = json.load(open(baseline))["files"]
bad = 0
for path, want in files.items():
    try:
        data = open(path, "rb").read()
    except OSError as e:
        print(f"MISSING {path}: {e}")
        bad += 1
        continue
    got = hashlib.sha256(data).hexdigest()
    ok = got == want["sha256"] and len(data) == want["bytes"]
    bad += not ok
    print(f"{'OK     ' if ok else 'CHANGED'} {got[:16]} {len(data):>9} {path}")
print(f"{len(files) - bad}/{len(files)} protected originals unchanged")
sys.exit(1 if bad else 0)
