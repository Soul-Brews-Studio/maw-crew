// Locks the cwd fix (commit 75df1c4, issue maw-rs#752).
//
// The bug: maw EXECUTES the entry file, so `process.cwd()` is the plugin dir,
// not where the user invoked. `labRoot()` must anchor to `$PWD` instead. This
// test runs the REAL entrypoint (`bun index.ts status`) from a foreign cwd —
// testing the function directly would miss the very bug, because the bug lives
// in how the host sets cwd/env (see test/README or the retro: "testing the
// function != testing the plugin").
//
// CI has no real maw/tmux, so we stub both on PATH. The stub `maw worktree ls`
// reports its OWN working directory as the repo root — which is exactly how real
// maw behaves (it resolves the repo from cwd). That makes the test sensitive to
// the one thing under test: which directory `labRoot` runs `maw worktree ls` in.
//
//   A = process.cwd() (the "plugin dir")   → holds charter MARKER-aplugin
//   B = $PWD          (the user's repo)     → holds charter MARKER-buser
//
// Fixed code anchors to B → sees MARKER-buser, never MARKER-aplugin.
// Pre-fix code anchored to A → would see MARKER-aplugin. Both directions asserted.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, "..", "index.ts");

let root: string;
let pluginDir: string; // A — simulates process.cwd()
let userRepo: string; // B — simulates $PWD
let fakeBin: string;

const charter = (name: string) =>
  `name: ${name}\nsession: ${name.replace(/[^a-z0-9]/gi, "")}\nmembers:\n  - role: lead\n    name: x\n`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "crew-cwd-smoke-"));
  pluginDir = join(root, "plugin-dir");
  userRepo = join(root, "user-repo");
  fakeBin = join(root, "bin");

  for (const d of [pluginDir, userRepo, fakeBin]) await mkdir(d, { recursive: true });
  await mkdir(join(pluginDir, "ψ/teams"), { recursive: true });
  await mkdir(join(userRepo, "ψ/teams"), { recursive: true });

  await writeFile(join(pluginDir, "ψ/teams/MARKER-aplugin.yaml"), charter("MARKER-aplugin"));
  await writeFile(join(userRepo, "ψ/teams/MARKER-buser.yaml"), charter("MARKER-buser"));

  // Stub `maw`: `worktree ls` prints a header then "<cwd>\tmain" — real maw
  // resolves the repo root from the directory it runs in, and so does this.
  const mawStub = `#!/usr/bin/env bash
if [ "$1" = "worktree" ] && [ "$2" = "ls" ]; then
  printf 'ROOT\\tBRANCH\\n'
  printf '%s\\tmain\\n' "$(pwd)"
fi
exit 0
`;
  // Stub `tmux`: no session exists → status reports "down" without needing tmux.
  const tmuxStub = `#!/usr/bin/env bash\nexit 1\n`;

  await writeFile(join(fakeBin, "maw"), mawStub);
  await writeFile(join(fakeBin, "tmux"), tmuxStub);
  await chmod(join(fakeBin, "maw"), 0o755);
  await chmod(join(fakeBin, "tmux"), 0o755);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("status resolves the repo from $PWD, not the plugin's process.cwd()", async () => {
  // Bun.spawn (not Bun.$) — the $ shell forces PWD to match .cwd(), which would
  // erase the very split this test needs. maw executes the plugin with cwd = the
  // plugin dir while $PWD stays the user's shell dir; spawn lets us set both.
  const proc = Bun.spawn({
    cmd: ["bun", indexPath, "status", "MARKER"],
    cwd: pluginDir, // process.cwd() == plugin dir (the pre-fix anchor)
    env: { ...process.env, PWD: userRepo, PATH: `${fakeBin}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const text =
    (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  await proc.exited;

  // Anchored to $PWD (user repo B) → sees B's charter…
  expect(text).toContain("MARKER-buser");
  // …and never the plugin-dir charter A (the pre-fix bug would show this).
  expect(text).not.toContain("MARKER-aplugin");
});
