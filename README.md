# maw-crew

A [`maw`](https://maw.soulbrews.studio) plugin that spawns, **verifies**, and tears down
codex coder crews — with the traps handled once, here, instead of being rediscovered
every run.

The command is `maw crew-lab` (alias `maw crew`). It exists for one reason: setup
output describes *intent*, not what survived the spawn. `crew-lab verify` reads
**ground truth** — the actual `auth.json` bytes and the account inside each JWT — and
refuses to say a crew is sound until pool isolation and model parity are proven.

## What it does

Four verbs:

| verb | what it does |
|------|--------------|
| `up <name> --pools 1,5` | render charters → add worktrees → seed credentials → create sessions → gate → spawn, then auto-`verify` |
| `verify <prefix>` | prove pool isolation + model parity from ground truth. **Exit 1 = do not dispatch.** |
| `status [prefix]` | real state from tmux (`maw team status` always reports `idle`) |
| `down <prefix>` | Nothing-is-Deleted teardown — worktrees moved aside, charters kept, branches archived |

Why `verify` is the heart: two pool slots can hold **different token files for the
same account** (different md5, one quota). A bytes-only check calls that "isolated"
while the two crews throttle each other under load. `verify` decodes the `id_token`
and compares accounts pairwise, so a real shared-quota clash gets caught.

## Requirements

- **[`maw`](https://maw.soulbrews.studio)** — provides the `team`, `worktree`, `new`,
  `kill`, and `peek` verbs this plugin drives.
- **[Bun](https://bun.sh)** — the plugin is TypeScript executed by Bun (uses `Bun.$`,
  `Bun.Glob`, `Bun.CryptoHasher`).
- **codex credential pools** at `~/.codex-team/<slot>/auth.json` — one directory per
  numbered slot (e.g. `~/.codex-team/1/`, `~/.codex-team/5/`). Slots are **not
  contiguous**; you list the ones you have.
- **A charter renderer** — [`crew-master-charters`](https://github.com/Soul-Brews-Studio/crew-master-charters)
  provides `scripts/render.sh` (the template + `__ENGINE`/`__POOL` placeholders).
  Its path is machine-local, so you **must** point `CREW_RENDER` at your checkout
  (see [Configuration](#configuration)).
- **codex-setup** at `~/.claude/skills/oracle-team/scripts/codex-setup.ts` — seeds a
  worktree's `.codex/auth.json` from a pool slot.

## Status: fleet-internal

> Two dependencies — the charter renderer (`render.sh`, from
> [`crew-master-charters`](https://github.com/Soul-Brews-Studio/crew-master-charters))
> and `codex-setup.ts` (from the internal `oracle-team` skill) — are **not yet
> publicly available**. You can read the code, the protocol, and the design, and run
> `verify` / `status` / `down` against existing crews, but you **cannot run `up`**
> until those are published. This documents the real state honestly rather than
> implying clone-and-run.

## Install

```sh
git clone https://github.com/Soul-Brews-Studio/maw-crew
cd maw-crew
bun install

# symlink into maw's plugin dir. The link name MUST be `crew-lab` — it has to
# match the command name in plugin.json, NOT the repo name (`maw-crew`).
ln -s "$PWD" ~/.maw/plugins/crew-lab

maw plugin info crew-lab   # should list the crew-lab command
```

## Configuration

`CREW_RENDER` — **required** on any machine but the author's. Absolute path to
`render.sh` from your `crew-master-charters` checkout:

```sh
export CREW_RENDER=/path/to/crew-master-charters/scripts/render.sh
```

If it's unset (or points at a missing file), `up` fails fast with an actionable
message rather than a cryptic non-zero exit from the renderer.

## Usage

```sh
# spawn 2 crews on pools 1 and 5, then auto-verify
maw crew-lab up myexperiment --pools 1,5

# prove isolation before dispatching work
maw crew-lab verify myexperiment      # exit 1 → do not dispatch

# real state from tmux
maw crew-lab status myexperiment

# Nothing-is-Deleted teardown
maw crew-lab down myexperiment
```

`up` flags: `--pools 1,5` (required, comma-listed), `--template <name>`
(default `squad-solo-buddy`), `--base <branch>` (default `main`).

## Design notes

Every guard in `internal/crew.ts` exists because it was hit for real. A few that
shape the whole tool:

- **Pools are listed, never computed** — slots aren't contiguous, so `--pools` takes
  an explicit list.
- **The engine *key name* selects the pool** (`omx-5`). maw ignores the command
  string, so renaming the key is what actually works.
- **A charter is frozen in the registry at load** — editing the yaml afterwards
  changes nothing; `verify` flags a charter edited after load.
- **`team up` is always scoped `--only <coder roles>`** — a bare `up` on a mixed
  charter destroys coder worktrees.
- **A spawn "failure" is confirmed before aborting** — `maw wake` reports engines dead
  while they're still booting; `up` polls the panes before believing it, because a
  team killed by mistake takes its work and quota with it.

Provenance: the traps are distilled from two days of gated crew-formation work,
written up in `ψ/writing/cheatsheets/2026-07-31_maw-crew-formation-teardown.md`.

## License

MIT © Soul-Brews-Studio
