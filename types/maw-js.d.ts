// Ambient types for the host-provided `maw-js` SDK surface.
//
// maw (maw-rs) executes this plugin and injects the InvokeContext at runtime, so
// `maw-js` is a TYPE-ONLY import — never a package dependency. Vendoring just the
// two shapes this plugin touches keeps the repo portable: anyone can `bun install`,
// typecheck, and run without a maw-js checkout on their machine. Kept in sync with
// maw-js `src/plugin/types.ts` (InvokeContext / InvokeResult).
declare module "maw-js/plugin/types" {
  export interface InvokeContext {
    source: "cli" | "api" | "peer";
    args: string[] | Record<string, unknown>;
    /** CLI surface (canonical or alias) that matched this invocation. */
    matchedName?: string;
    /** Output writer injected for CLI source; undefined for api/peer. */
    writer?: (...args: unknown[]) => void;
  }
  export interface InvokeResult {
    ok: boolean;
    output?: string;
    error?: string;
    /** Non-zero exit code for `ok: false`; CLI defaults to 1 when unset. */
    exitCode?: number;
  }
}
