import { describe, expect, test } from "bun:test";
import { summarizeMpvLog } from "../src/audio.ts";

describe("mpv log summary", () => {
  test("a refused stream names the status and drops the address", () => {
    const log = [
      "[  0.026][v][ffmpeg] Opening http://127.0.0.1:4000/play",
      "[ 10.538][w][ffmpeg] http: HTTP error 502 Bad Gateway",
      "[ 10.538][e][stream] Failed to open http://127.0.0.1:4000/play.",
      "[ 10.538][i][cplayer] Exiting... (Errors when loading file)",
      "[ 10.539][d][osc] Exiting...",
    ].join("\n");
    const out = summarizeMpvLog(log);
    expect(out).toContain("HTTP error 502 Bad Gateway");
    expect(out).toContain("Errors when loading file");
    expect(out).not.toContain("127.0.0.1");
    expect(out).not.toContain("osc");
    expect(out.length).toBeLessThanOrEqual(120);
  });

  test("a lost audio device is named", () => {
    const log = [
      "[  0.036][e][ao] Failed to initialize audio driver 'invented'",
      "[  0.036][e][cplayer] Could not open/initialize audio device -> no sound.",
      "[  0.037][i][cplayer] Exiting... (Errors when loading file)",
    ].join("\n");
    expect(summarizeMpvLog(log)).toContain("ao: Failed to initialize audio driver");
  });

  test("a clean end shows only the exit reason", () => {
    expect(summarizeMpvLog("[ 5.0][d][ffmpeg] AVIOContext: Statistics\n[ 5.1][i][cplayer] Exiting... (End of file)")).toBe("End of file");
  });

  test("an empty or unreadable log gives an empty summary", () => {
    expect(summarizeMpvLog("")).toBe("");
    expect(summarizeMpvLog("garbage without brackets")).toBe("");
  });
});
