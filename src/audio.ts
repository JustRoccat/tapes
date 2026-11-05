export interface PlayOpts {
  startSec: number;
  volume: number;
  cookie: string;
}

export interface AudioBackend {
  readonly name: string;
  readonly canSeek: boolean;
  readonly canSetVolume: boolean;
  start(url: string, opts: PlayOpts): void;
  setPaused(paused: boolean): void;
  seekAbsolute(sec: number): void;
  setVolume(volume01: number): void;
  positionSec(): Promise<number>;
  durationSec(): Promise<number>;
  running(): boolean;
  stop(): void;
  onEnded: (() => void) | null;
  exitedEarly?(): string | null;
  lastExit?(): string | null;
}

export function findPlayer(): "mpv" | "ffplay" | null {
  if (Bun.which("mpv")) return "mpv";
  if (Bun.which("ffplay")) return "ffplay";
  return null;
}

async function mpvRequest(socketPath: string, command: unknown[]): Promise<unknown> {
  return new Promise((resolve) => {
    let pending = "";
    const id = Math.floor(Math.random() * 1_000_000);
    let settled = false;
    const done = (value: unknown): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => done(null), 3000);
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify({ command, request_id: id })}\n`);
        },
        data(socket, data) {
          pending += Buffer.from(data).toString();
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            try {
              const message = JSON.parse(line) as { request_id?: number; data?: unknown; error?: string };
              if (message.request_id === id) {
                clearTimeout(timer);
                const value = message.error === "success" ? message.data : null;
                done(value);
                // done first: end() can throw and would skip the reply
                try {
                  socket.end();
                } catch {
                }
                return;
              }
            } catch {
              continue;
            }
          }
        },
        close() {
          clearTimeout(timer);
          done(null);
        },
        error() {
          clearTimeout(timer);
          done(null);
        },
      },
    }).catch(() => done(null));
  });
}

import { readFileSync } from "node:fs";
import { StreamRelay, TrackCache } from "./relay.ts";

export function summarizeMpvLog(text: string): string {
  // one line for the ui: last warnings plus mpv's own exit reason, addresses scrubbed
  const trouble: string[] = [];
  let reason = "";
  for (const raw of text.split("\n")) {
    const match = /^\[\s*[\d.]+\]\[([a-z])\]\[([a-z_/]+)\]\s*(.*)$/.exec(raw.trim());
    if (!match) continue;
    const [, level, module, message] = match as unknown as [string, string, string, string];
    const exit = /^Exiting\.\.\. \((.*)\)/.exec(message);
    if (module === "cplayer" && exit) {
      reason = exit[1] ?? "";
      continue;
    }
    if (level !== "w" && level !== "e" && level !== "f") continue;
    const line = `${module}: ${message}`.replace(/\b[a-z]+:\/\/\S+/gi, "the stream").replace(/\s+/g, " ").trim().slice(0, 46);
    if (line && !trouble.includes(line)) trouble.push(line);
  }
  const parts = [...trouble.slice(-2)];
  if (reason) parts.push(reason);
  return parts.join(" | ").slice(0, 120);
}

function readMpvLogTail(path: string): string {
  try {
    const text = readFileSync(path, "utf8");
    return summarizeMpvLog(text.slice(-4000));
  } catch {
    return "";
  }
}

export class MpvBackend implements AudioBackend {
  readonly name = "mpv";
  readonly canSeek = true;
  readonly canSetVolume = true;
  onEnded: (() => void) | null = null;
  private proc: Bun.Subprocess | null = null;
  private socketPath = `/tmp/tapes-mpv-${process.pid}.sock`;
  private logPath = `/tmp/tapes-mpv-${process.pid}.log`;
  private lastPos = 0;
  private lastDur = 0;
  private startedAt = 0;
  private stderrTail = "";
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private exitTail = "";
  private manualStop = false;
  private relay: StreamRelay | null = null;
  private cache = new TrackCache();

  start(url: string, opts: PlayOpts): void {
    this.stop();
    // a stale socket from a crash blocks the new one
    try {
      Bun.spawnSync(["rm", "-f", this.socketPath]);
    } catch {
    }
    this.relay = new StreamRelay(url, opts.cookie, this.cache);
    const args = [
      "mpv",
      "--no-video",
      "--no-terminal",

      "--no-ytdl",
      // yt-dlp grabs http urls and dies on a 401 without our cookie

      "--cache-secs=30",
      "--demuxer-max-bytes=32MiB",
      // read ahead so a slow tunnel never starves playback
      // = form only, this build rejects a bare value
      `--input-ipc-server=${this.socketPath}`,

      `--log-file=${this.logPath}`,
      "--msg-level=all=warn,cplayer=info",
    ];
    if (opts.startSec > 1) args.push(`--start=${opts.startSec}`);
    const ao = process.env["TAPES_AO"];
    // test hook: force mpv audio output
    if (ao) args.push(`--ao=${ao}`);
    args.push(this.relay.url);
    this.lastPos = opts.startSec;
    this.startedAt = Date.now();
    this.stderrTail = "";
    this.exitCode = null;
    this.exitSignal = null;
    this.exitTail = "";
    this.manualStop = false;
    this.proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
    const current = this.proc;
    const ended = current.exited.then(() => {
      this.exitCode = current.exitCode ?? null;
      this.exitSignal = (current.signalCode as string | null) ?? null;
      // a killed track must not report the next one's end
      if (this.proc === current) {
        this.proc = null;
        if (!this.manualStop) {
          this.exitTail = readMpvLogTail(this.logPath) || this.stderrTail;
        }
        this.onEnded?.();
      }
    });
    void ended;
    void (async () => {
      try {
        const stderr = this.proc?.stderr;
        if (!(stderr instanceof ReadableStream)) return;
        for await (const chunk of stderr as AsyncIterable<Uint8Array>) {
          this.stderrTail = `${this.stderrTail}${Buffer.from(chunk).toString()}`.slice(-500);
        }
      } catch {
      }
    })();
  }

  setPaused(paused: boolean): void {
    if (this.proc) void mpvRequest(this.socketPath, ["set_property", "pause", paused]);
  }

  seekAbsolute(sec: number): void {
    if (this.proc) {
      this.lastPos = sec;
      void mpvRequest(this.socketPath, ["seek", sec, "absolute"]);
    }
  }

  setVolume(volume01: number): void {
    if (this.proc) void mpvRequest(this.socketPath, ["set_property", "volume", Math.round(volume01 * 100)]);
  }

  async positionSec(): Promise<number> {
    if (!this.proc) return this.lastPos;
    const pos = await mpvRequest(this.socketPath, ["get_property", "time-pos"]);
    if (typeof pos === "number" && Number.isFinite(pos)) this.lastPos = pos;
    return this.lastPos;
  }

  async durationSec(): Promise<number> {
    if (!this.proc) return this.lastDur;
    const dur = await mpvRequest(this.socketPath, ["get_property", "duration"]);
    if (typeof dur === "number" && Number.isFinite(dur)) this.lastDur = dur;
    return this.lastDur;
  }

  exitedEarly(): string | null {
    if (this.proc || Date.now() - this.startedAt > 3000) return null;
    // exits after 3s are mid-track deaths, not startup failures
    const words = this.stderrTail.split("\n").map((line) => line.trim()).filter(Boolean);
    const tail = this.exitTail || words.slice(-2).join(" ");
    if (tail) return tail;
    return this.exitCode === null ? "mpv left at once" : `mpv left at once (exit ${this.exitCode})`;
  }

  lastExit(): string | null {
    if (this.manualStop) return null;
    const words = this.exitTail.split("\n").map((line) => line.trim()).filter(Boolean);
    const tail = words.slice(-2).join(" ");
    const how = this.exitSignal ? `signal ${this.exitSignal}` : `exit ${this.exitCode}`;
    if (this.exitCode === null && !this.exitSignal && !tail) return null;
    return tail ? `${how}: ${tail}`.slice(0, 110) : how;
  }

  running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  stop(): void {
    this.manualStop = true;
    this.relay?.close();
    this.relay = null;
    try {
      this.proc?.kill();
    } catch {
    }
    this.proc = null;
  }
}

export class FfplayBackend implements AudioBackend {
  readonly name = "ffplay";
  readonly canSeek = false;
  readonly canSetVolume = false;
  onEnded: (() => void) | null = null;
  private proc: Bun.Subprocess | null = null;
  private relay: StreamRelay | null = null;
  private cache = new TrackCache();
  private baseSec = 0;
  private startedAt = 0;
  private pausedTotal = 0;
  private pausedAt = 0;

  start(url: string, opts: PlayOpts): void {
    this.stop();
    this.relay = new StreamRelay(url, opts.cookie, this.cache);
    this.baseSec = opts.startSec;
    this.launch(opts.startSec);
  }

  private launch(fromSec: number): void {
    if (!this.relay) return;
    this.startedAt = Date.now();
    this.pausedTotal = 0;
    this.pausedAt = 0;
    this.proc = Bun.spawn(
      ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", "-ss", String(fromSec), this.relay.url],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    const current = this.proc;
    const ended = current.exited.then(() => {
      if (this.proc === current) {
        this.proc = null;
        this.onEnded?.();
      }
    });
    void ended;
  }

  setPaused(paused: boolean): void {
    if (!this.proc) return;
    try {
      if (paused && !this.pausedAt) {
        this.pausedAt = Date.now();
        // ffplay has no pause command, signals do it
        this.proc.kill(19);
      } else if (!paused && this.pausedAt) {
        this.pausedTotal += Date.now() - this.pausedAt;
        this.pausedAt = 0;
        this.proc.kill(18);
      }
    } catch {
    }
  }

  seekAbsolute(sec: number): void {
    if (!this.proc) return;
    // ffplay cannot seek, restart from the new second
    this.proc.kill();
    this.proc = null;
    this.baseSec = sec;
    this.launch(sec);
  }

  setVolume(_volume01: number): void {
  }

  async positionSec(): Promise<number> {
    if (!this.proc) return this.baseSec;
    const now = this.pausedAt || Date.now();
    return this.baseSec + (now - this.startedAt - this.pausedTotal) / 1000;
  }

  async durationSec(): Promise<number> {
    return 0;
  }

  running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  stop(): void {
    this.relay?.close();
    this.relay = null;
    try {
      this.proc?.kill();
    } catch {
    }
    this.proc = null;
  }
}

export class NullBackend implements AudioBackend {
  readonly name = "silent";
  readonly canSeek = true;
  readonly canSetVolume = true;
  onEnded: (() => void) | null = null;
  pos = 0;
  dur = 0;
  paused = true;
  started = false;

  start(_url: string, opts: PlayOpts): void {
    this.started = true;
    this.pos = opts.startSec;
    this.paused = false;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  seekAbsolute(sec: number): void {
    this.pos = sec;
  }

  setVolume(_volume01: number): void {}

  async positionSec(): Promise<number> {
    return this.pos;
  }

  async durationSec(): Promise<number> {
    return this.dur;
  }

  running(): boolean {
    return this.started;
  }

  stop(): void {
    this.started = false;
  }

  advance(sec: number): void {
    if (!this.paused) this.pos += sec;
  }
}
