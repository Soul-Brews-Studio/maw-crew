import type { InvokeContext, InvokeResult } from "maw-js/plugin/types";
import { verify, status, up, down, CrewError } from "./internal/crew";

export const command = {
  name: ["crew-lab", "crew"],
  description: "Spawn, verify, and tear down codex crews with the traps handled once.",
};

const USAGE = [
  "maw crew-lab <verb>",
  "",
  "  up <name> --pools 1,5 [--template T] [--base B]  render → worktrees → sessions → gates → spawn",
  "  verify <prefix>   prove pool isolation + model parity from ground truth (exit 1 = do not dispatch)",
  "  status [prefix]   real state from tmux (maw team status always reports idle)",
  "  down <prefix>     Nothing-is-Deleted teardown",
  "",
  "pools must be listed explicitly — slots are not contiguous.",
].join("\n");

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export default async function handler(ctx: InvokeContext): Promise<InvokeResult> {
  const argv: string[] =
    ctx.source === "cli"
      ? (ctx.args as string[])
      : ((ctx.args as Record<string, unknown>)?.argv as string[]) ?? [];

  const lines: string[] = [];
  const log = (...a: unknown[]) => {
    const s = a.map(String).join(" ");
    lines.push(s);
    ctx.writer?.(s);
  };
  const done = (ok: boolean, error?: string): InvokeResult => {
    const output = lines.join("\n");
    return ok ? { ok: true, output: output || undefined } : { ok: false, error: error ?? output, output: output || undefined };
  };

  const [verb, ...rest] = argv;
  const positional = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));

  try {
    switch (verb) {
      case "verify":
        if (!positional[0]) return done(false, "usage: maw crew-lab verify <prefix>");
        // exit non-zero on purpose — a failed verify must be able to gate a script
        return done(await verify(positional[0], log));
      case "status":
        await status(positional[0] ?? "", log);
        return done(true);
      case "up": {
        if (!positional[0]) return done(false, "usage: maw crew-lab up <name> --pools 1,5");
        const pools = (flag(rest, "--pools") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        await up(positional[0], { pools, template: flag(rest, "--template"), base: flag(rest, "--base") }, log);
        return done(true);
      }
      case "down":
        if (!positional[0]) return done(false, "usage: maw crew-lab down <prefix>");
        await down(positional[0], log);
        return done(true);
      default:
        return done(false, USAGE);
    }
  } catch (e) {
    const msg = e instanceof CrewError ? `crew-lab: ${e.message}` : String((e as Error)?.stack ?? e);
    return done(false, msg);
  }
}

// maw EXECUTES this file rather than importing it, so the default export alone
// would never run. This block is what actually serves `maw crew-lab ...`.
if (import.meta.main) {
  const res = await handler({
    source: "cli",
    args: Bun.argv.slice(2),
    cwd: process.cwd(),
    writer: (...a: unknown[]) => console.log(...a),
  } as unknown as InvokeContext);

  if (!res.ok) {
    if (res.error && res.error !== res.output) console.error(res.error);
    process.exit(1);
  }
}
