import { describe, expect, test } from "bun:test";
import { ApiClient, ApiError } from "../src/api.ts";

function fakeFetch(routes: Record<string, { status: number; body: unknown; setCookie?: string }>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    void init;
    const route = routes[path] ?? { status: 404, body: { error: "not_found" } };
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: {
        "content-type": "application/json",
        ...(route.setCookie ? { "set-cookie": route.setCookie } : {}),
      },
    });
  }) as typeof fetch;
}

describe("login", () => {
  test("stores the session cookie and sends it back", async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("cookie") ?? "");
      const path = new URL(String(url)).pathname;
      if (path === "/api/login") {
        return new Response(JSON.stringify({ account: { id: "a1", name: "Listener" } }), {
          headers: { "content-type": "application/json", "set-cookie": "sonum_session=abc123; Path=/; HttpOnly" },
        });
      }
      return new Response(JSON.stringify({ account: { id: "a1", name: "Listener" } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const api = new ApiClient("http://tapes.test", fetchFn);
    await api.login("long-enough-key");
    expect(api.sessionCookie).toBe("abc123");
    await api.session();
    expect(seen[1]).toBe("sonum_session=abc123");
  });

  test("a wrong key reads like a person wrote it", async () => {
    const api = new ApiClient("http://tapes.test", fakeFetch({
      "/api/login": { status: 401, body: { error: "invalid_key" } },
    }));
    const error = await api.login("wrong-key").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("That access key is not valid.");
  });

  test("an unknown failure shows the status, not a blank screen", async () => {
    const api = new ApiClient("http://tapes.test", fakeFetch({
      "/api/session": { status: 502, body: { error: "sonum_unreachable" } },
    }));
    const error = await api.session().catch((e: unknown) => e);
    expect((error as ApiError).message).toBe("The music server is not answering");
  });
});

describe("listens and state", () => {
  test("reports the batch in the shape the server parses", async () => {
    let sent: unknown = null;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      void url;
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, recorded: 1 }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const api = new ApiClient("http://tapes.test", fetchFn);
    await api.reportListens([{
      trackId: "track-7",
      startedAt: 1700000000000,
      playedMs: 12000,
      durationMs: 180000,
      finished: false,
      source: "tui",
    }]);
    expect(sent).toEqual({
      listens: [{
        trackId: "track-7",
        startedAt: 1700000000000,
        playedMs: 12000,
        durationMs: 180000,
        finished: false,
        source: "tui",
      }],
    });
  });

  test("restores the saved queue and position", async () => {
    const api = new ApiClient("http://tapes.test", fakeFetch({
      "/api/player/state": {
        status: 200,
        body: { state: { trackId: "t2", queue: ["t1", "t2"], positionMs: 45000, volume: 0.8, shuffle: false, repeat: "off" } },
      },
    }));
    const { state } = await api.playerState();
    expect(state?.trackId).toBe("t2");
    expect(state?.positionMs).toBe(45000);
  });
});

describe("likes", () => {
  test("finds the likes playlist by its fixed name", async () => {
    const api = new ApiClient("http://tapes.test", fakeFetch({
      "/api/playlists": { status: 200, body: { playlists: [{ id: "p9", name: "You liked this!" }] } },
    }));
    const { playlists } = await api.playlists();
    expect(playlists.find((list) => list.name === "You liked this!")?.id).toBe("p9");
  });
});
