import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearSessionFile, loadSessionFile, saveSessionFile, sessionFilePath } from "../src/session.ts";

describe("session file", () => {
  let dir = "";
  let path = "";
  afterEach(() => {
    if (path) clearSessionFile(path);
  });

  test("a saved session reads back for the same server", () => {
    dir = mkdtempSync(join(tmpdir(), "tapes-session-"));
    path = join(dir, "session");
    saveSessionFile(path, "https://tapes.test", "abcDEF0123_-");
    expect(loadSessionFile(path)).toEqual({ baseUrl: "https://tapes.test", cookie: "abcDEF0123_-" });
  });

  test("a cookie from another server is ignored", () => {
    dir = mkdtempSync(join(tmpdir(), "tapes-session-"));
    path = join(dir, "session");
    saveSessionFile(path, "https://tapes.test", "abc123");
    const saved = loadSessionFile(path);
    expect(saved?.baseUrl === "https://other.test" ? saved : null).toBeNull();
  });

  test("a broken file reads as nothing", () => {
    dir = mkdtempSync(join(tmpdir(), "tapes-session-"));
    path = join(dir, "session");
    writeFileSync(path, "Cookie: injected\r\n-header: x");
    expect(loadSessionFile(path)).toBeNull();
    expect(loadSessionFile(path)).toBeNull();
  });

  test("a missing file reads as nothing and clears quietly", () => {
    path = join(tmpdir(), "tapes-no-such-session-file");
    expect(loadSessionFile(path)).toBeNull();
    clearSessionFile(path);
  });

  test("the file is readable only by its owner", () => {
    dir = mkdtempSync(join(tmpdir(), "tapes-session-"));
    path = join(dir, "nested", "session");
    saveSessionFile(path, "https://tapes.test", "abc123");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadSessionFile(path)?.cookie).toBe("abc123");
  });

  test("keys and junk never reach the disk", () => {
    dir = mkdtempSync(join(tmpdir(), "tapes-session-"));
    path = join(dir, "session");
    saveSessionFile(path, "https://tapes.test", "not a cookie!!!");
    saveSessionFile(path, "", "abc123");
    expect(loadSessionFile(path)).toBeNull();
  });

  test("the default path lives under the user config dir", () => {
    expect(sessionFilePath("/home/listener")).toBe("/home/listener/.config/tapes/session");
  });
});
