// Locks the labRoot() error-message split (crew-lab's defect: two unrelated
// failures collapsed into one misleading "not inside a maw-visible repository").
//
// A gate that only ever passes is worth nothing — so this proves the message
// DISTINGUISHES the two causes, by driving the real entrypoint with a stubbed
// `maw` on PATH:
//   (a) wrong maw on PATH (no `worktree` verb) → must say the binary is wrong,
//       name the resolved path, and NOT blame the cwd.
//   (b) right maw, cwd is not a repo → must say "not inside a maw-visible
//       repository" and NOT blame the binary.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = join(here, "..", "index.ts");

let root: string;
let repo: string;

async function stubMaw(dir: string, body: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "maw"), `#!/usr/bin/env bash\n${body}\n`);
  await chmod(join(dir, "maw"), 0o755);
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
  const binDir = join(root, "bin-wrongmaw");
  // maw-js shape: no `worktree` verb → non-zero, "unknown command" on stderr, empty stdout.
  await stubMaw(binDir, `if [ "$1" = "worktree" ]; then echo "unknown command: worktree" >&2; exit 1; fi\nexit 0`);
  const out = await runStatus(binDir);

  expect(out).toContain("does not support 'worktree'");
  expect(out).toContain(join(binDir, "maw")); // the resolved binary is named
  expect(out).not.toContain("not inside a maw-visible repository"); // must NOT misblame cwd
});

test("(b) right maw, cwd not a repo → blames the cwd, not the binary", async () => {
  const binDir = join(root, "bin-okmaw");
  // maw-rs shape: `worktree ls` exits 0 but prints only a header (no repo row).
  await stubMaw(binDir, `if [ "$1" = "worktree" ] && [ "$2" = "ls" ]; then printf 'ROOT\\tBRANCH\\n'; fi\nexit 0`);
  const out = await runStatus(binDir);

  expect(out).toContain("not inside a maw-visible repository");
  expect(out).not.toContain("does not support 'worktree'"); // must NOT misblame the binary
});
