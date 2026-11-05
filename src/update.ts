export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunFn = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult | null>;

export type UpdateStatus =
  | { kind: "current" }
  | { kind: "updated"; from: string; to: string }
  | { kind: "skipped"; reason: string };

const FETCH_TIMEOUT_MS = 8000;

async function runGit(cmd: string, args: string[], timeoutMs: number): Promise<RunResult | null> {
  try {
    if (!Bun.which("git")) return null;
    const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, timeoutMs);
    const [, stdout, stderr] = await Promise.all([
      proc.exited,
      Bun.readableStreamToText(proc.stdout),
      Bun.readableStreamToText(proc.stderr),
    ]);
    clearTimeout(timer);
    return { code: proc.exitCode ?? 1, stdout, stderr };
  } catch {
    return null;
  }
}

// fast-forward only: never merge, never touch a dirty tree
export async function checkForUpdate(root: string, run: RunFn = runGit): Promise<UpdateStatus> {
  const head = await run("git", ["-C", root, "rev-parse", "HEAD"], FETCH_TIMEOUT_MS);
  if (!head || head.code !== 0) return { kind: "skipped", reason: "no git checkout" };
  const fetched = await run("git", ["-C", root, "fetch", "origin", "main"], FETCH_TIMEOUT_MS);
  if (!fetched || fetched.code !== 0) return { kind: "skipped", reason: "no network" };
  const remote = await run("git", ["-C", root, "rev-parse", "FETCH_HEAD"], FETCH_TIMEOUT_MS);
  if (!remote || remote.code !== 0) return { kind: "skipped", reason: "no upstream" };
  const local = head.stdout.trim();
  const upstream = remote.stdout.trim();
  if (local === upstream || !local || !upstream) return { kind: "current" };
  const base = await run("git", ["-C", root, "merge-base", "--is-ancestor", local, upstream], FETCH_TIMEOUT_MS);
  if (!base || base.code !== 0) return { kind: "skipped", reason: "diverged" };
  const status = await run("git", ["-C", root, "status", "--porcelain"], FETCH_TIMEOUT_MS);
  if (!status || status.code !== 0 || status.stdout.trim() !== "") return { kind: "skipped", reason: "local changes" };
  const merged = await run("git", ["-C", root, "merge", "--ff-only", "FETCH_HEAD"], FETCH_TIMEOUT_MS);
  if (!merged || merged.code !== 0) return { kind: "skipped", reason: "merge failed" };
  return { kind: "updated", from: local, to: upstream };
}
