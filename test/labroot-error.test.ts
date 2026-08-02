// Locks the labRoot() error-message split (crew-lab's defect: two unrelated
// failures collapsed into one misleading "not inside a maw-visible repository").
//
// A gate that only ever passes is worth nothing — this proves the message
// DISTINGUISHES the causes, by driving the real entrypoint with a stubbed `maw`.
//
// CRUCIAL: the stubs mirror what the REAL binaries do (captured live), not what
// the parser wants. maw-rs exits NON-ZERO with a git error when the cwd is not a
// repo — an earlier fixture returned exit 0, which maw-rs never does, so the gate
// passed while branch (b) regressed. This test only earns its keep because case
// (b) reproduces the real maw-rs failure string.
//
//   (a) wrong maw on PATH (no `worktree`)      → blame the binary, name the path
//   (b) real maw-rs, cwd not a repo (rc!=0)    → blame the cwd
//   (c) some other non-zero failure            → guess NEITHER; show both
//   (d) clean exit, no repo row                → blame the cwd

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, "..", "index.ts");

let root: string;
let repo: string;

async function stubMaw(name: string, body: string) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "maw"), `#!/usr/bin/env bash\n${body}\n`);
  await chmod(join(dir, "maw"), 0o755);
  return dir;
}

async function runStatus(binDir: string) {
  const proc = Bun.spawn({
    cmd: ["bun", indexPath, "status"],
    cwd: repo,
    env: { ...process.env, PWD: repo, PATH: `${binDir}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const text =
    (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  await proc.exited;
  return text;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "crew-labroot-"));
  repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("(a) wrong maw on PATH → blames the binary, names the path, not the cwd", async () => {
  // maw-js shape: no `worktree` verb → non-zero, "unknown command" on stderr.
  const bin = await stubMaw("bin-wrongmaw", `if [ "$1" = "worktree" ]; then echo "unknown command: worktree" >&2; exit 1; fi\nexit 0`);
  const out = await runStatus(bin);
  expect(out).toContain("does not support 'worktree'");
  expect(out).toContain(join(bin, "maw"));
  expect(out).not.toContain("not inside a maw-visible repository");
});

test("(b) real maw-rs, cwd not a repo → blames the cwd, not the binary", async () => {
  // EXACT real maw-rs output when cwd is not a git repo (captured live): rc=1,
  // git error on stderr, NO "unknown command".
  const bin = await stubMaw(
    "bin-norepo",
    `if [ "$1" = "worktree" ] && [ "$2" = "ls" ]; then echo "worktree: git failed: fatal: not a git repository (or any of the parent directories): .git" >&2; exit 1; fi\nexit 0`,
  );
  const out = await runStatus(bin);
  expect(out).toContain("not inside a maw-visible repository");
  expect(out).not.toContain("does not support 'worktree'"); // the regression this test guards
});

test("(c) some other non-zero failure → guesses NEITHER cause, shows both", async () => {
  const bin = await stubMaw("bin-weird", `if [ "$1" = "worktree" ]; then echo "worktree: internal explosion 42" >&2; exit 3; fi\nexit 0`);
  const out = await runStatus(bin);
  expect(out).toContain("failed (exit 3)");
  expect(out).toContain("internal explosion 42");
  // must not falsely pin it on either the binary or the cwd
  expect(out).not.toContain("does not support 'worktree'");
  expect(out).not.toContain("not inside a maw-visible repository");
});

test("(d) clean exit but no repo row → blames the cwd", async () => {
  const bin = await stubMaw("bin-emptyok", `if [ "$1" = "worktree" ] && [ "$2" = "ls" ]; then printf 'ROOT\\tBRANCH\\n'; fi\nexit 0`);
  const out = await runStatus(bin);
  expect(out).toContain("not inside a maw-visible repository");
  expect(out).not.toContain("does not support 'worktree'");
});
