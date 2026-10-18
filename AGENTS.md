# AGENTS.md — Rigsmith

Independent browser 2D skeletal animation editor. Initial vertical slice; never claim
parity with any commercial tool.

## Authority
- Work only inside this repo, `.hermes/browser-profiles/` and `.hermes/evidence/`.
- Agent work is local-only: agents add no remotes and never push, deploy or publish.
  Private GitHub publication is owned solely by the operator-authorized Hermes
  controller. `.gitignore` keeps `.hermes/{dispatch,assets,evidence,browser-profiles}/`,
  credentials and env files out of every commit.
- No public binds. Preview binds `127.0.0.1` only, on a port
  checked free first (default 47613; e2e picks 47614–47617).
- Never open/focus the user's Chrome. Automation uses headless Chrome for Testing with a
  project-local profile (`tests/e2e/harness.ts`). Kill only processes you started.
- No Spine binaries/trial/art/code, no decompilation, no EULA acceptance (see
  `docs/provenance.md`). Original art only.

## Verification gates (all must pass before claiming done)
1. `npm test` — model unit tests (transforms, cycles, interpolation, format, undo).
2. `npm run build` — `tsc --noEmit` + Vite production build.
3. `npm run test:e2e` — real browser interaction tests against `dist/`.
Save raw output to `.hermes/evidence/` (git-ignored). Never hand-edit outputs.

## Evidence rules
- Browser tests drive visible controls; `window.__rigsmith` is read-only (assertions only).
- REA calls go in `docs/rea-evidence.md` with Evidence IDs and limitations; separate
  observed / inferred / unknown. Passive tools observe; `capture_browser_scenario` is
  controlled — say which.
- A feature is "delivered" only if a visible control exists and a test exercises it.
- Status lives in `.hermes/STATUS.md`; Hermes verification is external — never self-certify.
