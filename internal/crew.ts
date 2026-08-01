// crew.ts — the work behind `maw crew-lab`.
//
// Wraps the crew-formation flow so its traps are handled once, here, instead of
// being rediscovered every run. Every guard exists because it was hit for real
// (see ψ/writing/cheatsheets/2026-07-31_*.md, traps #1–#14).
//
// Rules encoded here:
//   * pools are LISTED, never computed — slots are not contiguous (1,2,5,6)
//   * the engine KEY NAME selects the pool (`omx-5`); the command string is
//     ignored by maw, so renaming the key is what actually works (trap #14)
//   * a charter is frozen in the registry at load; editing the yaml afterwards
//     changes nothing (trap #13)
//   * `team up` is always scoped with --only <coder roles>; a bare up on a mixed
//     charter destroys coder worktrees (maw-rs#258)
//   * members are read from the charter, never guessed — a charter can have any
//     shape, and guessing would verify a worktree that isn't there
//   * verification reads ground truth (auth bytes), because setup output states
//     intent, not what survived the spawn

import { $ } from "bun";
import { basename, join } from "node:path";

$.throws(false); // we inspect exit codes ourselves

export const POOL_ROOT = join(process.env.HOME!, ".codex-team");
const TEAM_REGISTRY = join(process.env.HOME!, ".claude", "teams");
const RENDER =
  process.env.CREW_RENDER ??
  "/opt/Code/github.com/Soul-Brews-Studio/crew-master-charters/scripts/render.sh";
const SETUP = join(process.env.HOME!, ".claude/skills/oracle-team/scripts/codex-setup.ts");

export class CrewError extends Error {}
const die = (m: string): never => {
  throw new CrewError(m);
};

// ── charter parsing ───────────────────────────────────────────────────
// Charters are generated from templates, so a targeted parse beats a YAML
// dependency. Only the fields this tool acts on are read.
export interface Member { role: string; name: string; worktree: string | null; branch: string | null }
export interface Charter { path: string; name: string; session: string; members: Member[]; engineKeys: string[] }

export async function parseCharter(path: string): Promise<Charter> {
  const text = await Bun.file(path).text();
  const top = (k: string) => text.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
  const engineKeys = [...text.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*"/gm)].map((m) => m[1]);

  const members: Member[] = [];
  let cur: Member | null = null;
  for (const line of text.split("\n")) {
    const role = line.match(/^\s*-\s*role:\s*(.+)$/);
    if (role) {
      if (cur) members.push(cur);
      cur = { role: role[1].trim(), name: "", worktree: null, branch: null };
      continue;
    }
    if (!cur) continue;
    const name = line.match(/^\s+name:\s*(.+)$/);
    const wt = line.match(/^\s+worktree:\s*(.+)$/);
    const br = line.match(/^\s+branch:\s*(.+)$/);
    if (name) cur.name = name[1].trim();
    if (wt) cur.worktree = wt[1].trim() === "false" ? null : wt[1].trim();
    if (br) cur.branch = br[1].trim();
  }
  if (cur) members.push(cur);

  return { path, name: top("name"), session: top("session"), members, engineKeys };
}

/** Members that own a worktree — i.e. everyone but the lead. */
export const coders = (c: Charter) => c.members.filter((m) => m.worktree);

// ── ground truth ──────────────────────────────────────────────────────
// Bun.CryptoHasher rather than shelling out to `md5`, which is macOS-only.
async function md5(path: string): Promise<string | null> {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  return new Bun.CryptoHasher("md5").update(await f.arrayBuffer()).digest("hex");
}

export const poolSlots = async (): Promise<string[]> => {
  const out = await $`ls ${POOL_ROOT}`.quiet().text().catch(() => "");
  return out.split("\n").map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).sort((a, b) => +a - +b);
};

export const crewAuth = (lab: string, worktree: string) => md5(join(lab, worktree, ".codex/auth.json"));

/**
 * The account an auth.json belongs to, read out of the id_token.
 *
 * Byte equality is not the isolation test. Two pool slots can hold different
 * token files for the SAME account (pool 1 and hermes are both
 * codexsomkit@oraclenet.work here): the hashes differ, so a bytes-only check
 * reports isolated while the two crews spend one quota and throttle together.
 */
export async function authAccount(path: string): Promise<string | null> {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  try {
    const d = JSON.parse(await f.text());
    for (const k of ["email", "account_id", "accountId"]) if (d[k]) return String(d[k]);
    const tok = d?.tokens?.id_token ?? d?.id_token;
    if (!tok) return null;
    const raw = tok.split(".")[1];
    const pad = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(pad, "base64url").toString());
    return claims.email ?? claims.sub ?? null;
  } catch {
    return null;
  }
}

export const crewAccount = (lab: string, worktree: string) =>
  authAccount(join(lab, worktree, ".codex/auth.json"));

/** Which pool a worktree's credentials actually came from — not which it asked for. */
export async function livePool(lab: string, worktree: string): Promise<string | null> {
  const want = await crewAuth(lab, worktree);
  if (!want) return null;
  for (const slot of await poolSlots()) {
    if ((await md5(join(POOL_ROOT, slot, "auth.json"))) === want) return slot;
  }
  return "unknown";
}

export async function liveModel(session: string, window: string): Promise<string | null> {
  const out = await $`maw peek ${`${session}:${window}`}`.quiet().text().catch(() => "");
  // The effort word is not a fixed set — omx renders "default" too, and a regex
  // that lists only xhigh/high/medium/low reports a running engine as not booted.
  const hits = [...out.matchAll(/gpt-[0-9.a-z-]+(?: [a-z]+)?(?= ·)/g)];
  return hits.length ? hits[hits.length - 1][0] : null;
}

export const sessionUp = async (s: string) =>
  (await $`tmux has-session -t ${s}`.quiet().nothrow()).exitCode === 0;

/**
 * Repo root via maw, not git: `maw worktree ls` lists the main worktree first,
 * and it works from any subdirectory. Staying on maw verbs keeps this tool and
 * maw from drifting into two different notions of the same state.
 */
export async function labRoot(): Promise<string> {
  const out = (await $`maw worktree ls`.quiet().nothrow()).stdout.toString();
  const row = out.split("\n")[1]?.split("\t")[0]?.trim();
  return row || die("not inside a maw-visible repository");
}

// Both extensions: maw parses either, so accepting only .yaml would be a limit
// this tool invented rather than one the charter format imposes.
const chartersFor = async (lab: string, prefix: string) =>
  (await Array.fromAsync(new Bun.Glob(`ψ/teams/${prefix}*.{yaml,yml}`).scan({ cwd: lab }))).sort();

// ── verify ────────────────────────────────────────────────────────────
// The point of the tool. Returns true only when every crew is individually
// sound AND the crews are mutually isolated.
export async function verify(prefix: string, log = console.log): Promise<boolean> {
  const lab = await labRoot();
  const files = await chartersFor(lab, prefix);
  if (!files.length) die(`no charters matching ${prefix}* in ψ/teams/`);

  let ok = true;
  const auths: { who: string; hash: string; account: string | null }[] = [];
  const models = new Set<string>();
  const pools: string[] = [];

  for (const rel of files) {
    const charter = await parseCharter(join(lab, rel));

    // `down` keeps the charter as a record on purpose. Without this, every
    // teardown leaves behind something verify would fail on for ever — the
    // Nothing-is-Deleted rule and the verifier would be fighting each other.
    const inRegistry = await Bun.file(join(TEAM_REGISTRY, charter.name, "config.json")).exists();
    const anyWorktree = (await Promise.all(coders(charter).map((m) => crewAuth(lab, m.worktree!))))
      .some(Boolean);
    if (!inRegistry && !anyWorktree) {
      log(`── ${charter.name}  (archived record — torn down, skipped)`);
      continue;
    }

    log(`── ${charter.name}`);
    const up = await sessionUp(charter.session);
    log(`  session   : ${up ? `UP (${charter.session})` : `DOWN (${charter.session})`}`);
    if (!up) ok = false;

    // trap #13 — the registry snapshot is what maw runs; the yaml may have moved on
    const reg = Bun.file(join(TEAM_REGISTRY, charter.name, "config.json"));
    if (await reg.exists()) {
      const yamlAt = Bun.file(join(lab, rel)).lastModified;
      if (yamlAt > reg.lastModified) {
        log(`  registry  : ✗ ${basename(rel)} edited AFTER load — maw still runs the old snapshot (#13); 'down' then 'up' to apply`);
        ok = false;
      }
    }

    for (const m of coders(charter)) {
      const wt = m.worktree!;
      const want = (await Bun.file(join(lab, rel)).text()).match(/codex-setup\.ts\s+(\d+)/)?.[1] ?? null;
      const got = await livePool(lab, wt);
      const label = `  ${m.role.padEnd(9)}`;

      if (got === null) { log(`${label}: — no auth.json (worktree gone; this crew is torn down)`); ok = false; }
      else if (got === "unknown") { log(`${label}: ✗ credentials match no pool in ${POOL_ROOT}`); ok = false; }
      else if (want && got !== want) { log(`${label}: ✗ running pool ${got} but charter asks for ${want} — WRONG POOL`); ok = false; }
      else log(`${label}: pool ${got} ✓ (auth matches ${POOL_ROOT}/${got})`);

      const hash = await crewAuth(lab, wt);
      const account = await crewAccount(lab, wt);
      if (hash) auths.push({ who: basename(wt), hash, account });
      if (account) log(`${label}: account ${account}`);
      if (got) pools.push(got);

      const model = up ? await liveModel(charter.session, basename(wt)) : null;
      if (model) { log(`${label}: model ${model}`); models.add(model); }
      else if (up) { log(`${label}: ✗ no engine status line — engine did not boot`); ok = false; }
    }
  }

  log("");
  // trap #9 lives here. Checking each member against its own expected pool is
  // not enough — two members can each look fine yet hold the same credential.
  let clash = false;
  for (let i = 0; i < auths.length; i++)
    for (let j = i + 1; j < auths.length; j++) {
      const a = auths[i], b = auths[j];
      if (a.hash === b.hash) {
        log(`auth pairwise  : ✗ ${a.who} and ${b.who} share credentials (md5 ${a.hash.slice(0, 8)}) — trap #9`);
        clash = true; ok = false;
      } else if (a.account && a.account === b.account) {
        // different token files, one account — the hashes differ but the quota
        // does not, so these two throttle each other under load
        log(`auth pairwise  : ✗ ${a.who} and ${b.who} hold different tokens for the SAME account (${a.account}) — one quota, not two`);
        clash = true; ok = false;
      }
    }
  if (!clash) log(`auth pairwise  : ✓ distinct credentials and distinct accounts (${auths.length} checked)`);

  log(new Set(pools).size === pools.length
    ? `pools distinct : ✓ (${pools.join(" ")})`
    : `pools distinct : ✗ SHARED POOL (${pools.join(" ")})`);
  if (new Set(pools).size !== pools.length) ok = false;

  // Different models silently confound any comparison between crews (trap #11)
  log(models.size <= 1
    ? `models equal   : ✓ ${[...models].join(" ") || "(none running)"}`
    : `models equal   : ✗ crews run different models — comparisons are confounded: ${[...models].join(" | ")}`);
  if (models.size > 1) ok = false;

  log("");
  log(ok ? "VERIFIED" : "NOT VERIFIED — do not dispatch");
  return ok;
}

// ── status ────────────────────────────────────────────────────────────
// `maw team status` prints "idle" unconditionally without querying tmux.
export async function status(prefix = "", log = console.log): Promise<void> {
  const lab = await labRoot();
  const files = await chartersFor(lab, prefix);
  log(["TEAM".padEnd(28), "SESSION".padEnd(22), "STATE".padEnd(6), "POOL".padEnd(8), "MODEL"].join(" "));
  for (const rel of files) {
    const c = await parseCharter(join(lab, rel));
    const up = await sessionUp(c.session);
    const cs = coders(c);
    const pool = up && cs.length ? (await livePool(lab, cs[0].worktree!)) ?? "-" : "-";
    const model = up && cs.length ? (await liveModel(c.session, basename(cs[0].worktree!))) ?? "-" : "-";
    log([c.name.padEnd(28), c.session.padEnd(22), (up ? "up" : "down").padEnd(6), String(pool).padEnd(8), model].join(" "));
  }
}

// ── up ────────────────────────────────────────────────────────────────
export async function up(
  name: string,
  opts: { pools: string[]; template?: string; base?: string },
  log = console.log,
): Promise<void> {
  const lab = await labRoot();
  const template = opts.template ?? "squad-solo-buddy";
  const base = opts.base ?? "main";
  if (!opts.pools.length) die("--pools is required — list the slots explicitly (they are NOT contiguous)");

  const have = await poolSlots();
  for (const p of opts.pools) if (!have.includes(p)) die(`pool slot '${p}' does not exist (have: ${have.join(" ")})`);

  const d = new Date();
  const disc = [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]
    .map((n) => String(n).padStart(2, "0")).join("");

  log(`crew up: ${name} (${opts.pools.length} crew, pools ${opts.pools.join(",")}, template ${template})`);

  for (const [i, pool] of opts.pools.entries()) {
    const team = `${name}-c${i + 1}${disc}`;
    const session = `crew${name}c${i + 1}${disc}`.toLowerCase().replace(/[^a-z0-9]/g, "");
    const charterPath = join(lab, `ψ/teams/${team}.yaml`);
    log(`── crew ${i + 1}/pool ${pool} → ${team}`);

    // charters are one-shot records, and a loaded team cannot be edited (#13)
    if (await Bun.file(charterPath).exists()) die(`charter ψ/teams/${team}.yaml exists — pick another name`);
    if (await Bun.file(join(TEAM_REGISTRY, team, "config.json")).exists())
      die(`team '${team}' already in the registry — 'maw crew-lab down ${team}' first`);

    // Pool selection belongs to render.sh (--pools), not to a sed pass here.
    // Rewriting the rendered charter afterwards would be a second implementation
    // of the same rule, free to drift from the one maw and render.sh agree on.
    const r = await $`${RENDER} --template ${template} --target ${lab} --team ${team} --session ${session} --lead-name ${basename(lab)} --pools ${pool}`.quiet().nothrow();
    if (r.exitCode !== 0) die(`render failed for ${team}: ${(r.stderr.toString() + r.stdout.toString()).trim()}`);

    // trap #14 — maw reads the engine KEY, so that is what must carry the slot
    const yaml = await Bun.file(charterPath).text();
    if (!yaml.includes(`omx-${pool}:`))
      die(`charter ${team}.yaml has no omx-${pool} engine key — the template may not use __ENGINEn__`);

    const charter = await parseCharter(charterPath);
    for (const m of coders(charter)) {
      const wt = m.worktree!;
      const w = await $`maw worktree add ${basename(wt)} --base ${base}`.cwd(lab).quiet().nothrow();
      if (w.exitCode !== 0) die(`worktree add failed for ${wt}: ${w.stderr.toString().trim()}`);
      await $`bun ${SETUP} ${pool}`.cwd(join(lab, wt)).quiet().nothrow();
      await $`sh -c ${`printf '\\n[projects."%s"]\\ntrust_level = "trusted"\\n' "${join(lab, wt)}" >> "${join(lab, wt, ".codex/config.toml")}"`}`.quiet().nothrow();
    }

    await $`maw new ${session} --path ${lab} --shell --no-attach`.quiet().nothrow();
    if (!(await sessionUp(session))) die(`session ${session} not up after create`);

    if ((await $`maw team load ${charterPath} --no-spawn`.cwd(lab).quiet().nothrow()).exitCode !== 0)
      die(`team load failed for ${team}`);

    // never a bare `team up` — that destroys coder worktrees on a mixed charter
    const only = coders(charter).map((m) => m.role).join(",");
    if ((await $`maw team up ${team} --only ${only} --dry-run`.cwd(lab).quiet().nothrow()).exitCode !== 0)
      die(`dry-run failed for ${team}`);
    const s = await $`maw team up ${team} --only ${only}`.cwd(lab).quiet().nothrow();
    if (s.exitCode !== 0) {
      // `maw wake` reports "engine did not start" while the engine is in fact
      // booting — reproduced at load 26-27 and again at 40.7. Dying here aborts
      // a team that is already half up. Ask the pane before believing the error.
      // Poll rather than ask once. `maw wake` already waited and gave up; an
      // engine that is merely slow will still be absent the instant afterwards.
      // Asking immediately reproduces the very false negative this guards against
      // — which is exactly what the first version of this code did.
      const waitForEngines = async (deadlineMs = 60_000, stepMs = 5_000) => {
        const started = Bun.nanoseconds();
        const elapsed = () => (Bun.nanoseconds() - started) / 1e6;
        let boots: { who: string; model: string | null }[] = [];
        for (;;) {
          boots = await Promise.all(
            coders(charter).map(async (m) => ({
              who: basename(m.worktree!),
              model: await liveModel(session, basename(m.worktree!)),
            })),
          );
          if (boots.every((b) => b.model) || elapsed() > deadlineMs) return boots;
          await Bun.sleep(stepMs);
        }
      };
      const boots = await waitForEngines();
      const alive = boots.filter((b) => b.model);
      if (alive.length === boots.length) {
        log(`  spawn reported failure, but every pane is running an engine — false negative, continuing`);
        for (const b of alive) log(`    ${b.who}: ${b.model}`);
      } else {
        const dead = boots.filter((b) => !b.model).map((b) => b.who).join(", ");
        die(`spawn failed for ${team} — ${dead} still had no engine after 60s: ${s.stderr.toString().trim()}`);
      }
    } else {
      log(`  spawned ${only} in ${session}`);
    }
  }

  // Verify runs automatically, but its result is a REPORT, not an action. A
  // credential clash is worth shouting about; it is not worth destroying a team
  // over, because the costs are not symmetric — a spawned team can still be torn
  // down by hand, a team killed by mistake takes its work and its quota with it.
  log("");
  log("verify:");
  const ok = await verify(name, (line) => log(`  ${line}`));
  if (!ok) {
    log("");
    log(`NOT VERIFIED — the crews are up but not sound. Nothing was torn down.`);
    log(`  inspect : maw crew-lab status ${name}`);
    log(`  tear down: maw crew-lab down ${name}`);
  }
}

// ── down ──────────────────────────────────────────────────────────────
// Nothing-is-Deleted: worktrees are moved aside, charters kept as records.
export async function down(prefix: string, log = console.log): Promise<void> {
  const lab = await labRoot();
  const files = await chartersFor(lab, prefix);
  if (!files.length) die(`no charters matching ${prefix}* in ψ/teams/`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `/tmp/crew-down-${prefix}-${stamp}`;
  await $`mkdir -p ${dest}`.quiet();

  for (const rel of files) {
    const c = await parseCharter(join(lab, rel));
    log(`── ${c.name}`);
    if (await sessionUp(c.session)) {
      await $`maw kill ${c.session}`.quiet().nothrow();
      log("  session killed");
    }
    for (const m of coders(c)) {
      const abs = join(lab, m.worktree!);
      if (await Bun.file(join(abs, ".codex/config.toml")).exists() || (await $`test -d ${abs}`.quiet().nothrow()).exitCode === 0) {
        await $`mv ${abs} ${dest}/`.quiet().nothrow();
        log(`  worktree → ${dest}/${basename(m.worktree!)}`);
      }
    }
    if (await Bun.file(join(TEAM_REGISTRY, c.name, "config.json")).exists()) {
      await $`maw team delete ${c.name}`.quiet().nothrow();
      log("  team dir removed");
    }

    // Prune first: git still considers a branch checked out until the moved
    // worktree is deregistered, and refuses to delete it. Pruning here rather
    // than at the end is what makes the deletion below actually possible.
    await $`maw worktree clean`.cwd(lab).quiet().nothrow();

    // Branches outlive the worktree, and a tear-down that leaves them behind is
    // how a repo accumulates `agents/*` stubs nobody dares delete. An empty
    // branch is deleted (safe: -d refuses anything unmerged). One carrying
    // commits is renamed under archive/ — kept, but no longer looking like
    // work in flight.
    for (const m of coders(c)) {
      const br = m.branch;
      if (!br) continue;
      const exists = (await $`git -C ${lab} rev-parse --verify --quiet ${br}`.quiet().nothrow()).exitCode === 0;
      if (!exists) continue;

      const ahead = Number(
        (await $`git -C ${lab} rev-list --count main..${br}`.quiet().nothrow()).stdout.toString().trim() || "0",
      );
      if (ahead === 0) {
        const d = await $`git -C ${lab} branch -d ${br}`.quiet().nothrow();
        log(d.exitCode === 0 ? `  branch deleted (no commits): ${br}` : `  branch kept (delete refused): ${br}`);
      } else {
        const dest = `archive/${c.name}/${basename(br)}`;
        const r = await $`git -C ${lab} branch -m ${br} ${dest}`.quiet().nothrow();
        log(r.exitCode === 0
          ? `  branch archived: ${br} → ${dest} (${ahead} commit${ahead > 1 ? "s" : ""})`
          : `  branch kept: ${br} (${ahead} commits, rename failed)`);
      }
    }

    log(`  charter kept: ${rel}`);
  }
  // `maw worktree clean` is the maw-side prune: it clears the stale gitdir
  // pointers left by moving a worktree aside. Its output says "skip (dirty)"
  // for live worktrees and stays silent about the pruning it actually did.
  await $`maw worktree clean`.cwd(lab).quiet().nothrow();
  log("");
  log(`archived under ${dest} (nothing deleted)`);
}
