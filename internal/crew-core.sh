#!/usr/bin/env bash
# crew-core.sh — the real work behind `maw crew`.
#
# Wraps the crew-formation flow so the traps are handled once, here, instead of
# being re-discovered every time. Every guard below exists because it was hit
# for real on crew-lab (see ψ/writing/cheatsheets/2026-07-31_*.md, traps #1-#14).
#
# Verbs:
#   up     <name> --pools <list> [--template T] [--base B]   render → worktrees → sessions → gates → spawn
#   verify <name>                                            prove pool + model + session from ground truth
#   status <name>                                            real state (tmux), not `maw team status`
#   down   <name>                                            Nothing-is-Deleted teardown
#
# Design rules this encodes:
#   * pools are LISTED, never computed — slots are not contiguous (1,2,5,6 here)
#   * the engine KEY NAME picks the pool (`omx-5`), not the command string
#   * a charter is frozen in the registry once loaded — `up` refuses to reuse a name
#   * `team up` is ALWAYS scoped with --only <coders>; a full up on a mixed
#     charter destroys coder worktrees (maw-rs#258)
#   * verification compares auth.json md5 against the pool source, because the
#     setup output only says what was INTENDED, not what survived the spawn

set -uo pipefail

LAB="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not in a git repo" >&2; exit 1; }
cd "$LAB" || exit 1
RENDER="${CREW_RENDER:-/opt/Code/github.com/Soul-Brews-Studio/crew-master-charters/scripts/render.sh}"
POOL_ROOT="$HOME/.codex-team"
SETUP="$HOME/.claude/skills/oracle-team/scripts/codex-setup.ts"

die()  { echo "crew: $*" >&2; exit 1; }
note() { echo "  $*"; }

# ── shared helpers ────────────────────────────────────────────────────
member_name() { echo "$1-buddy"; }          # squad-solo-buddy: one coder named <team>-buddy
session_of()  { echo "$1" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9'; }
pool_md5()    { md5 -q "$POOL_ROOT/$1/auth.json" 2>/dev/null; }
crew_md5()    { md5 -q "$LAB/agents/$1/.codex/auth.json" 2>/dev/null; }

live_pool() {  # which pool a worktree's auth actually matches — the ground truth
  local want="$(crew_md5 "$1")"; [ -n "$want" ] || { echo "?"; return; }
  for p in $(ls "$POOL_ROOT" 2>/dev/null | grep -E '^[0-9]+$' | sort -n); do
    [ "$(pool_md5 "$p")" = "$want" ] && { echo "$p"; return; }
  done
  echo "unknown"
}

live_model() { # read the status line the engine is actually rendering
  maw peek "$1:$2" 2>/dev/null | grep -Eo 'gpt-[0-9.a-z-]+ (xhigh|high|medium|low)' | tail -1
}

# ── up ────────────────────────────────────────────────────────────────
cmd_up() {
  local base_name="" pools="" template="squad-solo-buddy" base="main"
  while [ $# -gt 0 ]; do
    case "$1" in
      --pools)    pools="$2"; shift 2 ;;
      --template) template="$2"; shift 2 ;;
      --base)     base="$2"; shift 2 ;;
      -*)         die "unknown flag: $1" ;;
      *)          base_name="$1"; shift ;;
    esac
  done
  [ -n "$base_name" ] || die "usage: maw crew up <name> --pools 1,5"
  [ -n "$pools" ]     || die "--pools is required — list the slots explicitly (they are NOT contiguous)"

  IFS=',' read -ra POOL_LIST <<< "$pools"
  # every pool must exist; no inference, no silent fallback
  for p in "${POOL_LIST[@]}"; do
    [ -d "$POOL_ROOT/$p" ] || die "pool slot '$p' does not exist (have: $(ls "$POOL_ROOT" | grep -E '^[0-9]+$' | tr '\n' ' '))"
  done

  local disc; disc="$(date +%m%d%H%M)"
  echo "crew up: $base_name (${#POOL_LIST[@]} crew, pools $pools, template $template)"

  local i=0
  for p in "${POOL_LIST[@]}"; do
    i=$((i+1))
    local team="${base_name}-c${i}${disc}" sess mem wt
    sess="$(session_of "crew${base_name}c${i}${disc}")"
    mem="$(member_name "$team")"; wt="agents/$mem"

    echo "── crew $i/pool $p → $team"

    # frozen-charter guard: a loaded team cannot be edited, so never reuse a name
    [ -f "ψ/teams/$team.yaml" ] && die "charter ψ/teams/$team.yaml exists — pick a new name (charters are one-shot records)"
    [ -d "$HOME/.claude/teams/$team" ] && die "team '$team' already in the registry — 'maw crew down $team' first"

    "$RENDER" --template "$template" --target "$LAB" --team "$team" \
      --session "$sess" --lead-name "$(basename "$LAB")" >/dev/null \
      || die "render failed for $team"

    # trap #14: the engine KEY NAME selects the pool. Rename omx-N → omx-<pool>
    # in both the engines block and the member reference, then set the command.
    sed -i '' \
      -e "s|^  omx-[0-9]*:|  omx-${p}:|" \
      -e "s|engine: omx-[0-9]*|engine: omx-${p}|" \
      -e "s|codex-setup\.ts [0-9]*|codex-setup.ts ${p}|" \
      "ψ/teams/$team.yaml"

    grep -q "omx-${p}:" "ψ/teams/$team.yaml" || die "pool rewrite failed in $team.yaml"

    maw worktree add "$mem" --base "$base" >/dev/null || die "worktree add failed for $mem"
    ( cd "$wt" && bun "$SETUP" "$p" >/dev/null 2>&1 ) || die "codex-setup failed for $mem"
    printf '\n[projects."%s"]\ntrust_level = "trusted"\n' "$LAB/$wt" >> "$wt/.codex/config.toml"

    maw new "$sess" --path "$LAB" --shell --no-attach >/dev/null || die "session $sess failed"
    tmux has-session -t "$sess" 2>/dev/null || die "session $sess not up after create"

    # gates — dry-run before anything real
    maw team load "ψ/teams/$team.yaml" --no-spawn >/dev/null || die "team load failed for $team"
    maw team up "$team" --only buddy --dry-run >/dev/null || die "dry-run failed for $team"

    # real spawn — ALWAYS scoped; a bare `team up` would wipe coder worktrees (#258)
    maw team up "$team" --only buddy >/dev/null || die "spawn failed for $team"
    note "spawned $mem in $sess"
    echo "$team" >> "$LAB/.crew-last-up"
  done

  echo
  echo "next: maw crew verify $base_name   # never trust a spawn you have not verified"
}

# ── verify ────────────────────────────────────────────────────────────
# The point of this verb. Setup output says what was intended; this reads what
# actually survived: auth md5 vs pool source, model from the live status line.
cmd_verify() {
  local base_name="${1:?usage: maw crew verify <name>}"
  local rc=0 models="" pools_seen="" auths=""
  local found=0

  for f in ψ/teams/${base_name}*.yaml; do
    [ -e "$f" ] || continue
    found=1
    local team mem sess model pool want_pool
    team="$(basename "$f" .yaml)"
    mem="$(member_name "$team")"
    sess="$(grep '^session:' "$f" | awk '{print $2}')"
    want_pool="$(grep -o 'codex-setup\.ts [0-9]*' "$f" | grep -o '[0-9]*$' | head -1)"

    pool="$(live_pool "$mem")"
    model="$(live_model "$sess" "$mem")"

    printf '%s\n' "── $team"
    if tmux has-session -t "$sess" 2>/dev/null; then
      note "session   : UP ($sess)"
    else
      note "session   : DOWN ($sess)"; rc=1
    fi
    if [ "$pool" = "$want_pool" ]; then
      note "pool      : $pool ✓ (auth md5 matches $POOL_ROOT/$pool)"
    elif [ "$pool" = "?" ]; then
      note "pool      : — no auth.json (worktree gone; this crew is torn down)"; rc=1
    elif [ "$pool" = "unknown" ]; then
      note "pool      : ✗ auth matches no pool source — credentials are not from $POOL_ROOT"; rc=1
    else
      note "pool      : $pool ✗ charter asks for $want_pool — WRONG POOL, credentials may be shared"; rc=1
    fi
    [ -n "$model" ] && note "model     : $model" || { note "model     : (no engine status line — engine may not have booted)"; rc=1; }

    # trap #13: a charter is frozen at load; edits to the yaml never reach maw.
    # mtime comparison detects exactly that condition — the yaml was touched
    # after the registry snapshot was taken.
    local reg="$HOME/.claude/teams/$team/config.json"
    if [ -f "$reg" ] && [ "$f" -nt "$reg" ]; then
      note "registry  : ✗ $team.yaml edited AFTER load — maw still uses the old snapshot (#13); 'crew down' then 'up' to apply"
      rc=1
    fi

    models="$models|$model"; pools_seen="$pools_seen $pool"
    auths="$auths $mem:$(crew_md5 "$mem")"
  done

  [ "$found" = 1 ] || die "no charters matching ${base_name}* in ψ/teams/"

  echo
  # ── pairwise auth comparison — trap #9 lives here ────────────────────
  # Comparing each member against its own expected pool is NOT enough: two
  # members can both be "wrong" in the same direction and look individually
  # fine. Credentials are shared iff two members' auth.json are byte-identical.
  local clash=0
  for a in $auths; do
    for b in $auths; do
      [ "$a" = "$b" ] && continue
      local an="${a%%:*}" am="${a#*:}" bn="${b%%:*}" bm="${b#*:}"
      [ -z "$am" ] || [ -z "$bm" ] && continue
      if [ "$am" = "$bm" ] && [ "$an" \< "$bn" ]; then
        echo "auth pairwise  : ✗ $an and $bn share the SAME credentials (md5 ${am:0:8}) — trap #9"
        clash=1; rc=1
      fi
    done
  done
  [ "$clash" = 0 ] && echo "auth pairwise  : ✓ no two members share credentials"

  local uniq_pools; uniq_pools=$(echo $pools_seen | tr ' ' '\n' | sort -u | wc -l | tr -d ' ')
  local n_pools;    n_pools=$(echo $pools_seen | wc -w | tr -d ' ')
  if [ "$uniq_pools" = "$n_pools" ]; then
    echo "pools distinct : ✓ ($pools_seen)"
  else
    echo "pools distinct : ✗ SHARED CREDENTIALS —$pools_seen"; rc=1
  fi
  local uniq_models; uniq_models=$(echo "$models" | tr '|' '\n' | grep -v '^$' | sort -u | wc -l | tr -d ' ')
  if [ "$uniq_models" -le 1 ]; then
    echo "models equal   : ✓$(echo "$models" | tr '|' ' ')"
  else
    echo "models equal   : ✗ crews run different models — comparisons are confounded:$(echo "$models" | tr '|' ' ')"; rc=1
  fi

  [ "$rc" = 0 ] && echo && echo "VERIFIED" || { echo; echo "NOT VERIFIED — do not dispatch"; }
  return $rc
}

# ── status ────────────────────────────────────────────────────────────
# `maw team status` prints "idle" unconditionally (team_core.rs:386) — it never
# queries tmux. This asks tmux directly.
cmd_status() {
  local base_name="${1:-}"
  local pat="ψ/teams/${base_name:+${base_name}-c}*.yaml"
  printf '%-28s %-22s %-6s %-10s %s\n' TEAM SESSION STATE POOL MODEL
  for f in $pat; do
    [ -e "$f" ] || continue
    local team mem sess
    team="$(basename "$f" .yaml)"; mem="$(member_name "$team")"
    sess="$(grep '^session:' "$f" | awk '{print $2}')"
    local state="down"; tmux has-session -t "$sess" 2>/dev/null && state="up"
    printf '%-28s %-22s %-6s %-10s %s\n' "$team" "$sess" "$state" \
      "$([ "$state" = up ] && live_pool "$mem" || echo '-')" \
      "$([ "$state" = up ] && live_model "$sess" "$mem" || echo '-')"
  done
}

# ── down ──────────────────────────────────────────────────────────────
# Nothing-is-Deleted: worktrees move to /tmp, the charter .yaml stays as a record.
cmd_down() {
  local base_name="${1:?usage: maw crew down <name>}"
  local stamp dest; stamp="$(date +%Y%m%d-%H%M%S)"
  dest="/tmp/crew-down-${base_name}-${stamp}"; mkdir -p "$dest"

  for f in ψ/teams/${base_name}*.yaml; do
    [ -e "$f" ] || continue
    local team mem sess
    team="$(basename "$f" .yaml)"; mem="$(member_name "$team")"
    sess="$(grep '^session:' "$f" | awk '{print $2}')"
    echo "── $team"
    tmux has-session -t "$sess" 2>/dev/null && { maw kill "$sess" >/dev/null 2>&1; note "session killed"; }
    [ -d "agents/$mem" ] && { mv "agents/$mem" "$dest/"; note "worktree → $dest/$mem"; }
    [ -d "$HOME/.claude/teams/$team" ] && { maw team delete "$team" >/dev/null 2>&1; note "team dir removed"; }
    note "charter kept: $f"
  done
  git worktree prune
  echo
  echo "archived under $dest (nothing deleted)"
}

case "${1:-}" in
  up)     shift; cmd_up "$@" ;;
  verify) shift; cmd_verify "$@" ;;
  status) shift; cmd_status "$@" ;;
  down)   shift; cmd_down "$@" ;;
  *) cat <<USAGE
maw crew — spawn, verify, and tear down codex crews

  maw crew up <name> --pools 1,5 [--template squad-solo-buddy] [--base main]
  maw crew verify <name>     prove pool isolation + model parity from ground truth
  maw crew status [name]     real state from tmux (maw team status always says idle)
  maw crew down <name>       Nothing-is-Deleted teardown

pools must be listed explicitly — slots are not contiguous.
USAGE
    exit 1 ;;
esac
