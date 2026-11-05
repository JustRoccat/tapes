#!/usr/bin/env bun
import { ApiClient, ApiError } from "./api.ts";
import { FfplayBackend, MpvBackend, NullBackend, findPlayer, type AudioBackend } from "./audio.ts";
import { runApp } from "./app.ts";
import { clearSessionFile, loadSessionFile, saveSessionFile, sessionFilePath } from "./session.ts";
import { announceRelay } from "./relay.ts";

const SERVER = "https://debian.tailada905.ts.net:8443";
// one fixed address, if u change it ur fucked cause theres no other tapes server c:
function ask(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const input = process.stdin;
    input.setEncoding("utf8");
    if (hidden) {
      input.setRawMode(true);
    } else {
      input.resume();
    }
    let answer = "";
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === "\n" || char === "\r" || char === "\u0004") {
          cleanup();
          process.stdout.write("\n");
          resolve(answer);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          process.exit(0);
        }
        if (char === "\u007f") {
          answer = answer.slice(0, -1);
          continue;
        }
        answer += char;
      }
    };
    const cleanup = (): void => {
      input.removeListener("data", onData);
      if (hidden && input.isTTY) input.setRawMode(false);
      input.pause();
    };
    input.on("data", onData);
  });
}

async function signIn(api: ApiClient): Promise<string> {
  for (;;) {
    const key = process.env["TAPES_KEY"] || (await ask("Access key: ", true));
    if (!key) throw new Error("Enter your access key.");
    try {
      const { account } = await api.login(key);
      return account.name;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        if (process.env["TAPES_KEY"]) throw new Error("That access key is not valid.");
        process.stdout.write(`${error.message} Try again.\n`);
        continue;
      }
      throw error;
    }
  }
}

async function firstRun(api: ApiClient): Promise<string> {
  const name = (process.env["TAPES_NAME"] || (await ask("Your name: ", false))).trim();
  if (!name) throw new Error("Enter a name.");
  const key = process.env["TAPES_KEY"] || (await ask("Pick an access key (12 chars or more): ", true));
  if (key.length < 12) throw new Error("The key needs at least 12 characters.");
  await api.setupOwner(name, key);
  const { account } = await api.login(key);
  return account.name;
}

function backendFor(kind: string): AudioBackend {
  if (kind === "mpv") return new MpvBackend();
  if (kind === "ffplay") return new FfplayBackend();
  return new NullBackend();
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write("tapes\nTAPES_KEY sets the key without typing. TAPES_SERVER overrides the address.\n");
    return;
  }
  announceRelay();
  const baseUrl = (process.env["TAPES_SERVER"] ?? SERVER).trim().replace(/\/+$/, "");
  const api = new ApiClient(baseUrl);
  let ready = false;
  try {
    ready = (await api.setup()).ready;
  } catch (error) {
    if (error instanceof ApiError) throw new Error(error.message);
    throw new Error("The music server is not answering. Check the address.");
  }
  const player = findPlayer();
  if (!player) {
    process.stdout.write("Sound is off: neither mpv nor ffplay is here. Browsing still works.\n");
  }

  const sessionPath = sessionFilePath();
  let accountName: string | null = null;
  // the session cookie persists
  if (!process.env["TAPES_KEY"]) {
    const saved = loadSessionFile(sessionPath);
    if (saved && saved.baseUrl === baseUrl) {
      api.setSessionCookie(saved.cookie);
      try {
        accountName = (await api.session()).account.name;
      } catch {
        clearSessionFile(sessionPath);
      }
    }
  }
  if (!accountName) {
    accountName = ready ? await signIn(api) : await firstRun(api);
    if (api.sessionCookie) saveSessionFile(sessionPath, baseUrl, api.sessionCookie);
  }
  const audio = backendFor(player ?? "silent");
  for (;;) {
    const outcome = await runApp({ api, audio, accountName });
    if (outcome === "quit") return;
    await signIn(api);
    if (api.sessionCookie) saveSessionFile(sessionPath, baseUrl, api.sessionCookie);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "The request failed. Try again.";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
