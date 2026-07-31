import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";

export const command = {
  name: ["crew-lab", "crew"],
  description: "Spawn, verify, and tear down codex crews with the traps handled once.",
};

const VERBS = ["up", "verify", "status", "down"];
const USAGE = [
  "maw crew-lab <verb>",
  "",
  "  up <name> --pools 1,5 [--template T] [--base B]  render → worktrees → sessions → gates → spawn",
  "  verify <name>   prove pool isolation + model parity from ground truth (exit 1 = do not dispatch)",
  "  status [name]   real state from tmux (maw team status always reports idle)",
  "  down <name>     Nothing-is-Deleted teardown",
  "",
  "pools must be listed explicitly — slots are not contiguous.",
].join("\n");

// The work is shell: git worktrees, tmux, maw verbs, charter yaml. Keeping it in
// one tested script means the plugin surface and a direct ./crew-core.sh call
// cannot drift apart.
const CORE = new URL("./internal/crew-core.sh", import.meta.url).pathname;

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const argv: string[] =
    ctx.source === "cli"
      ? (ctx.args as string[])
      : ((ctx.args as Record<string, unknown>)?.argv as string[]) ?? [];

  const verb = argv[0];
  if (!verb || !VERBS.includes(verb)) {
    return { ok: false, error: USAGE };
  }

  const proc = Bun.spawn(["bash", CORE, ...argv], {
    cwd: ctx.cwd ?? process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const output = [out, err].filter((s) => s.trim()).join("\n").trimEnd();
  if (ctx.writer && output) ctx.writer(output);

  // verify exits non-zero on purpose — surface that, never swallow it
  return code === 0
    ? { ok: true, output: output || undefined }
    : { ok: false, error: output || `crew-lab ${verb} exited ${code}`, output: output || undefined };
}

// maw EXECUTES this file rather than importing it, so the default export alone
// is never called. This block is what actually runs under `maw crew-lab ...`.
if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const res = await handler({
    source: "cli",
    args: argv,
    cwd: process.cwd(),
    writer: (...a: unknown[]) => console.log(...a),
  } as unknown as InvokeContext);

  if (!res.ok) {
    // writer already printed captured output; only add what it did not carry
    if (res.error && res.error !== res.output) console.error(res.error);
    process.exit(1);
  }
}
