import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RELAY_VERSION, StreamRelay, TrackCache, announceRelay } from "../src/relay.ts";

const BYTES = 1_400_000;
const body = new Uint8Array(BYTES).map((_, i) => i % 251);
const FAST = { backoffMs: 20, backoffMaxMs: 100, firstWindowMs: 300, retryWindowMs: 10000 };
// keeps the time-based tests under a second

function chunked(failures: Map<number, number>, seenCookies: string[], seenRanges: string[] = []) {
  return Bun.serve({
    port: 0,
    fetch(request) {
      seenCookies.push(request.headers.get("cookie") ?? "");
      const rangeHeader = request.headers.get("range") ?? "";
      seenRanges.push(rangeHeader);
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/stream")) return new Response("no", { status: 404 });
      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      const start = match?.[1] ? Number(match[1]) : 0;
      const failLeft = failures.get(start) ?? 0;
      if (failLeft > 0) {
        failures.set(start, failLeft - 1);
        return new Response("gone", { status: 502 });
      }
      const end = Math.min(match?.[2] ? Number(match[2]) : BYTES - 1, start + 524287, BYTES - 1);
      return new Response(body.slice(start, end + 1), {
        status: 206,
        headers: {
          "content-type": "audio/mpeg",
          "content-range": `bytes ${start}-${end}/${BYTES}`,
        },
      });
    },
  });
}

describe("relay", () => {
  test("it joins chunks into one stream", async () => {
    const cookies: string[] = [];
    const upstream = chunked(new Map(), cookies);
    const relay = new StreamRelay(`http://127.0.0.1:${upstream.port}/stream`, "relay-cookie", new TrackCache());
    const response = await fetch(relay.url);
    const out = new Uint8Array(await response.arrayBuffer());
    relay.close();
    upstream.stop(true);
    expect(out).toEqual(body);
    expect(response.headers.get("connection")).toBe("close");
    expect(cookies.every((cookie) => cookie === "sonum_session=relay-cookie")).toBe(true);
  });

  test("it re-asks a chunk that fails", async () => {
    const cookies: string[] = [];
    const upstream = chunked(new Map([[524288, 2]]), cookies);
    const relay = new StreamRelay(`http://127.0.0.1:${upstream.port}/stream`, "relay-cookie", new TrackCache());
    const out = new Uint8Array(await (await fetch(relay.url, { headers: { range: "bytes=0-" } })).arrayBuffer());
    relay.close();
    upstream.stop(true);
    expect(out).toEqual(body);
  });

  test("it answers 502 when the server stays down", async () => {
    const cookies: string[] = [];
    const upstream = chunked(new Map([[0, 99]]), cookies);
    const relay = new StreamRelay(`http://127.0.0.1:${upstream.port}/stream`, "relay-cookie", new TrackCache(), FAST);
    const response = await fetch(relay.url);
    relay.close();
    upstream.stop(true);
    expect(response.status).toBe(502);
  });

  test("a replayed track comes from the cache", async () => {
    const seen: string[] = [];
    const cookies: string[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        cookies.push(request.headers.get("cookie") ?? "");
        seen.push(request.headers.get("range") ?? "");
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
        const start = match?.[1] ? Number(match[1]) : 0;
        const end = Math.min(match?.[2] ? Number(match[2]) : BYTES - 1, start + 524287, BYTES - 1);
        return new Response(body.slice(start, end + 1), {
          status: 206,
          headers: { "content-type": "audio/mpeg", "content-range": `bytes ${start}-${end}/${BYTES}` },
        });
      },
    });
    const cache = new TrackCache();
    const relay = new StreamRelay(`http://127.0.0.1:${upstream.port}/stream`, "relay-cookie", cache);
    const first = new Uint8Array(await (await fetch(relay.url)).arrayBuffer());
    const hitsAfterFirst = seen.length;
    const second = new Uint8Array(await (await fetch(relay.url)).arrayBuffer());
    relay.close();
    upstream.stop(true);
    expect(first).toEqual(body);
    expect(second).toEqual(body);
    expect(seen.length).toBe(hitsAfterFirst);
    expect(cache.sizeBytes).toBe(BYTES);
  });

  test("a resumed fetch continues from cached bytes", async () => {    const seen: string[] = [];
    const cookies: string[] = [];
    const upstream = chunked(new Map(), cookies, seen);
    const cache = new TrackCache();
    const relay = new StreamRelay(`http://127.0.0.1:${upstream.port}/stream`, "relay-cookie", cache);
    const reader = (await fetch(relay.url)).body?.getReader();
    let taken = 0;
    if (reader) {
      for (;;) {
        const piece = await reader.read();
        if (piece.done) break;
        taken += piece.value.length;
        if (taken >= 600000) {
          await reader.cancel();
          break;
        }
      }
    }
    const full = new Uint8Array(await (await fetch(relay.url)).arrayBuffer());
    relay.close();
    upstream.stop(true);
    expect(full).toEqual(body);
    expect(seen.some((range) => range !== "bytes=0-" && range !== "")).toBe(true);
  });

  test("a suffix probe goes through untouched", async () => {
    const cookies: string[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        cookies.push(request.headers.get("cookie") ?? "");
        const match = /^bytes=-(\d+)$/.exec(request.headers.get("range") ?? "");
        if (!match?.[1]) return new Response("bad", { status: 400 });
        const start = BYTES - Number(match[1]);
        return new Response(body.slice(start), {
          status: 206,
          headers: { "content-type": "audio/mpeg", "content-range": `bytes ${start}-${BYTES - 1}/${BYTES}` },
        });
      },
    });
    const cache = new TrackCache();
    const relay = new StreamRelay(`http://127.0.0.1:${upstream.port}/stream`, "relay-cookie", cache);
    const response = await fetch(relay.url, { headers: { range: "bytes=-500" } });
    const out = new Uint8Array(await response.arrayBuffer());
    relay.close();
    upstream.stop(true);
    expect(response.status).toBe(206);
    expect(out).toEqual(body.slice(BYTES - 500));
    expect(cache.sizeBytes).toBe(0);
  });

  test("a failure wave longer than two seconds does not end the stream", async () => {
    const waveEnds = Date.now() + 3200;
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
        const start = match?.[1] ? Number(match[1]) : 0;
        if (start >= 524288 && Date.now() < waveEnds) return new Response("bad gateway", { status: 502 });
        const end = Math.min(start + 524287, BYTES - 1);
        return new Response(body.slice(start, end + 1), {
          status: 206,
          headers: { "content-type": "audio/mpeg", "content-range": `bytes ${start}-${end}/${BYTES}` },
        });
      },
    });
    const relay = new StreamRelay(`http://127.0.0.1:${upstream.port}/stream`, "relay-cookie", new TrackCache(), {
      backoffMs: 100,
      backoffMaxMs: 400,
    });
    const out = new Uint8Array(await (await fetch(relay.url, { headers: { range: "bytes=0-" } })).arrayBuffer());
    relay.close();
    upstream.stop(true);
    expect(out).toEqual(body);
  }, 20000);

  test("normal chunk boundaries do not use up the retry budget", async () => {
    const size = 4_200_000;
    const big = new Uint8Array(size).map((_, i) => i % 241);
    let hits = 0;
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        hits += 1;
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
        const start = match?.[1] ? Number(match[1]) : 0;
        const end = Math.min(start + 524287, size - 1);
        return new Response(big.slice(start, end + 1), {
          status: 206,
          headers: { "content-type": "audio/mpeg", "content-range": `bytes ${start}-${end}/${size}` },
        });
      },
    });
    const relay = new StreamRelay(`http://127.0.0.1:${upstream.port}/stream`, "relay-cookie", new TrackCache());
    const out = new Uint8Array(await (await fetch(relay.url, { headers: { range: "bytes=0-" } })).arrayBuffer());
    relay.close();
    upstream.stop(true);
    expect(hits).toBe(9);
    expect(out).toEqual(big);
  });

  test("a retry opens a fresh connection", async () => {
    const connections: string[] = [];
    const failures = new Map([[524288, 1]]);
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
        const start = match?.[1] ? Number(match[1]) : 0;
        connections.push(`${start}:${request.headers.get("connection") ?? "none"}`);
        if ((failures.get(start) ?? 0) > 0) {
          failures.set(start, 0);
          return new Response("bad gateway", { status: 502 });
        }
        const end = Math.min(start + 524287, BYTES - 1);
        return new Response(body.slice(start, end + 1), {
          status: 206,
          headers: { "content-type": "audio/mpeg", "content-range": `bytes ${start}-${end}/${BYTES}` },
        });
      },
    });
    const relay = new StreamRelay(`http://127.0.0.1:${upstream.port}/stream`, "relay-cookie", new TrackCache(), FAST);
    const out = new Uint8Array(await (await fetch(relay.url, { headers: { range: "bytes=0-" } })).arrayBuffer());
    relay.close();
    upstream.stop(true);
    expect(out).toEqual(body);
    const second = connections.filter((entry) => entry.startsWith("524288:"));
    expect(second[0]).not.toBe("524288:close");
    expect(second[1]).toBe("524288:close");
  });

  test("it ends the stream with an error once the window runs out", async () => {    const cookies: string[] = [];
    const upstream = chunked(new Map([[524288, 999]]), cookies);
    const relay = new StreamRelay(`http://127.0.0.1:${upstream.port}/stream`, "relay-cookie", new TrackCache(), {
      ...FAST,
      retryWindowMs: 400,
    });
    const response = await fetch(relay.url, { headers: { range: "bytes=0-" } });
    const out = new Uint8Array(await response.arrayBuffer());
    relay.close();
    upstream.stop(true);
    expect(response.status).toBe(206);
    expect(out.length).toBeLessThan(BYTES);
  });

  test("a seek past the cached bytes does not corrupt the cache", () => {
    const cache = new TrackCache();
    const found = cache.entry("track");
    cache.append("track", new Uint8Array(100).fill(1), 0);
    cache.append("track", new Uint8Array(50).fill(2), 500);
    expect(found.len).toBe(100);
    cache.adopt("track", 650);
    cache.finish("track");
    expect(found.complete).toBe(false);
    cache.append("track", new Uint8Array(550).fill(3), 100);
    cache.finish("track");
    expect(found.complete).toBe(true);
  });

  test("a replay after a seek still returns the whole file", async () => {
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
        const start = match?.[1] ? Number(match[1]) : 0;
        const end = Math.min(start + 524287, BYTES - 1);
        const part = body.slice(start, end + 1);
        const headers = { "content-type": "audio/mpeg", "content-range": `bytes ${start}-${end}/${BYTES}` };
        if (start > 0) return new Response(part, { status: 206, headers });

        const slow = new ReadableStream({
          async start(controller) {
            for (let at = 0; at < part.length; at += 16384) {
              controller.enqueue(part.slice(at, at + 16384));
              await Bun.sleep(20);
            }
            controller.close();
          },
        });
        return new Response(slow, { status: 206, headers });
      },
    });
    const cache = new TrackCache();
    const relay = new StreamRelay(`http://127.0.0.1:${upstream.port}/stream`, "relay-cookie", cache);
    const head = (await fetch(relay.url, { headers: { range: "bytes=0-" } })).body?.getReader();
    await head?.read();
    await head?.cancel();
    const sought = new Uint8Array(await (await fetch(relay.url, { headers: { range: "bytes=1000000-" } })).arrayBuffer());
    const again = new Uint8Array(await (await fetch(relay.url)).arrayBuffer());
    relay.close();
    upstream.stop(true);
    expect(sought).toEqual(body.slice(1000000));
    expect(again).toEqual(body);
  });

  test("a probe that fails once is retried instead of answering 502", async () => {
    let calls = 0;
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        calls += 1;
        if (calls === 1) return new Response("bad gateway", { status: 502 });
        return new Response(body.slice(BYTES - 500), {
          status: 206,
          headers: { "content-type": "audio/mpeg", "content-range": `bytes ${BYTES - 500}-${BYTES - 1}/${BYTES}` },
        });
      },
    });
    const relay = new StreamRelay(`http://127.0.0.1:${upstream.port}/stream`, "relay-cookie", new TrackCache(), {
      backoffMs: 20,
      backoffMaxMs: 100,
      firstWindowMs: 2000,
    });
    const response = await fetch(relay.url, { headers: { range: "bytes=-500" } });
    const out = new Uint8Array(await response.arrayBuffer());
    relay.close();
    upstream.stop(true);
    expect(response.status).toBe(206);
    expect(out).toEqual(body.slice(BYTES - 500));
    expect(calls).toBe(2);
  });

  test("the log names the version and a stream the player closed", async () => {
    announceRelay();
    const cookies: string[] = [];
    const upstream = chunked(new Map(), cookies);
    const relay = new StreamRelay(`http://127.0.0.1:${upstream.port}/stream`, "relay-cookie", new TrackCache());
    const reader = (await fetch(relay.url, { headers: { range: "bytes=0-" } })).body?.getReader();
    await reader?.read();
    await reader?.cancel();
    await Bun.sleep(100);
    relay.close();
    upstream.stop(true);
    const log = readFileSync("/tmp/tapes-relay.log", "utf8");
    expect(log).toContain(`start ${RELAY_VERSION} window=45000`);
    expect(log).toMatch(/req \d+ player closed at \d+ of 1400000/);
  });

  test("a changed total drops the cache and replays clean", async () => {    const bigSize = BYTES + 500;
    const other = new Uint8Array(bigSize).map((_, i) => (i * 7) % 251);
    let calls = 0;
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        calls += 1;
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
        const start = match?.[1] ? Number(match[1]) : 0;
        if (calls === 1) {
          const end = Math.min(start + 524287, BYTES - 1);
          return new Response(body.slice(start, end + 1), {
            status: 206,
            headers: { "content-type": "audio/mpeg", "content-range": `bytes ${start}-${end}/${BYTES}` },
          });
        }
        const end = Math.min(start + 524287, bigSize - 1);
        return new Response(other.slice(start, end + 1), {
          status: 206,
          headers: { "content-type": "audio/mpeg", "content-range": `bytes ${start}-${end}/${bigSize}` },
        });
      },
    });
    const cache = new TrackCache();
    const relay = new StreamRelay(`http://127.0.0.1:${upstream.port}/stream`, "relay-cookie", cache);
    const first = new Uint8Array(await (await fetch(relay.url, { headers: { range: "bytes=0-" } })).arrayBuffer());
    expect(first.length).toBeLessThan(BYTES);
    const second = new Uint8Array(await (await fetch(relay.url, { headers: { range: "bytes=0-" } })).arrayBuffer());
    relay.close();
    upstream.stop(true);
    expect(second).toEqual(other);
    expect(cache.sizeBytes).toBe(bigSize);
  });

  test("a full-file 200 mid-stream fails instead of poisoning the cache", async () => {
    const tagged = new Uint8Array(body.length + 100).map((_, i) => (i < 100 ? 7 : body[(i - 100) % body.length]));
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
        const start = match?.[1] ? Number(match[1]) : 0;
        if (start === 0) {
          return new Response(body.slice(0, 524288), {
            status: 206,
            headers: { "content-type": "audio/mpeg", "content-range": `bytes 0-524287/${BYTES}` },
          });
        }
        return new Response(tagged, { status: 200, headers: { "content-type": "audio/mpeg" } });
      },
    });
    const cache = new TrackCache();
    const relay = new StreamRelay(`http://127.0.0.1:${upstream.port}/stream`, "relay-cookie", cache);
    const out = new Uint8Array(await (await fetch(relay.url, { headers: { range: "bytes=0-" } })).arrayBuffer());
    relay.close();
    upstream.stop(true);
    expect(out).toEqual(body.slice(0, 524288));
    expect(cache.sizeBytes).toBe(524288);
  });

  test("a fresh full-file 200 plays live but is never cached", async () => {
    let hits = 0;
    const tagged = new Uint8Array(1000).fill(9);
    const file = new Uint8Array([...tagged, ...body.slice(0, 1000)]);
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        hits += 1;
        return new Response(file, { status: 200, headers: { "content-type": "audio/mpeg" } });
      },
    });
    const cache = new TrackCache();
    const relay = new StreamRelay(`http://127.0.0.1:${upstream.port}/stream`, "relay-cookie", cache);
    const first = new Uint8Array(await (await fetch(relay.url)).arrayBuffer());
    const second = new Uint8Array(await (await fetch(relay.url)).arrayBuffer());
    relay.close();
    upstream.stop(true);
    expect(first).toEqual(file);
    expect(second).toEqual(file);
    expect(hits).toBe(2);
    expect(cache.sizeBytes).toBe(0);
  });
});
