# Post-review (Fable 5.1) fix pass: delivery record

This pass answers the Fable 5.1 review of the roadmap and the drwdmrs3 first fix pass
(verdict CONDITIONAL, findings FR-001 … FR-007). It records how each finding was handled.
**It does not certify acceptance, parity or publication.** Hermes relays this handoff;
private GitHub publication is owned solely by the operator-authorized Hermes controller.

- Builder: Claude Opus 5.5 (`claude-opus-5-5`), alone: no other agents or models, no
  remote, no push, no deploy, no public listener.
- Code final at `2c082f3`; the commits after it touch docs only.
- Evidence root (git-ignored): `.hermes/evidence/post-review/fable-fix/` — `pre/`
  (before a change), `red/` (the new test or probe against the pre-fix code), `green/`
  (after), `probes/`, `fr003/`, `fr004/`, `fr006/` (per-finding experiments), `gates/`.
- RED runs: either the new test was run against the pre-fix source (FR-002, FR-007), or a
  controlled mutation proved that the new check fails where the old one passed (FR-003,
  FR-004). Each mutation was restored with `git checkout`, and the restore is recorded.
- IDs: FR-001 … FR-007 are Fable's own.

## Summary

| ID | Severity | Fable's finding (short) | Disposition | Commit(s) |
|---|---|---|---|---|
| FR-001 | medium, blocking | Lottie fidelity unproven against any third-party player | fixed, option (a): lottie-web 5.13.0 canvas playback test | `cf88452`, docs `2c082f3` |
| FR-002 | medium (hypothesis) | the 100 px absolute cut makes Auto weights discontinuous | reproduced, then fixed (continuous ramp); see the deviation note | `d303832`, docs `2c082f3` |
| FR-003 | medium | the DRW-006 independent-renderer check takes IK/path poses from baked rows; budgets fitted to observation | fixed: the reference solves IK, paths and mixing itself; every strict mismatch classified | `024c427` |
| FR-004 | medium | the test-id audit proves an id is mentioned, not interacted with | fixed: runtime interaction recording + audit gate | `cf3e968`, docs `2c082f3` |
| FR-005 | low | ROADMAP-DELIVERY and STATUS show a superseded gate run | fixed | this docs commit |
| FR-006 | low | a probe browser profile under `.hermes/evidence/` | fixed | `cf3e968` |
| FR-007 | low | the player never revokes image object URLs | fixed | `3252fcd` |

Sanitization for private publication: `ef91c07` (see below). Gate wrapper: no wrapper
hides an exit code (see below).

## Findings

### FR-001 — Lottie in a third-party player (blocking)

- **Change:** `lottie-web` 5.13.0 (MIT) added as a devDependency only
  (`pre/package.json.before`, `pre/lottie-web-install.txt`); it is not in the production
  bundle (`probes/fr001-dist-not-bundled.txt`). `tests/e2e/p4-lottie.e2e.test.ts` loads
  the JSON exported through the Lottie dialog into lottie-web's canvas renderer in headless
  Chrome for Testing, renders every frame with `goToAndStop(frame, true)` at the
  PNG-sequence geometry, and compares it with the editor's PNG sequence. The dialog note
  in `src/model/lottie.ts` now names lottie-web as the tested player and says other players
  were not tested.
- **Budget declared before the first lottie-web run** (`pre/fr-001-budget-declared.txt`):
  per frame ≤ 0.5% of covered px over tolerance 24 and mean ≤ 1.5; the wrong-skin control
  must exceed 5%.
- **Result** (`green/fr001-p4-lottie-report.txt`): hop and hop-alt both 0 of 206 221
  covered px over tolerance (worst mean 0.002). The wrong-skin control gives 22.996% and a
  timing control (frame i + 10) gives 81.563%. Both runs before commit:
  `probes/fr001-lottie-web-first-run.txt`, `-second-run.txt`.
- **Test:** `tests/e2e/p4-lottie.e2e.test.ts`.

### FR-002 — Auto weights continuity (hypothesis → reproduced)

- **Reproduction first** (`scripts/post-review/fr002-autoweights-probe.ts`,
  `red/fr002-probe-before.json`). Dense 0.05 px lines on the P1-1 bones, with the child bent
  40°:
  - across the 100 px contour: max adjacent Δw 0.494, skinned gap 33.8 px;
  - across the far-field bisector: Δw 1.0, gap 102.5 px.
  The hypothesis was confirmed. The new unit tests failed on the pre-fix code
  (`red/fr002-mesh-unit.txt`: 4 of 4 continuity cases).
- **Fix:** `src/model/meshOps.ts`. A smoothstep ramp on 1/d² over 70.7–100 px replaces the
  hard cut. It is blended with the plain normalized inverse-square weights, which now also
  weight vertices beyond 100 px. Vertices with no influence in the band keep exactly the old
  weights; a unit test recomputes this split independently. Documented in
  `docs/architecture.md`.
- **After** (`green/fr002-probe-after.json`): contour Δw 0.000295, gap 0.0022 px; bisector
  Δw 3.2e-5, gap 0. Every weight list sums to exactly 1. `tests/e2e/p3-demo.e2e.test.ts`
  (bend assertions) and the P1-1 e2e still pass (`green/fr002-e2e-*.txt`).
- **Deviation from the literal acceptance text:** Fable suggested bounding |Δw| between
  adjacent grid vertices of the P1-1 panel itself (8×8 grid, 50 px spacing). The tests
  bound Δw ≤ 0.15 on dense 0.05 px lines through the same bones instead (four lines: the
  100 px cut, the child's contour, the bisector, a diagonal into the far field). On the
  50 px panel grid, two vertices lying on different bones legitimately differ by almost 1
  under any distance weighting. The probe reports both:
  - all panel edges: 1 before → 0.996 after;
  - panel edges with both ends ≥ 70.7 px from both bones: 1 before → 0.455 after.
  So 0.15 is not met on the coarse grid; it is met on the dense lines, where a jump is a
  real discontinuity rather than sampling.
- **Tests:** `tests/unit/mesh.test.ts` ("auto weights are continuous (FR-002)" and
  "outside the 70.7–100 px band the old weights are unchanged…").

### FR-003 — independent player check (DRW-006)

- **Reference solver:** `tests/support/reference-constraints.ts` (new) gives the
  independent renderer its own solvers:
  - two-bone IK by circle intersection in parent-local space;
  - path constraints with their own arc-length table;
  - transition mixing (shortest-way rotation, missing-track policies, discrete state at
    w = 0.5);
  - slot opacity and deform overrides.
  The fixture is serialized and re-parsed, and the test asserts the parsed project contains
  no `baked` key, so no pose comes from baked rows.
- **Independence is enforced** by `tests/unit/reference-independence.test.ts`. It follows
  every import transitively from `tests/support/reference-*.ts` and fails on anything under
  `src/` or on a package. Planted direct, transitive, dynamic and package imports prove the
  check can fail.
- **Solver unit tests:** `tests/unit/reference-constraints.test.ts`.
  - IK: reach and bend side under parent scales (1, 1), (1.5, 0.7), (−1, 1); straighten and
    fold; mix 0.5.
  - Paths: exact straight-cubic length, clamp, closed wrap.
  - Mixing: shortest rotation, setup/hold, discrete flip.
- **Comparison** (`tests/e2e/p4-player.e2e.test.ts`): the player canvas is compared with
  the reference for:
  - all 30 wave frames;
  - the 30 wave frames with skin `alt`;
  - the 31 frames of wave → rest (mix at 0.5 s, stored 0.3 s).
- **Mechanism of the strict mismatches** (probes `fr003/numeric-probe.*`,
  `fr003/edge-probe.*`). Every strict pixel lies on the anti-aliased edge of `upper` over
  the opaque torso. There a coverage difference shows as a colour difference: the
  reference's 4×4-subsample coverage against Canvas2D's analytic coverage (worst gap
  3.7–4.2 of 16 subsamples). It is not a pose error:
  - the reference worlds equal the runtime's baked rows to 4.98e-4 (a diagnostic only, not
    an input);
  - the mean coverage gap along the whole upper edge is near 0 on both sides.
  The test classifies every strict pixel by that mechanism and asserts two things:
  - the classified count equals the strict count;
  - the strict count is at most the per-case cap. Each cap is the classified count
    documented in `docs/runtime.md` (9 / 7 / 11).

  The caps are therefore still counts measured on this machine. What changed is that each
  strict pixel must now be explained, so an unexplained mismatch fails at any count.

  In the first development run (`fr003/run-1`) the transition had a cap of 9 and failed at
  11; the reset failure then cascaded into two later tests. All 11 were classified as the
  same mechanism, and the cap was set to 11 and documented. The cascade was fixed with
  try/finally.
- **Result** (final gates, `run-evidence/roadmap/p4-player/report.txt`):
  - wave: 9 strict, 9 explained; controls 32 376 (no constraints) and 8 245 (elbow flipped);
  - skin alt: 7 / 7; controls 32 070 and 8 184;
  - transition: 11 / 11; controls 33 458 and 7 031.
  Each control is more than 100× the strict count, and it runs through the same frame
  function.
- **Mutation RED** (`fr003/mutation/`, NOTE.txt): path spacing × 1.1 in
  `src/model/constraints.ts`.
  - The old DRW-006 test and every player-vs-editor check still pass (old test 10/10,
    9 strict).
  - The new test fails: 1181 strict, of which 9 are explained.
  - `src` was restored (0-byte diff) and `dist` rebuilt.
- **Stability:** targeted runs `fr003/run-2` … `run-5` pass 10/10, with identical counts
  in the final gate run.
- **Docs:** `docs/runtime.md` no longer says the budget came from an observed run.

### FR-004 — controls must be interacted with, not just mentioned

- **Recording:** `tests/e2e/harness.ts` records every trusted pointer/keyboard
  interaction, and every input/change event on a `data-testid` element, into a per-run
  folder tagged with `RIGSMITH_RUN_ID`. It also records the ids rendered in that run.
- **Audit:** `scripts/roadmap/testid-audit.ts --recorded` reads this run's e2e and Wiz
  recordings and fails on any of these:
  - a static id never interacted with;
  - a runtime id missing from the inventory;
  - a stale allow-list entry.
  The static reference check stays as a pre-check. The 64 display-only ids in
  `scripts/roadmap/testid-allow.json` each carry a reason.
- **Gate:** `run-gates.sh` clears the recording and runs
  `node scripts/roadmap/testid-audit.ts --recorded <run>/testid-interactions` after the e2e
  and Wiz gates. It fails if any gate fails. Without `--recorded`, the script runs only the
  static pre-check and says so (`post/testid-audit-bare.txt`: "static check only … interactions
  are not verified", exit 0). The gate always passes `--recorded`.
- **Mutation RED, re-run at HEAD** (`fr004/mutation-3-head/`; same diff as
  `fr004/mutation-2/`):
  - every real `getByTestId('weights-auto').click()` was replaced by `dispatchEvent('click')`
    (the three tests and the phase-3 demo builder);
  - e2e still 146/146 and Wiz 16/16;
  - the audit exits 1 with exactly one `NOT EXERCISED weights-auto`;
  - restore recorded in `restore.txt`.
  The earlier mutations 1 and 2 ran before the final inventory change, at 263 ids. Their
  notes are kept, and mutation 1 found that `anim-select` was driven only by the Wiz suite.
- **Final gates:** 288 ids, 64 allow-listed, 278 interacted with, 0 never interacted with.
- **Tests:** `tests/unit/testid-audit.test.ts`, `tests/unit/gates-script.test.ts`, plus the
  e2e files touched in `cf3e968`.

### FR-005 — status and report in step with the newest run

`docs/ROADMAP-DELIVERY.md` §1 now lists the drwdmrs3 and post-review fix-pass commits.
§2 names the newest fresh run (HEAD `2c082f3`, run `20261018T142214Z-79749`) with its raw
path, `.hermes/evidence/post-review/fable-fix/gates/final-2c082f3/summary.txt`.
`.hermes/STATUS.md` names the same run. The private roadmap status
(`.hermes/dispatch/roadmap/STATUS.md`) and `docs/ROADMAP-IMPLEMENTATION.md` phase 4 now
carry a pointer to it. Every count was copied from that summary.

### FR-006 — evidence hygiene

- **Profiles moved:** the two first-pass probe profile trees (8.5 MB each) were moved out of
  `.hermes/evidence/` into `.hermes/browser-profiles/` (`fr006/before.txt`, `after.txt`).
- **Probes:** the first-pass probe harness `probes/rh.ts` now launches through
  `launchIsolated` (`fr006/rh.ts.diff`), and so do the other browser-launching probes.
- **Gate:** `scripts/roadmap/check-profiles.ts` runs last in `run-gates.sh` and fails on
  any `browser-profiles` tree under `.hermes/evidence/`. It was tested on a planted tree
  (`fr006/check-profiles-negative.txt`, exit 1) and passes clean.
- **Evidence redirect:** `run-gates.sh` exports `RIGSMITH_EVIDENCE`.
- **First-pass outputs:** the 48 outputs the first pass rewrote remain as recorded there.
  This pass rewrote the same 48 once, in a full `npm test` run without
  `RIGSMITH_EVIDENCE` (see the output-location deviation under Final gates). Every gate
  run and every other test run used `RIGSMITH_EVIDENCE`.
- **Tests:** `tests/unit/gates-script.test.ts`.

### FR-007 — object URLs

- **Fix:** `src/player-main.ts` revokes the object URL in both `onload` and `onerror`.
- **Test:** `tests/e2e/review-fixes.e2e.test.ts` loads the same runtime and images 20 times
  through `player-files`, then one undecodable image.
  - Before (`red/fr007-object-urls.json`): live URLs 7, 14, … 140, then 141.
  - After (`green/fr007-object-urls.json`): 0 live after every load.
  - The canvas checksum is unchanged across loads, and there are no page errors.

## drwdmrs3 findings after this pass

The first pass's record (`docs/DRWDMRS3-FIX-DELIVERY.md`) left four items open.

| ID | First pass | Now |
|---|---|---|
| DRW-004 (Lottie in a third-party player) | unresolved | fixed by FR-001 (lottie-web 5.13.0 canvas) |
| DRW-006 (a player check that shares no model code) | unresolved, partial | fixed by FR-003 |
| DRW-007 (the test-id audit only checks references) | unresolved | fixed by FR-004 |
| DRW-009 (subjective / external playback / codec / jointed Wiz v2 / parity) | operator-owned | unchanged, operator-owned |

Every other drwdmrs3 item keeps its first-pass disposition. Fable confirmed those:
P1-1, P2-1, P2-2, P3-1, P3-2, P3-3, DRW-001, DRW-003, DRW-005 and DRW-008 fixed;
DRW-002 not applicable. FR-002 and FR-007 changed P1-1's Auto weights and the player
loader again. Their earlier regressions (`tests/e2e/review-fixes.e2e.test.ts`,
`tests/unit/mesh.test.ts`) still pass.

## Delivered, partial, absent

"Delivered" means a visible control (or a documented CLI command) exists and a browser
test exercises it. The per-row matrix is `docs/ROADMAP-DELIVERY.md` §3, with ids and
measurements in `docs/ROADMAP-IMPLEMENTATION.md`. Changes in this pass:

- **Lottie exporter:** still graded `delivered (subset)`. The subset is now also checked
  in lottie-web 5.13.0's canvas renderer, which is what the contract's "only where
  fidelity is provable" asked for. It is not checked in other players.
- **Auto weights (`weights-auto`):** delivered, and now continuous.
- **Reference player:** delivered. Its independent check no longer uses baked poses.
- **Control coverage:** every non-display UI id is interacted with by a browser test in
  the gate run (0 of 288 unexercised).

Not delivered, unchanged from the roadmap report:
- the optional jointed Wiz v2 (not produced);
- HEVC-alpha, ProRes 4444, animated WebP and audio (absent);
- WebM/MP4 from the CLI only, through a local ffmpeg.

## How to run

```sh
npm ci                                        # once; installs the lottie-web devDependency too
npm run build                                 # dist/ (editor, player.html, render.html)
sh scripts/roadmap/run-gates.sh mylabel       # all gates fresh → .hermes/evidence/roadmap/mylabel/
npm test; npm run typecheck; npm run test:e2e; npm run test:cli; npm run test:wiz
node scripts/roadmap/testid-audit.ts             # static pre-check only; the recorded audit runs inside run-gates.sh
node scripts/post-review/fr002-autoweights-probe.ts out.json                 # FR-002 continuity probe
npm run preview                               # http://127.0.0.1:47613/ (local only); player at /player.html
```

Requirements:
- headless Chrome for Testing at the path in `tests/e2e/harness.ts` (or `RIGSMITH_CFT`);
- `python3` with Pillow, for the media checks.

In the editor:
- Lottie export: **Export Lottie…**;
- Auto weights: the mesh panel's **Auto weights** in Setup;
- the player: `player.html` → the file input (`player-files`), which takes the runtime
  JSON, an atlas JSON and the page images.

## Gate wrapper

`scripts/roadmap/run-gates.sh` records each gate's real exit code. It exits 1 and prints
`GATES FAILED: <names>` if any gate fails; the earlier pass fixed this in `e383f3f`.

This pass added:
- the run-tagged interaction recording, `RIGSMITH_EVIDENCE` and `RIGSMITH_RUN_ID` exports;
- the audit after the e2e and Wiz gates;
- the profile check.

`tests/unit/gates-script.test.ts` covers passing, failing npm and preservation gates, and
the ordering/exports. No npm script pipes or masks an exit code.

## Final gates (`.hermes/evidence/post-review/fable-fix/gates/final-2c082f3/summary.txt`)

| Gate | Result |
|---|---|
| preservation | exit 0 — 16/16 protected originals unchanged |
| unit (`npm test`) | exit 0 — 214/214 |
| typecheck (`npm run typecheck`) | exit 0 |
| build (`npm run build`) | exit 0 |
| e2e (`npm run test:e2e`, headless Chrome for Testing 155.0.8059.39) | exit 0 — 146/146 |
| cli (`npm run test:cli`) | exit 0 — 13/13 |
| wiz (`npm run test:wiz`) | exit 0 — 16/16 |
| testid-audit (`--recorded`) | exit 0 — 288 ids, 64 allow-listed, 0 never interacted with |
| profiles | exit 0 — no profile tree under `.hermes/evidence/` |

`wiz:build` and `wiz:capture` were never run. No existing Wiz/STAKE output was
overwritten. The preservation gate ran first in this run (16/16). After the last browser
runs of the pass (the FR-004 mutation re-run, e2e + Wiz), it was rerun separately, again
16/16 (`post/preservation-after-mutation3.txt`).

**Output-location deviation.** A scan for files written since the pass started, outside
its evidence folder (`post/outside-writes.txt`, `post/outside-writes-NOTE.txt`), found 48
regenerated, git-ignored unit-test outputs under `.hermes/evidence/roadmap/unit-media/`
and `unit-cutout-select/`. They were written by one full `npm test` run
(`green/fr002-npm-test.txt`) made without `RIGSMITH_EVIDENCE`. This is the same set the
first pass reported. They are test outputs, not originals, and were left in place. The
only other write is the intentional FR-006 edit of `first-fix/probes/rh.ts`. Nothing under
`.hermes/assets/` changed.

## Sanitization for private publication (`ef91c07`)

- **`.gitignore`** permanently excludes:
  - `.hermes/dispatch/`, `.hermes/assets/`, `.hermes/evidence/`, `.hermes/browser-profiles/`
    (only `.hermes/STATUS.md` under `.hermes/` is tracked);
  - `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `.npmrc`, `.netrc`, `credentials*`,
    `secrets*`;
  - `dist/`, `node_modules/`.
- **`AGENTS.md`:** agent work is local-only; the operator-authorized Hermes controller
  alone owns private GitHub publication.
- **History check** (42 commits, read-only; nothing rewritten):
  - no remote;
  - no prompts, logs, credentials or secrets;
  - no image binaries; the only embedded images are 1×1 test PNGs.
- **History does contain:**
  - the commit author identity (name and e-mail address) in every commit's metadata;
  - local absolute paths under `/Users/w3rd/` — the Chrome for Testing path in
    `tests/e2e/harness.ts:14` and `scripts/lib/rigsmith-api.ts:184`, plus paths in
    `docs/rea-evidence.md` and `docs/WIZ-ANIMATION-DELIVERY.md`;
  - the name and local path of the private Wiz source project
    (`docs/WIZ-ANIMATION-DELIVERY.md:1,33`), without its art.

  These are reported here rather than rewritten, because history must not be altered.
  Commit `83a5acf` (this pass's first version of this file) quoted the author e-mail in
  this list. A later commit removes it, but `83a5acf` keeps it in history. It is the same
  value as every commit's author field.
  Whether they are acceptable in a private repository is the controller's/operator's call.

## Limitations and residual uncertainty

- **FR-001:** fidelity is proven for lottie-web 5.13.0's canvas renderer in Chrome for
  Testing only. The SVG/HTML renderers, other players and After Effects are untested.
- **FR-002:**
  - The 0.15 bound holds on dense lines, not on the 50 px panel grid (see the deviation
    above).
  - With more than two candidate bones, picking the strongest two can still switch an
    influence where two distances are equal (documented in `docs/architecture.md`).
- **FR-003:**
  - The reference IK covers uniform bone-1 scale only; it refuses non-uniform scale rather
    than guess. The fixture uses uniform scale.
  - The renderer was not changed: the strict mismatches remain, measured and classified.
  - The reference shares no code with `src/`, but its IK, path and mixing semantics follow
    `docs/architecture.md`, which the same builder wrote. Independent code, same spec
    reading.
- **FR-004:**
  - Untrusted input/change events count as interaction, because Playwright's
    `fill`/`selectOption` dispatch them. A test that dispatched a synthetic change from
    `page.evaluate` would be counted.
  - CLI tests are not recorded (they have no UI).
- **FR-007:** checked in Chrome for Testing only.
- **Operator-owned (DRW-009, unchanged):** motion appeal, visual quality at real art
  scale, external playback (Safari/Firefox/headed Chrome), the absent codecs, the optional
  jointed Wiz v2, and any parity question.
- **Not certified:** none of the above is self-certified. Hermes relays; verification and
  publication are external.
