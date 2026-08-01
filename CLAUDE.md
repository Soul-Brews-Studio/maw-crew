# maw-crew

The open-source home of the **crew-lab** maw plugin — spawn, verify, and tear down
codex coder crews with the traps handled once.

> Budded from root via `maw bud`; the plugin code was subtree-split out of
> `plugins/crew-lab`. Parent/home oracle: **crew-lab** (`maw hey crew-lab`).

## What this repo is

A published `maw` plugin (`maw crew-lab` / `maw crew`), not a general workspace. The
whole point is `verify`: setup output states *intent*; this tool reads **ground
truth** (auth.json bytes + the account inside each JWT) and refuses to call a crew
sound until pool isolation and model parity are proven.

- `index.ts` — maw entry (default export + `import.meta.main` so maw's *execute*, not
  import, actually runs it).
- `internal/crew.ts` — the four verbs: `up` / `verify` / `status` / `down`.
- `plugin.json` — command `crew-lab` (alias `crew`).
- `types/maw-js.d.ts` — type-only ambient shim for the host SDK; maw-rs injects the
  runtime, so there is no `maw-js` package dependency.

## Working rules

- **Host is maw-rs.** The plugin is TypeScript run by Bun; `maw-js` is imported for
  types only.
- **`CREW_RENDER` is required off the author's machine** — points at
  `crew-master-charters/scripts/render.sh` (separate repo, owns the charter template).
- **Every guard exists because it was hit for real.** Don't remove one without
  reading why it's there — provenance is
  `ψ/writing/cheatsheets/2026-07-31_maw-crew-formation-teardown.md`.
- **Verify against the real thing.** A gate must reject something known-broken, not
  just pass a fixture.
- Two plugin authoring traps, kept because they cost hours: `cli.flags` must be an
  **object**, not an array (else maw can't see the flags); the entry needs
  `import.meta.main` (maw executes the file, it does not import it).

See `README.md` for install and usage.
