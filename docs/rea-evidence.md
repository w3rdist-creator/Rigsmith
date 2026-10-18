# REA evidence

REA = `rea-agents` **6.4.0**, MCP server at `/Users/w3rd/.local/bin/rea mcp`
(supplied via `.hermes/dispatch/mcp.json`). Upstream identity was checked against
the installed package manifest `/Users/w3rd/.local/lib/node_modules/rea-agents/package.json`:
`"repository": {"url": "git+https://github.com/morluto/rea.git"}`,
`"homepage": "https://github.com/morluto/rea#readme"`, license MIT. `binary_session`
reported `server_identity.package = rea-agents 6.4.0`, `build_commit: null` (so the
exact upstream commit is **unknown**; only the package version and manifest repository
are verified).

Raw records: `.hermes/evidence/rea/rea-evidence-bundle.json` (written by REA's own
`export_evidence_bundle`; final export 11 records, 0 unknowns). The
`binary_session` status output is not an Evidence record and no copy is retained in the
project (copying its spill file was refused by client policy; see "Blockers").
Evidence files are git-ignored.

Scope: REA was used only on **our own** editor — its built `dist/` artifact and the
running page in an isolated Chrome for Testing. No Spine binary, installer or trial was
downloaded, opened, inventoried or analysed (not needed for this slice).

## Calls and results

| # | Tool | Mode | Target | Evidence ID | Result |
|---|------|------|--------|-------------|--------|
| 1 | `binary_session` | status | — | (not an Evidence record) | Server identity rea-agents 6.4.0; browser-provider tools (`list_browser_targets`, `inspect_web_page`, `capture_web_screenshot`, `observe_web_session`, `analyze_web_bundle`, `capture_browser_scenario`) and `analyze_javascript_application` listed with no missing client requirements. |
| 2 | `list_browser_targets` | passive | CDP `http://127.0.0.1:47631` (headless CfT 155.0.8059.39, profile `.hermes/browser-profiles/rea`) | `ev_5cf74869a0017536fdb433c0ca750276a962ddfc2a3894e7dcd5e17ab890837e` | One page target `169A5D92…` titled "Tock the tin courier (demo) — Rigsmith" at `http://127.0.0.1:47613/?demo=1`. |
| 3 | `capture_web_screenshot` | passive | same page | `ev_bdf6e1c80e489d0e60e10bd1bd0f9a0375fa980c94da7226bc1e2793f2f399f7` | PNG sha256 `9556b25d…588abc`, captured 00:33:17.762Z, viewport 1440×700. |
| 4 | `capture_web_screenshot` | passive | same page, 2.5 s later | `ev_f1079e057ae83cf9883be3f409a37bd1e53fa6415f4e0a4b9f0b7b905b940396` | PNG sha256 `3f3f2070…cf4e32`, captured 00:33:20.300Z. **Different digest from #3 while nobody interacted with the page** → the demo loop visibly changes the rendered pixels over time (observation; which pixels changed was not measured by REA — see limitation). |
| 5 | `inspect_web_page` | passive, 1.5 s window, a11y + console + storage keys | same page | `ev_16cba311181e082f8221b848ec737d665c21120e4fa486b442d10c46b5fc5049` | Accessibility tree contained a button named **"Pause"** (transport in playing state), regions "Timeline", "Bone hierarchy", the canvas label. Console events in window: **0**. Storage: no localStorage/sessionStorage/IndexedDB keys. Completeness `policy_filtered` + `attach_limited` (prior activity unavailable). |
| 6 | `analyze_javascript_application` | static, `detail: summary` | `/Users/w3rd/Code/rig-animation-editor/dist` (dir sha256 `d6526d7a…ef81e`) | view `ev_b74f940f67d2c686a7426cdcdaa024428d1c569f57513c48eeafb62ee5fef057`, parent `ev_2f4ad21cb0a208856b3c89ec4e86abb0a1146c1fd541141c897aa4a618591cea` | 2 relevant files, 1 JS parsed, 24,785 AST nodes, 0 parse failures, 0 Electron/IPC surfaces, 1 request-family relation; application coverage complete, semantic coverage partial/unknown (5,010 semantic unknowns — REA's conservative graph, not defects). |
| 7 | `analyze_web_bundle` | passive capture + static parse, script sources on, source maps off | running page | `ev_e5c6d7be387b35c60189692ebfddf483b5330fb6f8dba939c95d2486ffe6d178` | Exactly 1 script observed: `/assets/index-C7ix3IWp.js`, sha256 `4642d205d483fa9bf8e959cba1cba162ab5b2afa1a3c50de099b19a35c44cfcd`, 74,158 B. **0 routes, 0 endpoints, 0 WebMCP declarations.** Local `shasum -a 256 dist/assets/index-C7ix3IWp.js` gave the identical digest → the page ran exactly the built artifact (digest reconciliation done by hand, see limitation). |
| 8 | `capture_browser_scenario` | **controlled** (REA launched CfT with its own temp profile, `reduced_motion: no-preference`) | `http://127.0.0.1:47613/` | `ev_678b60d6a7a98b49b009390df02e54797796a80ef5fe4478bb69a2e48a95a9da` | 9/9 steps completed: empty state visible → click "Open the demo rig" → "Pause" button appears (playing) → wait 800 ms → pause → "Play" appears → select `forearm-front` → inspector visible. 0 console / page-error events. Owned browser terminated. A11y snapshot revealed two labelling issues (tool radios announced "MoveV", key buttons announced only "◆") → **fixed** (aria-labels). |
| 9 | `capture_browser_scenario` | controlled | after a11y fix | `ev_6594fe5d769d406dda74dd09e617858379c77568f23db1ac5ec5ee12a616b586` | Tool radio clicked by its new accessible name "Rotate tool (R)" ✔. **Found a real bug:** after pausing (time 0.71 s) and typing rotation 30, the inspector showed **28.41** — the key was written at the snapped frame 21 while the display sampled the un-snapped time. |
| 10 | `capture_browser_scenario` | controlled | after fix (pause snaps to a whole frame) | `ev_cca011f10b30f1dea42f488c0388ac821e14d7e14e85eb05a0f55509f76cf598` | Same steps: readout "19 / 30 · 0.63s" (whole frame), Degrees spinbutton **"30"**, rotate key toggle `[pressed]`, new key "forearm-front rotate key at frame 19" present. 0 console / page-error events. |
| 11 | `capture_browser_scenario` | controlled | **final build** `index-bftQBcAc.js` (sha256 `64586339…5096fb`) | `ev_19ca685c38702c1f58acfbfc5624b3120eaac84197f8b46ac1c1d6863411e1d6` | 11/11 steps completed: demo → playing → pause → "Play" → select bone → type rotation 30 + Enter → click Undo → click Redo (clicks require the buttons to be enabled). 0 console / page-error events. Owned browser terminated. |
| 12 | `export_evidence_bundle` | write | `.hermes/evidence/rea/rea-evidence-bundle.json` | — | final export: 11 records, 0 unknowns. |

The bug found in #9 got a regression assertion in `tests/e2e/editor.e2e.test.ts`
("pausing lands on a whole frame" + inspector value check). Run against the pre-fix
build it failed (`.hermes/evidence/e2e-regression-prefix-fail.txt`: `expected
23.070000000022354 ≈ 23`); against the fixed build it passes (`e2e-tests.txt`).

## Observations vs inferences vs unknowns

- **Observed:** page target identity, two distinct screenshot digests over time, 0 console
  events in the windows observed, the accessibility trees in #5/#8/#9/#10, the single
  served script and its digest, absence of routes/endpoints in the parsed bundle, the
  controlled-scenario step outcomes.
- **Inferred:** "the demo animates" from #3/#4 differing digests + "Pause" button state
  (the pixel *content* change is corroborated separately by the e2e pixel-hash and joint
  world-position assertions, not by REA). "The page ran the built artifact" from the
  digest equality in #7 vs local `shasum`.
- **Unknown / not covered by REA:** console activity before REA attached
  (`prior_activity_available: false`); runtime execution of specific modules (REA states a
  bundle observed at runtime does not prove every module executed); upstream build
  commit of the REA package.

## Blockers and limitations (exact)

1. **`compare_web_screenshots` not run.** Its schema requires both PNGs inline as
   `data_base64`; each capture here is ~140 KB of base64 (tool results 183–191 k chars,
   spilled to disk by the client). Passing them through the MCP call was not practical, so
   the pixel comparison gate is covered by the e2e suite (`sha256` of two stage
   screenshots must differ) and by REA digest inequality only.
2. **`reconcile_javascript_runtime` not run.** It requires the complete static and runtime
   Evidence objects inline; the static record is retained in-session but too large to
   pass back through the client. Reconciliation was done by digest comparison (#7).
3. **Client policy refusal:** copying the oversized `binary_session` spill file from
   `~/.claude/projects/…/tool-results/` into the project with `cp`/`jq` was refused in
   `dontAsk` mode; facts were extracted with Grep instead and the session's records were
   exported with REA's own `export_evidence_bundle`.
4. **Environment:** `~/Applications/Google Chrome for Testing.app` is a dangling symlink
   (→ `mac_arm-153.0.8010.52/…`, bundle missing) and `~/chrome-for-testing/current`
   (155.0.8059.84) is a bash wrapper that `exec`s itself (infinite loop — a stray
   `--version` call hung and was stopped). REA and the tests therefore used the real
   Mach-O at `~/chrome-for-testing/chrome/mac_arm-155.0.8059.39/…`. The CfT install was
   **not** modified. This is an operator-side fix.
