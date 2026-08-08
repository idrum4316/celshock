# AGENTS.md

**All agent guidance lives in [`CLAUDE.md`](CLAUDE.md).** Read it before any
change — it is the source of truth for commands, architecture, load-bearing
invariants and conventions. Three companions carry the lookup material it points
to: [`FILES.md`](FILES.md) (the module map), [`VERIFYING.md`](VERIFYING.md)
(headless-browser quirks) and [`FINDINGS.md`](FINDINGS.md) (open threads).

Quick facts:

- Babylon.js + TypeScript + Vite browser game; `npm run typecheck` is the only
  automated gate — run it after every change.
- `src/core/Game.ts` is the only place systems meet; never add imports between
  systems.
- Every source file has a **contract header** at the top stating what it owns
  and its invariants — read it before editing that file.
- `README.md` is user-facing (game, controls, setup), not contributor guidance.
