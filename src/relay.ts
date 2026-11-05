

import { appendFileSync } from "node:fs";

const DEFAULT_TUNING = {

  retryWindowMs: 45000,

  firstWindowMs: 12000,
  backoffMs: 300,
  backoffMaxMs: 3000,
  readTimeoutMs: 15000,
};

export type RelayTuning = typeof DEFAULT_TUNING;

export const RELAY_VERSION = "relay-3";
// bump with every behavior change, so a log line names the code

export function announceRelay(tuning: Partial<RelayTuning> = {}): void {
  const t = { ...DEFAULT_TUNING, ...tuning };
  logRelay(
    `start ${RELAY_VERSION} window=${t.retryWindowMs} first=${t.firstWindowMs} backoff=${t.backoffMs}-${t.backoffMaxMs} read=${t.readTimeoutMs}`,
  );
}
const RELAY_LOG = "/tmp/tapes-relay.log";

function logRelay(message: string): void {
  try {
    appendFileSync(RELAY_LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging must never break playback
  }
}
const MAX_TRACK_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_BYTES = 96 * 1024 * 1024;

interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

interface Upstream {
  reader: ChunkReader;
  status: number;
  headers: Headers;
}

interface CachedTrack {
  chunks: Uint8Array[];
  len: number;
  complete: boolean;

  total: number | null;
}

export class TrackCache {
  private tracks = new Map<string, CachedTrack>();
  private bytes = 0;

  get(url: string): CachedTrack | undefined {
    const found = this.tracks.get(url);
    if (found) {
      this.tracks.delete(url);
      this.tracks.set(url, found);
    }
    return found;
  }

  entry(url: string): CachedTrack {
    let found = this.get(url);
    if (!found) {
      found = { chunks: [], len: 0, complete: false, total: null };
      this.tracks.set(url, found);
    }
    return found;
  }

  reset(url: string, total: number): boolean {
    const found = this.tracks.get(url);
    if (!found) return false;
    if (found.total === total) return false;
    this.bytes -= found.len;
    this.tracks.set(url, { chunks: [], len: 0, complete: false, total });
    return true;
  }

  adopt(url: string, total: number): void {
    const found = this.tracks.get(url);
    if (found && found.total === null) found.total = total;
  }

  append(url: string, chunk: Uint8Array, offset: number): void {
    const found = this.tracks.get(url);
    if (!found || found.complete || found.len >= MAX_TRACK_BYTES) return;

    if (offset > found.len) return;
    const fresh = offset + chunk.length - found.len;
    if (fresh <= 0) return;
    const part = chunk.slice(chunk.length - fresh);
    found.chunks.push(part);
    found.len += part.length;
    this.bytes += part.length;
    for (const [key, track] of this.tracks) {
      if (this.bytes <= MAX_CACHE_BYTES) break;
      this.tracks.delete(key);
      this.bytes -= track.len;
    }
  }

  finish(url: string): void {
    const found = this.tracks.get(url);
    if (found && found.total !== null && found.len === found.total) found.complete = true;
  }

  get sizeBytes(): number {
    return this.bytes;
  }
}

function adapt(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> }): ChunkReader {
  return {
    read: () => reader.read(),
    cancel: (reason?: unknown) => reader.cancel(reason),
  };
}

export class StreamRelay {
  readonly url: string;
  private server: ReturnType<typeof Bun.serve>;
  private upstream: string;
  private cookie: string;
  private cache: TrackCache;
  private closed = false;
  private tuning: RelayTuning;
  private seq = 0;

  constructor(upstream: string, cookie: string, cache: TrackCache, tuning: Partial<RelayTuning> = {}) {
    this.tuning = { ...DEFAULT_TUNING, ...tuning };
    this.upstream = upstream;
    this.cookie = cookie;
    this.cache = cache;
    this.server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (req) => this.handle(req) });
    this.url = `http://127.0.0.1:${this.server.port}/play`;
  }

  close(): void {
    this.closed = true;
    this.server.stop(true);
  }

  private async handle(playerReq: Request, restarts = 0): Promise<Response> {
    const wanted = playerReq.headers.get("range");
    const parsed = parseRange(wanted);

    if (parsed.kind !== "open" && parsed.kind !== "none") {
      return this.passthrough(wanted);
    }
    const base = parsed.kind === "open" ? parsed.start : 0;
    const cached = this.cache.entry(this.upstream);
    this.seq += 1;
    const id = this.seq;
    if (cached.complete && base < cached.len) {
      logRelay(`req ${id} range=${wanted ?? "-"} answered from cache len=${cached.len}`);
      return cacheResponse(cached, base, wanted !== null);
    }
    const serveFrom = base < cached.len ? cached.len : base;
    const firstRange = serveFrom > base ? `bytes=${serveFrom}-` : wanted;
    const opened = await this.openWithRetry(firstRange, this.tuning.firstWindowMs, "open");
    if (!opened) {
      logRelay(`req ${id} range=${wanted ?? "-"} answered 502 to the player`);
      return new Response("the music server is not answering", {
        status: 502,
        headers: { connection: "close" },
      });
    }
    logRelay(`req ${id} range=${wanted ?? "-"} serving from ${serveFrom} cached=${cached.len} upstream=${opened.status}`);
    let total = rangeTotal(opened.headers.get("content-range"), opened.status, opened.headers.get("content-length"));
    if (opened.status === 200 && serveFrom > base) {
   // stupid shit
      opened.reader.cancel().catch(() => {});
      logRelay(`req ${id} ranged request answered 200, failing`);
      return new Response("the music server is not answering", {
        status: 502,
        headers: { connection: "close" },
      });
    }

    if (opened.status === 206 && total !== null) {
      // one total per track: a new one means the bytes shifted, drop them
      if (cached.total === null) {
        cached.total = total;
      } else if (cached.total !== total && restarts < 2) {
        logRelay(`req ${id} space change ${cached.total} -> ${total}, dropping cache`);
        this.cache.reset(this.upstream, total);
        opened.reader.cancel().catch(() => {});
        return this.handle(playerReq, restarts + 1);
      }
    }
    let cacheable = opened.status === 206 && total !== null && cached.total === total;
    let reader = opened.reader;
    let abs = base;
    let dead = false;
    let ended = false;
    let stalled = 0;

    const noteEnd = (why: string): void => {
      if (ended) return;
      ended = true;
      logRelay(`req ${id} ${why} at ${abs}${total !== null ? ` of ${total}` : ""}`);
    };
    const relay = this;
    const prefix = cachedSlice(cached, base, serveFrom);
    const body = new ReadableStream({
      async start(controller) {
        for (const chunk of prefix) {
          controller.enqueue(chunk);
          abs += chunk.length;
        }
        if (total !== null && abs >= total) {
          controller.close();
          relay.cache.finish(relay.upstream);
        }
      },
      async pull(controller) {
        for (;;) {
          if (relay.closed || dead) {
            noteEnd("closed by relay");
            controller.close();
            return;
          }
          const piece = await readSoon(reader, relay.tuning.readTimeoutMs);
          if (dead) {
            controller.close();
            return;
          }
          if (piece && !piece.done && piece.value) {
            const chunk = piece.value;
            if (cacheable) relay.cache.append(relay.upstream, chunk, abs);
            abs += chunk.length;
            stalled = 0;
            controller.enqueue(chunk);
            if (total !== null && abs >= total) {
              noteEnd("done");
              controller.close();
              relay.cache.finish(relay.upstream);
            }
            return;
          }
          if (piece && piece.done) {
            // no total so EOF is the end, there is nothing to reask
            if (total === null || abs >= total) {
              noteEnd("done");
              controller.close();
              if (total !== null) relay.cache.finish(relay.upstream);
              return;
            }
          }

          const reopened = await relay.openWithRetry(`bytes=${abs}-`, relay.tuning.retryWindowMs, "reopen", () => dead || relay.closed);
          if (dead || relay.closed) {
            noteEnd(dead ? "player closed" : "closed by relay");
            controller.close();
            return;
          }
          if (!reopened) {
            noteEnd("gave up");
            logRelay(`give up at ${abs}: no chunk within ${relay.tuning.retryWindowMs} ms`);
            controller.error(new Error("the music server is not answering"));
            return;
          }
          if (!sameSpace(reopened, cached, abs)) {
            logRelay(`reopen at ${abs} changed space, failing`);
            reader.cancel().catch(() => {});
            controller.error(new Error("the music server is not answering"));
            return;
          }

          stalled += 1;
          // three empty answers in a row means stuck, not a boundary
          if (stalled >= 3) {
            noteEnd("gave up");
            logRelay(`give up at ${abs}: empty answers`);
            controller.error(new Error("the music server is not answering"));
            return;
          }
          const reopenedTotal = rangeTotal(reopened.headers.get("content-range"), reopened.status, reopened.headers.get("content-length"));
          if (total === null && reopenedTotal !== null) {
            total = reopenedTotal;
            if (cached.total === null) cached.total = reopenedTotal;
          }

          if (reopened.status !== 206) cacheable = false;
          reader.cancel().catch(() => {});
          reader = reopened.reader;
        }
      },
      cancel() {
        noteEnd("player closed");
        dead = true;
        reader.cancel().catch(() => {});
      },
    });
    return new Response(body, { status: wanted ? 206 : 200, headers: answerHeaders(opened.headers, base, total) });
  }

  private async openWithRetry(
    range: string | null,
    windowMs: number,
    label: string,
    aborted: () => boolean = () => this.closed,
  ): Promise<Upstream | null> {
    // later tries open fresh, a dead pooled connection must not fail twice
    const began = Date.now();
    let delay = this.tuning.backoffMs;
    for (let attempt = 1; ; attempt += 1) {
      if (aborted()) return null;
      try {
        const got = await this.open(range, attempt > 1);
        if (attempt > 1) logRelay(`${label} ${range ?? "-"} ok on try ${attempt} after ${Date.now() - began} ms`);
        return got;
      } catch (error) {
        logRelay(`${label} ${range ?? "-"} try ${attempt}: ${shortError(error)}`);
        if (Date.now() - began + delay > windowMs) return null;
        await Bun.sleep(delay);
        delay = Math.min(delay * 2, this.tuning.backoffMaxMs);
      }
    }
  }

  private async passthrough(range: string | null): Promise<Response> {
    // same retry as the main path, but the answer goes out untouched
    const began = Date.now();
    let delay = this.tuning.backoffMs;
    for (let attempt = 1; ; attempt += 1) {
      if (this.closed) break;
      const headers: Record<string, string> = { cookie: `sonum_session=${this.cookie}` };
      if (range) headers["range"] = range;
      if (attempt > 1) headers["connection"] = "close";
      try {
        const upstream = await fetch(this.upstream, attempt > 1 ? { headers, keepalive: false } : { headers });
        if (upstream.ok && upstream.body) {
          logRelay(`probe range=${range ?? "-"} answered ${upstream.status}${attempt > 1 ? ` on try ${attempt}` : ""}`);
          const pass = new Headers();
          for (const name of ["content-type", "content-range", "accept-ranges", "content-length"]) {
            const value = upstream.headers.get(name);
            if (value) pass.set(name, value);
          }
          pass.set("connection", "close");
          return new Response(upstream.body, { status: upstream.status, headers: pass });
        }
        logRelay(`probe range=${range ?? "-"} try ${attempt}: chunk answered ${upstream.status}`);
        await upstream.body?.cancel().catch(() => {});
      } catch (error) {
        logRelay(`probe range=${range ?? "-"} try ${attempt}: no answer (${shortError(error)})`);
      }
      if (Date.now() - began + delay > this.tuning.firstWindowMs) break;
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, this.tuning.backoffMaxMs);
    }
    logRelay(`probe range=${range ?? "-"} answered 502 to the player`);
    return new Response("the music server is not answering", {
      status: 502,
      headers: { connection: "close" },
    });
  }

  private async open(range: string | null, fresh = false): Promise<Upstream> {
    const headers: Record<string, string> = { cookie: `sonum_session=${this.cookie}` };
    if (range) headers["range"] = range;
    if (fresh) headers["connection"] = "close";
    let upstream: Response;
    try {
      upstream = await fetch(this.upstream, fresh ? { headers, keepalive: false } : { headers });
    } catch (error) {
      throw new Error(`no answer (${shortError(error)})`);
    }
    if (!upstream.ok || !upstream.body) {
      // a proxy 502 and an app 502 look the same without this
      const via = upstream.headers.get("via") ?? "";
      const server = upstream.headers.get("server") ?? "";
      const text = await upstream.text().catch(() => "");
      const snippet = text.replace(/\s+/g, " ").slice(0, 60);
      throw new Error(`chunk answered ${upstream.status}${server ? ` server=${server}` : ""}${via ? ` via=${via}` : ""}${snippet ? ` body="${snippet}"` : ""}`);
    }
    const pass = new Headers();
    for (const name of ["content-type", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) pass.set(name, value);
    }
    return { reader: adapt(upstream.body.getReader()), status: upstream.status, headers: pass };
  }
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 120);
}

type ParsedRange = { kind: "none" } | { kind: "open"; start: number } | { kind: "other" };

function parseRange(range: string | null): ParsedRange {
  if (range === null) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || !match[1]) return { kind: "other" };
  return { kind: "open", start: Number(match[1]) };
}

function sameSpace(reopened: Upstream, cached: { total: number | null }, abs: number): boolean {
  // a 200 restarts the file, a new total shifts it: neither continues this stream
  if (reopened.status !== 206) return abs === 0 && cached.total === null;
  const total = rangeTotal(reopened.headers.get("content-range"), reopened.status, reopened.headers.get("content-length"));
  if (total === null || cached.total === null) return true;
  return total === cached.total;
}

function answerHeaders(upstream: Headers, base: number, total: number | null): Headers {
  const headers = new Headers();
  // no keepalive. a seek-back over a dead pooled socket reads EOF as end of file
  headers.set("connection", "close");
  const type = upstream.get("content-type");
  if (type) headers.set("content-type", type);
  const ranges = upstream.get("accept-ranges");
  if (ranges) headers.set("accept-ranges", ranges);
  if (total !== null) headers.set("content-range", `bytes ${base}-${total - 1}/${total}`);
  return headers;
}

function cachedSlice(cached: { chunks: Uint8Array[]; len: number }, from: number, to: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  for (const chunk of cached.chunks) {
    const start = Math.max(0, from - at);
    const end = Math.min(chunk.length, to - at);
    if (end > start) out.push(chunk.slice(start, end));
    at += chunk.length;
    if (at >= to) break;
  }
  return out;
}

function cacheResponse(cached: { chunks: Uint8Array[]; len: number }, base: number, ranged: boolean): Response {
  const headers = new Headers({ "content-type": "audio/mpeg", "accept-ranges": "bytes", connection: "close" });
  const body = new Blob(cachedSlice(cached, base, cached.len));
  if (ranged) {
    headers.set("content-range", `bytes ${base}-${cached.len - 1}/${cached.len}`);
    return new Response(body, { status: 206, headers });
  }
  return new Response(body, { status: 200, headers });
}

function rangeTotal(contentRange: string | null, status: number, contentLength: string | null): number | null {
  const total = /\/(\d+)\s*$/.exec(contentRange ?? "")?.[1];
  if (total !== undefined) return Number(total);
  // only a 200 carries its real length, a 206 length is one chunk
  if (status === 200 && contentLength !== null && /^\d+$/.test(contentLength.trim())) {
    return Number(contentLength.trim());
  }
  return null;
}

async function readSoon(
  reader: ChunkReader,
  timeoutMs: number,
): Promise<{ done: boolean; value?: Uint8Array } | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
