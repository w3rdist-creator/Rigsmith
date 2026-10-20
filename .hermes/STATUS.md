WO23_R10_STATE: READY_FOR_OPERATOR_REVIEW
Date: 2026-10-20 · Branch: r10-views · Local changes only; no commit/push/checkout.
Phases 1–2 preserved. Views Setup/Animate controls and four visible-control e2e tests implemented.
Fresh gates: unit 373/373, build PASS, CLI 27/27, e2e 225/225; no skipped tests.
Raw output and evidence index: .hermes/evidence/r10-views/README.md.
Mapo authored only through CLI: front-new → 34 at f31 → front-new at f97; 240-frame ZIP,
8-second H.264 MP4, and two swap strips in .hermes/evidence/r10-views/.
Copy commands succeeded to ~/Desktop/STAKE/rigsmith_r10_previews/views_feature/; the harness
blocked post-copy comparison outside the worktree. Operator visual/reference acceptance pending.

---- History: earlier project status (not the current WO-23 gate counts) ----
TERMINAL_STATE: READY_FOR_HERMES_VERIFICATION
Worker: claude-opus-5-5 (Fable review corrections LP-001 … LP-014 on the later priorities; no other agents/models)
This is a worker handoff, not a certification. Status: corrections implemented, awaiting Hermes verification;
product acceptance and the operator decisions below are not the worker's.

Record: docs/REVIEW-CORRECTIONS.md (disposition + evidence per finding, HEAD red check, operator decisions).
Commits: d1a9061 (corrections), e9e50d0 (test-id allow-list for three read-only notices), then the docs commit
with this file. Local only; nothing pushed.
Latest fresh gates (.hermes/evidence/review-corrections/gates-e9e50d0/summary.txt, run 20261018T215414Z-68031,
HEAD e9e50d0, clean tree): preservation 0, unit 256/256, typecheck 0, build 0, e2e 194/194, cli 15/15, wiz 31/31,
testid-audit 0 (368 ids, 92 allow-listed, 0 never interacted with), profiles 0: ALL GATES PASSED.
The run on d1a9061 failed testid-audit only (the three notices were not allow-listed).
Wiz originals: 201/201 hashes OK after the last gate run, identical file set (wiz-assets-sha-check-e9e50d0.txt).
Fixed: LP-001 (override warning + opt-in mix-0 key; default off), LP-002, LP-004 (software-raster exports,
editor x3 = CLI at scale 0.5; mechanism not established), LP-006 … LP-012, paste retarget, RV-008 wording.
Message only: LP-003 (no chunked CLI). Not changed: LP-005 (operator). Carried: LP-013, LP-014, RV-008 bake, RV-011.
LP-001 acceptance (2) did not hold as written (body scale moves the IK target; 4.85 deg range); a substitute
proof (arm_r skipped vs not: 1.1e-13 deg) is recorded. Export bytes changed with LP-004; FR-003 budgets recalibrated.
Preview: not running (no owned vite/Chrome/ffmpeg processes left).

---- History: RV-009/010/012 (superseded by the review corrections above) ----
RV009_012_STATE (historical): READY_FOR_HERMES_VERIFICATION
Worker: claude-opus-5-5 (approved later priorities RV-009, RV-010 → RV-012; no other agents/models)
This is a worker handoff, not a certification. Status: delivered, pending external verification; the
product review belongs to the next Fable stage.

Record: docs/RV-009-010-012-DELIVERY.md (controls, tests, compatibility/undo/recovery, export
validation, the full list of gaps) · RV-010 evidence: docs/RV010-CUTOUT-SHORTFALLS.md
Commits: 58e43fa (RV-009 motion reuse + saved clip sequences), f73ca06 (RV-010 evidence, RV-012
flat-art guide, cut-dialog scroll fix), then the docs commit with this file. Local only; nothing pushed.
Latest fresh gates (.hermes/evidence/roadmap/final-f73ca06/summary.txt, run 20261018T200849Z-13692,
HEAD f73ca06, clean tree): preservation 16/16, unit 240/240, typecheck 0, build 0, e2e 184/184, cli 15/15,
wiz 31/31, testid-audit 0 (363 ids, 89 allow-listed, 0 never interacted with), profiles 0 — all exit 0.
Note: the smoke run before f73ca06 (.hermes/evidence/roadmap/rv012-smoke/) failed testid-audit only.
The guide's btn('guide-…') ids were missed by the static scan; the scan was extended, not the allow-list.
Partial / not met: the cut tools do not meet the pixel tolerance on real art (Wiz: 3 of 9 pieces, both
directly and through the guide); the 10 RV-010 shortfalls are documented and unfixed. The guide is
verified on a synthetic figure (e2e) and on Wiz (evidence script); no person has used it. The starter
idle's sway rule is a heuristic. RV-009: the scale-0.5 export is nondeterministic (byte identity is
claimed at scale 1 only); the Sequences dialog has no skin select; the v3 frame clips greeting-v2 by 21 units.
Preview: not running (no owned vite/Chrome/ffmpeg processes left).

---- History: use-case milestone (superseded by RV-009/010/012 above) ----
USECASE_STATE (historical): READY_FOR_HERMES_VERIFICATION
Worker: claude-opus-5-5 (use-case milestone "Wiz v3, authored through the editor": review RV-001 … RV-008; no other agents/models)
Hermes relays this handoff and adds no product-acceptance stage; this is a worker handoff, not a certification.
State: implemented; gates passed at 251dd79; awaiting Hermes verification. Visual preference, timing and (g) are operator-owned.

Record: docs/WIZ-V3-DELIVERY.md (commits, gates, per-finding results, artifacts, deviations, operator decisions)
Commits: e425d5c (RV-002/004/005/006/007), c9c45dc (RV-003), dd08697 (RV-001/RV-008), 251dd79 (RV-003/RV-007 on Wiz,
mix-frame exercised), then the docs commit with this file. Local only; nothing pushed.
Latest fresh gates (.hermes/evidence/usecase-milestone/gates-251dd79/summary.txt, run 20261018T181350Z-67777,
HEAD 251dd79, clean tree): preservation 16/16, unit 219/219, typecheck 0, build 0, e2e 165/165, cli 14/14,
wiz 31/31, testid-audit 0 (306 ids, 70 allow-listed, 0 never interacted with), profiles 0 — all exit 0.
Wiz originals: all 201 pre-milestone hashes re-checked after the last gate run, same file set (wiz-assets-sha-last-check.txt).
Artifacts (git-ignored): .hermes/assets/wiz/v3-output/ (wiz-v3.rig.json, dialog exports) and v3-output/delivery/ (MANIFEST.json, 21 files).
Partial: RV-008 bake command not implemented (decision record only); v3 Lottie refused (meshes + IK), no mesh support claimed.
Open (operator-owned): RV-011 preference / timing baseline, criterion (g), v3 motion departures, baking, fallback-download UX,
frame default, sleeve-hole sliver / elbow creases / neck blend, the thirty-minute human session; DRW-009 unchanged.
Preview: not running (no owned vite/Chrome/ffmpeg processes left).

---- History: post-review fix pass (superseded by the use-case milestone above) ----
POST_REVIEW_STATE (historical): READY_FOR_HERMES_VERIFICATION
Worker: claude-opus-5-5 (post-review fix pass on the Fable 5.1 findings FR-001 … FR-007; no other agents/models)
Hermes relays this handoff and adds no product-acceptance stage; this is a worker handoff, not a certification.

Record: docs/POST-REVIEW-DELIVERY.md · report: docs/ROADMAP-DELIVERY.md (§1 commits, §2 latest gates)
Commits: cf88452 (FR-001), 3252fcd (FR-007), d303832 (FR-002), cf3e968 (FR-004, FR-006),
ef91c07 (sanitization), 024c427 (FR-003), 2c082f3 (docs), then the docs commit with this file.
Latest fresh gates (.hermes/evidence/post-review/fable-fix/gates/final-2c082f3/summary.txt,
run 20261018T142214Z-79749, HEAD 2c082f3, clean tree):
preservation 16/16, unit 214/214, typecheck 0, build 0, e2e 146/146, cli 13/13, wiz 16/16,
testid-audit 0 (288 ids, 64 allow-listed, 0 never interacted with), profiles 0 — all exit 0.
Open (operator-owned, unchanged): DRW-009 subjective/playback/codec/jointed-Wiz judgements.
Preview: not running (no owned vite/Chrome/ffmpeg processes left).

---- History: roadmap handoff (superseded by the post-review fix pass above) ----
ROADMAP_STATE (historical): READY_FOR_HERMES_VERIFICATION
Worker: claude-opus-5-5 (roadmap builder; no other agents/models)
Scope: approved Fable roadmap, phases 1–4 (contract .hermes/dispatch/roadmap/BUILD-CONTRACT.md)
Hermes verification has NOT been performed; this is a worker handoff, not a certification.

Final report: docs/ROADMAP-DELIVERY.md · matrix: docs/ROADMAP-IMPLEMENTATION.md
Roadmap status: .hermes/dispatch/roadmap/STATUS.md
Commits: 8aef453 (1), efcda86 + 0c07e0a + dfe27bb (2), fdb56e8 (3), ff1916b (4a), 69cc9b4 (4b),
a71e917 (4c), ec57b7e (4d), 10aa08a (4e Lottie), 468a13b (4f media), e4c4180 + final docs commit.
Final fresh gates at the time (.hermes/evidence/roadmap/final-gates/, 2026-10-18T05:59Z, HEAD dfe27bb, clean tree):
preservation 16/16, test-id audit 0 missing of 263, unit 157/157, typecheck 0, build 0,
e2e 132/132, cli 13/13, wiz 16/16 — all exit 0.
Stated limits (report §3–4): optional jointed Wiz v2 not produced; Lottie verified by the
in-repo evaluator only; WebM/MP4 CLI-only via local ffmpeg; no third-party player/platform
playback tests; HEVC-alpha / ProRes 4444 / animated WebP / audio absent.
Preview: not running (no owned vite/Chrome/ffmpeg processes left).

---- History: original vertical-slice handoff (superseded by the roadmap work above) ----
ORIGINAL_SLICE_STATE (historical): READY_FOR_HERMES_VERIFICATION
Worker: claude-opus-5-5
Effort: high
Scope: initial usable independently implemented animation editor ("Rigsmith")

Hermes verification has NOT been performed; this is a worker handoff, not a certification.

## Deliverable
- Delivery report: docs/DELIVERY.md (implemented/partial/absent checklist, commands, results, gaps, residual uncertainty)
- REA record: docs/rea-evidence.md (12 calls, Evidence IDs, blockers); raw bundle .hermes/evidence/rea/rea-evidence-bundle.json (11 records)
- Provenance: docs/provenance.md · Architecture/format: docs/architecture.md · Gates: AGENTS.md · Run/test: README.md
- Preview: NOT RUNNING. The worker's `vite preview` on http://127.0.0.1:47613/ served the final build (verified HTTP 200 for index.html and index-bftQBcAc.js), then was terminated externally (exit 143 / SIGTERM). Restart with `npm run build && npm run preview`.

## Final gate results (2026-10-17/18 UTC, build dist/assets/index-bftQBcAc.js sha256 64586339e4783b57c169948f0b0e6b1bbbbbe7c1fad35f2c5cba8baebf5096fb)
| Gate | Command | Result | Raw output |
|---|---|---|---|
| Model/unit | `npm test` | 43/43 pass, exit 0 | .hermes/evidence/unit-tests.txt |
| Typecheck + build | `npm run typecheck`; `npm run build` | exit 0 / exit 0 | .hermes/evidence/build-typecheck.txt |
| Browser interaction | `npm run test:e2e` (headless CfT 155.0.8059.39, profile .hermes/browser-profiles/e2e) | 19/19 pass, exit 0 (+2 repeat runs 19/19) | .hermes/evidence/e2e-tests.txt, e2e-repeat-runs.txt |
| Regression proof | same suite vs pre-fix build | 1 fail as expected (pause not frame-aligned) | .hermes/evidence/e2e-regression-prefix-fail.txt |
| REA | see docs/rea-evidence.md | passive + static + 4 controlled scenarios (last one, ev_19ca685c…, on the final bundle); compare_web_screenshots / reconcile_javascript_runtime not run (inline payload size) | .hermes/evidence/rea/ |
Screenshots: .hermes/evidence/e2e/*.png, .hermes/evidence/screens/*.png

## Checkpoint log
- REA connected (rea-agents 6.4.0, manifest repository git+https://github.com/morluto/rea.git, build_commit null).
- Model + unit tests green (43/43) before any UI.
- UI built (vanilla TS + Canvas2D), e2e 13/13.
- REA scenarios found 2 a11y label issues + pause/keying bug → fixed, regression test added, re-verified by REA and e2e.
- Space+drag pan removed (conflicted with Space = play).
- Advisor review: added e2e coverage for zoom/pan/fit, Scale tool, key retime, animation rename/delete, drop import, help → 19/19.

## Operator-side items (not blockers for this slice)
- ~/Applications/Google Chrome for Testing.app is a dangling symlink (→ 153.0.8010.52, bundle missing).
- ~/chrome-for-testing/current (155.0.8059.84) is a bash wrapper that execs itself (infinite loop). Worker used the real 155.0.8059.39 Mach-O; install not modified.
- .gitignore gained Wiz-related entries from another process during this run; left intact.
- No Spine trial/installer was downloaded or used.
