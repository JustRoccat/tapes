import type { Track } from "./library.ts";
import type { ListenRow } from "./api.ts";

export type RepeatMode = "off" | "all" | "one";

export function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export function orderFor(tracks: Track[], first: Track): Track[] {
  const rest = shuffled(tracks.filter((track) => track.id !== first.id));
  return [first, ...rest];
}

export function reorderUpcoming(queue: Track[], index: number): Track[] {
  if (index >= 0 && queue.length > index + 1) {
    return [...queue.slice(0, index + 1), ...shuffled(queue.slice(index + 1))];
  }
  if (index < 0) return shuffled(queue);
  return queue;
}

export interface Queue {
  tracks: Track[];
  index: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

export function playContext(queue: Queue, tracks: Track[], start: number): Queue {
  const wanted = tracks[Math.min(Math.max(start, 0), tracks.length - 1)];
  if (!wanted) return queue;
  if (!queue.shuffle) return { ...queue, tracks: [...tracks], index: Math.max(0, start) };
  const ordered = orderFor(tracks, wanted);
  return { ...queue, tracks: ordered, index: ordered.findIndex((track) => track.id === wanted.id) };
}

export function nextIndex(queue: Queue): number | null {
  if (queue.index + 1 < queue.tracks.length) return queue.index + 1;
  if (queue.repeat === "all" && queue.tracks.length > 0) return 0;
  return null;
}

export function prevIndex(queue: Queue, positionSec: number): number | null {
  // under 3 seconds restarts, like the web player
  if (positionSec > 3) return queue.index;
  if (queue.index > 0) return queue.index - 1;
  return null;
}

export function clampSeek(wanted: number, duration: number): number {
  if (!Number.isFinite(wanted) || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(Math.max(0, wanted), Math.max(0, duration - 1));
}

export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0.9;
  return Math.min(1, Math.max(0, value));
}

export function cycleRepeat(mode: RepeatMode): RepeatMode {
  if (mode === "off") return "all";
  if (mode === "all") return "one";
  return "off";
}

export function endedNaturally(posSec: number, durSec: number): boolean {
  return durSec > 0 && posSec >= durSec - 2;
}

export interface EarlyEndState {
  retryId: string | null;
  retries: number;
  deadStreak: number;
}

export type EarlyEndAction = "retry" | "advance" | "hold";

// two retries per track, then hold instead of grinding the queue
export function earlyEnd(step: EarlyEndState, trackId: string): { action: EarlyEndAction; state: EarlyEndState } {
  const retryId = step.retryId === trackId ? step.retryId : trackId;
  const retries = step.retryId === trackId ? step.retries + 1 : 1;
  if (retries <= 2) return { action: "retry", state: { retryId, retries, deadStreak: step.deadStreak } };
  const deadStreak = step.deadStreak + 1;
  if (deadStreak >= 2) return { action: "hold", state: { retryId, retries, deadStreak } };
  return { action: "advance", state: { retryId, retries, deadStreak } };
}

export function freshEarlyEnd(): EarlyEndState {
  return { retryId: null, retries: 0, deadStreak: 0 };
}

// shorter plays never reach the server
const REPORT_AFTER_MS = 5000;

export class ListenTracker {
  private open: ListenRow | null = null;
  private sampledAt = 0;

  start(track: Track, source: string): void {
    this.open = {
      trackId: track.id,
      startedAt: Date.now(),
      playedMs: 0,
      durationMs: (track.duration || 0) * 1000,
      finished: false,
      source,
    };
    this.sampledAt = 0;
  }

  sample(positionSec: number, playing: boolean): void {
    if (!this.open || !playing) return;
    const step = positionSec - this.sampledAt;
    this.sampledAt = positionSec;
    // forward jumps do not count as listening
    if (step > 0 && step < 2) this.open.playedMs += step * 1000;
  }

  finish(): void {
    if (this.open) this.open.finished = true;
  }

  close(): ListenRow | null {
    const done = this.open;
    this.open = null;
    return done && done.playedMs >= REPORT_AFTER_MS ? done : null;
  }

  pending(): ListenRow | null {
    return this.open;
  }
}
