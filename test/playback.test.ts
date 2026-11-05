import { describe, expect, test } from "bun:test";
import {
  clampSeek,
  clampVolume,
  cycleRepeat,
  earlyEnd,
  endedNaturally,
  freshEarlyEnd,
  ListenTracker,
  nextIndex,
  playContext,
  prevIndex,
  type Queue,
} from "../src/playback.ts";
import type { Track } from "../src/library.ts";

const track = (id: string, duration = 200): Track => ({
  id,
  title: `Song ${id}`,
  artist: "Harbor Lights",
  album: "Winter Maps",
  albumArtist: "Harbor Lights",
  duration,
  addedAt: 1,
  year: null,
  releaseMbid: "",
  stream: `http://tapes.test/${id}`,
});

describe("queue", () => {
  test("next walks the list and stops at the end", () => {
    const queue: Queue = { tracks: [track("a"), track("b")], index: 0, shuffle: false, repeat: "off" };
    expect(nextIndex(queue)).toBe(1);
    expect(nextIndex({ ...queue, index: 1 })).toBeNull();
  });

  test("repeat all wraps to the first track", () => {
    const queue: Queue = { tracks: [track("a")], index: 0, shuffle: false, repeat: "all" };
    expect(nextIndex(queue)).toBe(0);
  });

  test("previous restarts a fresh listen instead of stepping back", () => {
    const queue: Queue = { tracks: [track("a"), track("b")], index: 1, shuffle: false, repeat: "off" };
    expect(prevIndex(queue, 10)).toBe(1);
    expect(prevIndex(queue, 1)).toBe(0);
  });

  test("shuffle keeps the chosen track first", () => {
    const tracks = [track("a"), track("b"), track("c"), track("d")];
    const queue: Queue = { tracks: [], index: -1, shuffle: true, repeat: "off" };
    const played = playContext(queue, tracks, 2);
    expect(played.tracks[0]?.id).toBe("c");
    expect(played.tracks).toHaveLength(4);
  });

  test("seek stays inside the track", () => {
    expect(clampSeek(500, 200)).toBe(199);
    expect(clampSeek(-5, 200)).toBe(0);
    expect(clampSeek(30, 200)).toBe(30);
  });

  test("volume stays between silence and full", () => {
    expect(clampVolume(2)).toBe(1);
    expect(clampVolume(-1)).toBe(0);
  });

  test("repeat cycles off, all, one", () => {
    expect(cycleRepeat("off")).toBe("all");
    expect(cycleRepeat("all")).toBe("one");
    expect(cycleRepeat("one")).toBe("off");
  });

  test("a track that ends early is not a natural end", () => {
    expect(endedNaturally(200, 200)).toBe(true);
    expect(endedNaturally(199, 200)).toBe(true);
    expect(endedNaturally(30, 200)).toBe(false);
    expect(endedNaturally(30, 0)).toBe(false);
  });

  test("two retries per track, then hold after two dead tracks", () => {
    let step = freshEarlyEnd();
    let first = earlyEnd(step, "a");
    expect(first.action).toBe("retry");
    step = first.state;
    first = earlyEnd(step, "a");
    expect(first.action).toBe("retry");
    step = first.state;
    first = earlyEnd(step, "a");
    expect(first.action).toBe("advance");
    step = first.state;
    let second = earlyEnd(step, "b");
    expect(second.action).toBe("retry");
    step = second.state;
    second = earlyEnd(step, "b");
    expect(second.action).toBe("retry");
    step = second.state;
    second = earlyEnd(step, "b");
    expect(second.action).toBe("hold");
  });
});

describe("listen reporting", () => {
  test("a short skip is not reported", () => {
    const tracker = new ListenTracker();
    tracker.start(track("a"), "tui");
    tracker.sample(2, true);
    expect(tracker.close()).toBeNull();
  });

  test("a played track is reported with its source", () => {
    const tracker = new ListenTracker();
    tracker.start(track("a"), "tui");
    for (let sec = 1; sec <= 8; sec += 1) tracker.sample(sec, true);
    const listen = tracker.close();
    expect(listen?.trackId).toBe("a");
    expect(listen?.playedMs).toBeGreaterThanOrEqual(5000);
    expect(listen?.source).toBe("tui");
  });

  test("a forward jump does not count as listening", () => {
    const tracker = new ListenTracker();
    tracker.start(track("a"), "tui");
    tracker.sample(1, true);
    tracker.sample(120, true);
    tracker.sample(121, true);
    expect(tracker.close()).toBeNull();
  });

  test("a finished track is marked finished", () => {
    const tracker = new ListenTracker();
    tracker.start(track("a"), "tui");
    for (let sec = 1; sec <= 8; sec += 1) tracker.sample(sec, true);
    tracker.finish();
    expect(tracker.close()?.finished).toBe(true);
  });
});
