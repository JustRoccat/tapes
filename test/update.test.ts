import { describe, expect, test } from "bun:test";
import { checkForUpdate, type RunFn } from "../src/update.ts";

const sha = (n: number): string => String(n).repeat(40).slice(0, 40);

describe("auto update", () => {
  test("no git checkout means no update", async () => {
    const run: RunFn = async () => null;
    expect(await checkForUpdate("/nowhere", run)).toEqual({ kind: "skipped", reason: "no git checkout" });
  });

  test("same commit means current", async () => {
    const run: RunFn = async (_cmd: string, args: string[]) => {
      if (args.includes("rev-parse")) return { code: 0, stdout: `${sha(1)}\n`, stderr: "" };
      if (args.includes("fetch")) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    expect(await checkForUpdate("/app", run)).toEqual({ kind: "current" });
  });

  test("behind and clean pulls fast-forward", async () => {
    const calls: string[][] = [];
    const run: RunFn = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args.includes("rev-parse") && args.includes("HEAD") && !args.includes("FETCH_HEAD")) {
        return { code: 0, stdout: `${sha(1)}\n`, stderr: "" };
      }
      if (args.includes("fetch")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("FETCH_HEAD") && args.includes("rev-parse")) return { code: 0, stdout: `${sha(2)}\n`, stderr: "" };
      if (args.includes("merge-base")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("status")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("merge")) return { code: 0, stdout: "ok\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkForUpdate("/app", run);
    expect(result).toEqual({ kind: "updated", from: sha(1), to: sha(2) });
    expect(calls.some((call) => call.includes("merge"))).toBe(true);
  });

  test("dirty tree never pulls", async () => {
    const run: RunFn = async (_cmd: string, args: string[]) => {
      if (args.includes("HEAD") && !args.includes("FETCH_HEAD")) return { code: 0, stdout: `${sha(1)}\n`, stderr: "" };
      if (args.includes("fetch")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("FETCH_HEAD")) return { code: 0, stdout: `${sha(2)}\n`, stderr: "" };
      if (args.includes("merge-base")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("status")) return { code: 0, stdout: " M src/app.ts\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    expect(await checkForUpdate("/app", run)).toEqual({ kind: "skipped", reason: "local changes" });
  });

  test("diverged history never pulls", async () => {
    const run: RunFn = async (_cmd: string, args: string[]) => {
      if (args.includes("HEAD") && !args.includes("FETCH_HEAD")) return { code: 0, stdout: `${sha(1)}\n`, stderr: "" };
      if (args.includes("fetch")) return { code: 0, stdout: "", stderr: "" };
      if (args.includes("FETCH_HEAD")) return { code: 0, stdout: `${sha(2)}\n`, stderr: "" };
      if (args[0] === "merge-base") return { code: 1, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    expect(await checkForUpdate("/app", run)).toEqual({ kind: "skipped", reason: "diverged" });
  });

  test("failed fetch means offline, not broken", async () => {
    const run: RunFn = async (_cmd: string, args: string[]) => {
      if (args.includes("HEAD")) return { code: 0, stdout: `${sha(1)}\n`, stderr: "" };
      return null;
    };
    expect(await checkForUpdate("/app", run)).toEqual({ kind: "skipped", reason: "no network" });
  });
});
