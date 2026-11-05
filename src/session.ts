import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface SavedSession {
  baseUrl: string;
  cookie: string;
}

export function sessionFilePath(home: string = homedir()): string {
  const config = process.env["XDG_CONFIG_HOME"] || join(home, ".config");
  return join(config, "tapes", "session");
}

function validCookie(cookie: string): boolean {
  // alnum only, so it cannot smuggle headers
  return /^[A-Za-z0-9_-]{1,128}$/.test(cookie);
}

export function loadSessionFile(path: string): SavedSession | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const [baseUrl = "", cookie = ""] = text.split("\n");
  // a cookie belongs to the server that issued it
  if (!baseUrl || baseUrl.includes(" ") || !validCookie(cookie.trim())) return null;
  return { baseUrl, cookie: cookie.trim() };
}

export function saveSessionFile(path: string, baseUrl: string, cookie: string): void {
  if (!validCookie(cookie)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // 0600: the cookie opens the whole library
  writeFileSync(path, `${baseUrl}\n${cookie}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
  }
}

export function clearSessionFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
  }
}
