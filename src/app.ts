import { BoxRenderable, CliRenderEvents, TextRenderable, createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
import { appendFileSync } from "node:fs";
import { ApiClient, ApiError } from "./api.ts";
import type { AudioBackend } from "./audio.ts";
import { RELAY_VERSION } from "./relay.ts";
import {
  buildLibrary,
  formatTime,
  progressBar,
  searchLibrary,
  tracksForAlbum,
  truncate,
  type Artist,
  type Library,
  type Track,
} from "./library.ts";
import { ListenTracker, clampSeek, clampVolume, cycleRepeat, earlyEnd, endedNaturally, freshEarlyEnd, nextIndex, playContext, prevIndex, reorderUpcoming } from "./playback.ts";

const INK = "#141414";
const PAPER = "#edeae4";
const FADED = "#8f8b84";
const LIKED_LIST = "You liked this!";
const DIAG_LOG = "/tmp/tapes-tui.log";

function diag(message: string): void {
  try {
    appendFileSync(DIAG_LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {
  }
}

type View = "library" | "search" | "playlists" | "mixes" | "lyrics" | "queue" | "help";

const VIEWS: { id: View; tab: string; key: string }[] = [
  { id: "library", tab: "Library", key: "1" },
  { id: "search", tab: "Search", key: "2" },
  { id: "playlists", tab: "Playlists", key: "3" },
  { id: "mixes", tab: "Mixes", key: "4" },
  { id: "lyrics", tab: "Lyrics", key: "5" },
  { id: "queue", tab: "Queue", key: "6" },
];

interface Row {
  kind: "artist" | "album" | "track" | "playlist" | "mix" | "recommended" | "note";
  id: string;
  label: string;
  sub: string;
  depth: number;
  parent: string;
}

interface Drill {
  kind: "artist" | "playlist" | "mix" | "recommended";
  title: string;
  sub: string;
  rows: Row[];
}

export interface AppDeps {
  api: ApiClient;
  audio: AudioBackend;
  accountName: string;
}

function trackRow(track: Track, liked: boolean, depth: number, parent: string): Row {
  return {
    kind: "track",
    id: track.id,
    label: `${liked ? "* " : ""}${track.title}`,
    sub: `${track.artist} - ${track.album}`,
    depth,
    parent,
  };
}

export async function runApp(deps: AppDeps): Promise<"quit" | "login"> {
  // our own ctrl-c quits gracefully instead
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 20 });
  const app = new TapesApp(renderer, deps);
  try {
    return await app.run();
  } finally {
    try {
      renderer.destroy();
    } catch {
    }
  }
}

class TapesApp {
  private api: ApiClient;
  private audio: AudioBackend;
  private accountName: string;
  private root: BoxRenderable;
  private header: BoxRenderable;
  private main: BoxRenderable;
  private list: BoxRenderable;
  private side: BoxRenderable;
  private bottom: BoxRenderable;
  private view: View = "library";
  private drill: Drill | null = null;
  private rows: Row[] = [];
  private sel = 0;
  private offset = 0;
  private helpOffset = 0;
  private query = "";
  private openArtists = new Set<string>();
  private openAlbums = new Set<string>();
  private library: Library | null = null;
  private loading = "";
  private error = "";
  private status = "";
  private statusAt = 0;
  private earlyState = freshEarlyEnd();
  private queueTracks: Track[] = [];
  private queueIndex = -1;
  private shuffle = false;
  private repeat: "off" | "all" | "one" = "off";
  private paused = true;
  private volume = 0.9;
  private pos = 0;
  private dur = 0;
  private tracker = new ListenTracker();
  private liked = new Set<string>();
  private likedId: string | null = null;
  private likesReady = false;
  private playlists: { id: string; name: string }[] = [];
  private mixes: { name: string; trackIds: string[] }[] = [];
  private recs: { trackId: string; reason: string }[] = [];
  private mixesReady = false;
  private lyricsCache = new Map<string, string>();
  private picker: { trackId: string; sel: number } | null = null;
  private prompt: { label: string; value: string; after: (name: string) => void } | null = null;
  private dead = false;
  private gone = false;
  private saveTick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private done: (value: "quit" | "login") => void = () => {};
  private kids = new Map<BoxRenderable, TextRenderable[]>();

  constructor(
    private renderer: CliRenderer,
    deps: AppDeps,
  ) {
    this.api = deps.api;
    this.audio = deps.audio;
    this.accountName = deps.accountName;
    this.root = new BoxRenderable(renderer, { id: "root", width: "100%", height: "100%", flexDirection: "column", backgroundColor: INK });
    this.header = new BoxRenderable(renderer, { id: "header", width: "100%", height: 1, flexDirection: "row" });
    this.main = new BoxRenderable(renderer, { id: "main", width: "100%", flexGrow: 1, flexDirection: "row" });
    this.list = new BoxRenderable(renderer, { id: "list", flexGrow: 1, flexDirection: "column" });
    this.side = new BoxRenderable(renderer, { id: "side", width: 28, flexDirection: "column" });
    this.bottom = new BoxRenderable(renderer, { id: "bottom", width: "100%", height: 2, flexDirection: "column" });
    this.main.add(this.list);
    this.main.add(this.side);
    this.root.add(this.header);
    this.root.add(this.main);
    this.root.add(this.bottom);
    renderer.root.add(this.root);
    renderer.keyInput.on("keypress", (key) => void this.onKey(key));
    renderer.on(CliRenderEvents.RESIZE, () => this.paint());

    renderer.on(CliRenderEvents.DESTROY, () => {
      // a tick can outlive teardown and paint on a dead scene
      if (this.gone) return;
      this.gone = true;
      diag("renderer destroyed");
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.audio.onEnded = null;
      this.audio.stop();
      this.done("quit");
    });
  }

  run(): Promise<"quit" | "login"> {
    this.audio.onEnded = () => void this.onTrackEnded();
    this.loading = "Loading the library";
    this.paint();
    this.renderer.start();
    this.timer = setInterval(() => void this.tick(), 500);
    this.fetchLibrary();
    return new Promise((resolve) => {
      this.done = resolve;
    });
  }

  private finish(value: "quit" | "login"): void {
    if (this.gone) {
      this.done(value);
      return;
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.audio.onEnded = null;
    void this.shutdown().finally(() => this.done(value));
  }

  private async shutdown(): Promise<void> {
    try {
      const report = this.tracker.close();
      if (report) await this.api.reportListens([report]);
    } catch {
    }
    await this.saveState();
    this.audio.stop();
  }

  private say(message: unknown): void {
    this.error = message instanceof ApiError ? message.message : "The request failed. Try again.";
    if (message instanceof ApiError && message.status === 401) {
      this.dead = true;
    }
    this.paint();
  }

  private fetchLibrary(): void {
    this.api
      .library()
      .then((raw) => {
        this.library = buildLibrary(
          (raw.tracks ?? []) as never[],
          (raw.albums ?? []) as never[],
          (raw.artists ?? []) as never[],
          (id) => this.api.streamUrl(id),
        );
        this.loading = "";
        this.refreshRows();
        this.restoreState();
        this.paint();
      })
      .catch((error: unknown) => {
        this.loading = "";
        this.say(error);
      });
  }

  private restoreState(): void {
    if (!this.library) return;
    const library = this.library;
    this.api
      .playerState()
      .then(({ state }) => {
        if (!state?.trackId) return;
        const tracks = state.queue.map((id) => library.byId.get(id)).filter((t): t is Track => !!t);
        const at = tracks.findIndex((track) => track.id === state.trackId);
        if (at === -1 || !tracks[at]) return;
        this.queueTracks = tracks;
        this.queueIndex = at;
        this.shuffle = state.shuffle === true;
        this.repeat = state.repeat === "all" || state.repeat === "one" ? state.repeat : "off";
        this.volume = clampVolume(state.volume);
        this.audio.setVolume(this.volume);
        const track = tracks[at] as Track;
        this.paused = true;
        this.audio.start(track.stream, { startSec: (state.positionMs || 0) / 1000, volume: this.volume, cookie: this.api.sessionCookie });
        this.audio.setPaused(true);
        this.tracker.start(track, "tui");
        this.pos = (state.positionMs || 0) / 1000;
        this.dur = track.duration;
        this.paint();
      })
      .catch(() => {
      });
  }

  private async saveState(): Promise<void> {
    const track = this.queueTracks[this.queueIndex];
    if (!track) return;
    try {
      await this.api.savePlayerState({
        trackId: track.id,
        queue: this.queueTracks.map((item) => item.id),
        positionMs: Math.round(this.pos * 1000),
        volume: this.volume,
        shuffle: this.shuffle,
        repeat: this.repeat,
      });
    } catch {
    }
  }

  private async tick(): Promise<void> {
    if (this.gone || this.dead || !this.audio.running()) {
      this.paint();
      return;
    }
    try {
      this.pos = await this.audio.positionSec();
      const backendDur = await this.audio.durationSec();
      const track = this.queueTracks[this.queueIndex];
      this.dur = backendDur > 0 ? backendDur : (track?.duration ?? 0);
      this.tracker.sample(this.pos, !this.paused);
    } catch {
    }
    this.saveTick += 1;
    if (this.saveTick >= 30 && !this.paused) {
      this.saveTick = 0;
      void this.saveState();
    }
    this.paint();
  }

  private currentTrack(): Track | undefined {
    return this.queueTracks[this.queueIndex];
  }

  private queueState() {
    return { tracks: this.queueTracks, index: this.queueIndex, shuffle: this.shuffle, repeat: this.repeat };
  }

  private onTrackEnded(): void {
    const track = this.currentTrack();
    const endedAt = this.pos;
    const wasNatural = endedNaturally(endedAt, this.dur);
    this.tracker.finish();
    const report = this.tracker.close();
    if (report) this.api.reportListens([report]).catch(() => {});
    if (wasNatural) {
      this.earlyState = freshEarlyEnd();
      diag(`end ${track?.id} natural at ${Math.round(endedAt)}s`);
    }
    if (this.repeat === "one") {
      if (wasNatural || !track) {
        this.startTrack(this.queueTracks, this.queueIndex);
        return;
      }
      const decided = earlyEnd(this.earlyState, track.id);
      this.earlyState = decided.state;
      if (decided.action === "hold" || decided.state.retries > 6) {
        this.paused = true;
        const why = this.audio.lastExit?.() ?? "";
        diag(`hold ${track.id}: stopped twice in a row${why ? ` (${why})` : ""}`);
        this.note(`Playback keeps stopping${why ? ` (${why.slice(0, 70)})` : ""}. Press Enter to try this track again.`);
        this.paint();
        return;
      }
      if (decided.action === "retry") {
        diag(`retry ${track.id} from ${Math.round(endedAt)}s (${decided.state.retries}/2) ${this.audio.lastExit?.() ?? ""}`.trimEnd());
        this.note(`Trying ${track.title} again from ${formatTime(endedAt)}.`);
      }
      this.startTrack(this.queueTracks, this.queueIndex, "retry", endedAt);
      return;
    }
    if (!wasNatural && track) {
      const decided = earlyEnd(this.earlyState, track.id);
      this.earlyState = decided.state;
      if (decided.action === "retry") {
        diag(`retry ${track.id} from ${Math.round(endedAt)}s (${decided.state.retries}/2) ${this.audio.lastExit?.() ?? ""}`.trimEnd());
        this.note(`Trying ${track.title} again from ${formatTime(endedAt)}.`);
        this.startTrack(this.queueTracks, this.queueIndex, "retry", endedAt);
        return;
      }
      if (decided.action === "hold") {
        this.paused = true;
        const why = this.audio.lastExit?.() ?? "";
        diag(`hold ${track.id}: stopped twice in a row${why ? ` (${why})` : ""}`);
        this.note(`Playback keeps stopping${why ? ` (${why.slice(0, 70)})` : ""}. Press Enter to try this track again.`);
        this.paint();
        return;
      }
      const reason = this.audio.lastExit?.() ?? "the player left early";
      diag(`give up ${track.id} at ${Math.round(endedAt)}s: ${reason}`);
      this.note(`Left ${track.title} after ${formatTime(endedAt)}: ${reason}.`);
    }
    const next = nextIndex(this.queueState());
    if (next === null) {
      this.paused = true;
      this.pos = 0;
    } else {
      this.startTrack(this.queueTracks, next, "auto");
    }
    this.paint();
  }

  private startTrack(tracks: Track[], index: number, mode: "manual" | "retry" | "auto" = "manual", resumeSec = 0): void {
    const report = this.tracker.close();
    if (report) this.api.reportListens([report]).catch(() => {});
    if (mode === "manual") {
      this.earlyState = freshEarlyEnd();
    } else if (mode === "auto") {
      this.earlyState = { retryId: null, retries: 0, deadStreak: this.earlyState.deadStreak };
    }
    const played = playContext(this.queueState(), tracks, index);
    this.queueTracks = played.tracks;
    this.queueIndex = played.index;
    const track = this.queueTracks[this.queueIndex];
    if (!track) return;
    this.pos = resumeSec;
    this.dur = track.duration;
    this.paused = false;
    this.audio.setVolume(this.volume);
    diag(`start ${track.id} at ${Math.round(resumeSec)}s ${mode}`);
    this.audio.start(track.stream, { startSec: resumeSec, volume: this.volume, cookie: this.api.sessionCookie });
    this.tracker.start(track, "tui");
    const startedId = track.id;
    setTimeout(() => {
      if (this.currentTrack()?.id !== startedId || this.audio.running()) return;
      this.paused = true;
      const reason = this.audio.exitedEarly?.() ?? "the player left at once";
      this.note(`No sound: ${reason}.`);
      this.paint();
    }, 3000);
    void this.saveState();
  }

  private toggle(): void {
    const track = this.currentTrack();
    if (!track) {
      this.playSelected();
      return;
    }
    if (!this.audio.running()) {
      this.startTrack(this.queueTracks, this.queueIndex);
      this.paint();
      return;
    }
    this.paused = !this.paused;
    this.audio.setPaused(this.paused);
    this.paint();
  }

  private step(delta: number): void {
    const track = this.currentTrack();
    if (!track || !this.audio.running()) return;
    if (!this.audio.canSeek) {
      this.note("Seek needs mpv. This build plays through ffplay.");
      return;
    }
    const target = clampSeek(this.pos + delta, this.dur || track.duration);
    this.audio.seekAbsolute(target);
    this.pos = target;
    this.paint();
  }

  private changeVolume(delta: number): void {
    if (!this.audio.canSetVolume) {
      this.note("Volume needs mpv. This build plays through ffplay.");
      return;
    }
    this.volume = clampVolume(Math.round((this.volume + delta) * 20) / 20);
    this.audio.setVolume(this.volume);
    this.paint();
  }

  private note(message: string): void {
    this.status = message;
    this.statusAt = Date.now();
  }

  private freshStatus(): string {
    if (this.status && Date.now() - this.statusAt > 4000) this.status = "";
    return this.status;
  }

  private async ensureLikes(): Promise<void> {
    if (this.likesReady) return;
    // the likes list is created on first like
    const { playlists } = await this.api.playlists();
    this.playlists = playlists ?? [];
    let found = this.playlists.find((list) => list.name === LIKED_LIST);
    if (!found) {
      const created = await this.api.createPlaylist(LIKED_LIST);
      this.playlists.push(created.playlist);
      found = created.playlist;
    }
    this.likedId = found.id;
    const detail = await this.api.playlistDetail(found.id);
    this.liked = new Set(detail.trackIds ?? []);
    this.likesReady = true;
  }

  private async toggleLike(track: Track | undefined): Promise<void> {
    if (!track) return;
    try {
      await this.ensureLikes();
      if (!this.likedId) return;
      if (this.liked.has(track.id)) {
        await this.api.removeTrack(this.likedId, track.id);
        this.liked.delete(track.id);
        this.note(`Left ${LIKED_LIST}.`);
      } else {
        await this.api.addTracks(this.likedId, [track.id]);
        this.liked.add(track.id);
        this.note(`Kept in ${LIKED_LIST}.`);
      }
    } catch (error) {
      this.say(error);
      return;
    }
    this.refreshRows();
    this.paint();
  }

  private selectedTrack(): Track | undefined {
    const row = this.rows[this.sel];
    if (!row || row.kind !== "track" || !this.library) return undefined;
    return this.library.byId.get(row.id);
  }

  private drillTracks(): Track[] {
    if (!this.library || !this.drill) return [];
    return this.drill.rows
      .filter((row) => row.kind === "track")
      .map((row) => this.library?.byId.get(row.id))
      .filter((track): track is Track => !!track);
  }

  private playSelected(): void {
    const row = this.rows[this.sel];
    if (!row || !this.library) return;
    if (row.kind === "note") return;
    if (row.kind === "track") {
      const track = this.library.byId.get(row.id);
      if (!track) return;
      const context = row.parent && this.view === "library" ? this.albumTracks(row.parent) : this.drill ? this.drillTracks() : [track];
      const list = context.length ? context : [track];
      const at = list.findIndex((item) => item.id === track.id);
      this.startTrack(list, Math.max(0, at));
      this.paint();
      return;
    }
    if (this.view === "library") {
      this.flipNode(row);
      return;
    }
    void this.openDrill(row);
  }

  private albumTracks(parent: string): Track[] {
    if (!this.library) return [];
    const album = this.library.albums.find((item) => `${item.name}|||${item.artist}` === parent);
    return album ? tracksForAlbum(this.library, album) : [];
  }

  private flipNode(row: Row): void {
    if (row.kind === "artist") {
      if (this.openArtists.has(row.id)) {
        this.openArtists.delete(row.id);
        for (const key of [...this.openAlbums]) {
          if (key.endsWith(`|||${row.id}`)) this.openAlbums.delete(key);
        }
      } else {
        this.openArtists.add(row.id);
      }
    } else if (row.kind === "album") {
      if (this.openAlbums.has(row.id)) this.openAlbums.delete(row.id);
      else this.openAlbums.add(row.id);
    }
    this.refreshRows();
    this.paint();
  }

  private flipSelected(open: boolean): void {
    const row = this.rows[this.sel];
    if (!row || this.view !== "library" || this.drill) return;
    if (row.kind === "artist") {
      if (open) this.openArtists.add(row.id);
      else {
        this.openArtists.delete(row.id);
        for (const key of [...this.openAlbums]) {
          if (key.endsWith(`|||${row.id}`)) this.openAlbums.delete(key);
        }
      }
      this.refreshRows();
      this.paint();
    } else if (row.kind === "album") {
      if (open) this.openAlbums.add(row.id);
      else this.openAlbums.delete(row.id);
      this.refreshRows();
      this.paint();
    }
  }

  private async createAndFill(name: string): Promise<void> {
    const trackId = this.picker?.trackId;
    this.picker = null;
    if (!trackId) return;
    try {
      const created = await this.api.createPlaylist(name);
      await this.api.addTracks(created.playlist.id, [trackId]);
      this.note(`Kept in ${name}.`);
    } catch (error) {
      this.say(error);
    }
    this.paint();
  }

  private async openDrill(row: Row): Promise<void> {
    if (!this.library) return;
    const library = this.library;
    try {
      if (row.kind === "artist") {
        const artist: Artist | undefined = library.artists.find((item) => item.name === row.id);
        if (!artist) return;
        const tracks = artist.trackIds.map((id) => library.byId.get(id)).filter((t): t is Track => !!t);
        this.setDrill({
          kind: "artist",
          title: artist.name,
          sub: `${artist.albumCount} albums`,
          rows: tracks.map((track) => trackRow(track, this.liked.has(track.id), 0, "")),
        });
      } else if (row.kind === "playlist") {
        const detail = await this.api.playlistDetail(row.id);
        const tracks = (detail.trackIds ?? []).map((id) => library.byId.get(id)).filter((t): t is Track => !!t);
        this.setDrill({
          kind: "playlist",
          title: detail.playlist.name,
          sub: `${tracks.length} tracks`,
          rows: tracks.map((track) => trackRow(track, this.liked.has(track.id), 0, "")),
        });
      } else if (row.kind === "mix") {
        const mix = this.mixes.find((item) => item.name === row.id);
        if (!mix) return;
        const tracks = mix.trackIds.map((id) => library.byId.get(id)).filter((t): t is Track => !!t);
        this.setDrill({
          kind: "mix",
          title: mix.name,
          sub: `${tracks.length} tracks`,
          rows: tracks.map((track) => trackRow(track, this.liked.has(track.id), 0, "")),
        });
      } else if (row.kind === "recommended") {
        const tracks = this.recs
          .map((rec) => ({ rec, track: library.byId.get(rec.trackId) }))
          .filter((item): item is { rec: { trackId: string; reason: string }; track: Track } => !!item.track)
          .map((item) => ({ track: item.track, reason: item.rec.reason }));
        this.setDrill({
          kind: "recommended",
          title: "Recommended",
          sub: `${tracks.length} tracks`,
          rows: tracks.map(({ track, reason }) => ({ ...trackRow(track, this.liked.has(track.id), 0, ""), sub: `${track.artist} - ${reason}` })),
        });
      }
    } catch (error) {
      this.say(error);
    }
    this.paint();
  }

  private setDrill(drill: Drill): void {
    this.drill = drill;
    this.rows = drill.rows;
    this.sel = 0;
    this.offset = 0;
  }

  private setView(view: View): void {
    if (this.view === view && !this.drill) return;
    this.view = view;
    this.drill = null;
    this.picker = null;
    this.prompt = null;
    this.sel = 0;
    this.offset = 0;
    this.helpOffset = 0;
    this.refreshRows();
    if (view === "playlists") void this.loadPlaylists();
    if (view === "mixes") void this.loadMixes();
    if (view === "lyrics") void this.loadLyrics(this.currentTrack()?.id);
    this.paint();
  }

  private loadPlaylists(): void {
    this.api
      .playlists()
      .then(({ playlists }) => {
        this.playlists = playlists ?? [];
        if (this.view === "playlists" && !this.drill) this.refreshRows();
        this.paint();
      })
      .catch((error: unknown) => this.say(error));
  }

  private loadMixes(): void {
    if (this.mixesReady) return;
    Promise.all([this.api.mixes(), this.api.recommendations(12)])
      .then(([mixes, recs]) => {
        this.mixes = mixes.mixes ?? [];
        this.recs = (recs.picks ?? []).map((pick) => ({ trackId: pick.trackId, reason: pick.reason }));
        this.mixesReady = true;
        if (this.view === "mixes" && !this.drill) this.refreshRows();
        this.paint();
      })
      .catch((error: unknown) => this.say(error));
  }

  private loadLyrics(trackId: string | undefined): void {
    if (!trackId || this.lyricsCache.has(trackId)) {
      this.paint();
      return;
    }
    this.api
      .lyrics(trackId)
      .then(({ lyrics }) => {
        this.lyricsCache.set(trackId, lyrics ?? "");
        if (this.view === "lyrics") this.refreshRows();
        this.paint();
      })
      .catch((error: unknown) => this.say(error));
  }

  private libraryRows(): Row[] {
    const library = this.library;
    if (!library) return [];
    const rows: Row[] = [];
    const artists = [...library.artists].sort((a, b) => a.name.localeCompare(b.name));
    for (const artist of artists) {
      rows.push({ kind: "artist", id: artist.name, label: artist.name, sub: `${artist.albumCount} albums`, depth: 0, parent: "" });
      if (!this.openArtists.has(artist.name)) continue;
      const albums = library.albums
        .filter((album) => artist.aliases.includes(album.artist))
        .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.name.localeCompare(b.name));
      for (const album of albums) {
        const key = `${album.name}|||${album.artist}`;
        rows.push({
          kind: "album",
          id: key,
          label: album.name,
          sub: `${album.year ?? ""} ${album.trackCount} tracks`.trim(),
          depth: 1,
          parent: artist.name,
        });
        if (!this.openAlbums.has(key)) continue;
        for (const track of tracksForAlbum(library, album)) {
          rows.push(trackRow(track, this.liked.has(track.id), 2, key));
        }
      }
    }
    return rows;
  }

  private refreshRows(): void {
    if (!this.library || this.drill) {
      if (this.drill) this.rows = this.drill.rows;
      return;
    }
    const library = this.library;
    if (this.view === "library") {
      this.rows = this.libraryRows();
    } else if (this.view === "search") {
      const found = searchLibrary(library, this.query);
      // groups, not one flat list
      const grouped: Row[] = [];
      if (found.artists.length) {
        grouped.push({ kind: "note", id: "head-artists", label: "Artists", sub: "", depth: 0, parent: "" });
        for (const artist of found.artists) {
          grouped.push({ kind: "artist", id: artist.name, label: artist.name, sub: "artist", depth: 0, parent: "" });
        }
      }
      if (found.albums.length) {
        grouped.push({ kind: "note", id: "head-albums", label: "Albums", sub: "", depth: 0, parent: "" });
        for (const album of found.albums) {
          grouped.push({ kind: "album", id: `${album.name}|||${album.artist}`, label: album.name, sub: `${album.artist} - album`, depth: 0, parent: "" });
        }
      }
      if (found.tracks.length) {
        grouped.push({ kind: "note", id: "head-tracks", label: "Tracks", sub: "", depth: 0, parent: "" });
        for (const track of found.tracks) {
          grouped.push(trackRow(track, this.liked.has(track.id), 0, ""));
        }
      }
      this.rows = grouped;
    } else if (this.view === "playlists") {
      this.rows = this.playlists.map((list): Row => ({ kind: "playlist", id: list.id, label: list.name, sub: "playlist", depth: 0, parent: "" }));
    } else if (this.view === "mixes") {
      const rows: Row[] = [];
      if (this.recs.length) {
        rows.push({ kind: "recommended", id: "recommended", label: "Recommended", sub: `${this.recs.length} tracks`, depth: 0, parent: "" });
      }
      for (const mix of this.mixes) {
        rows.push({ kind: "mix", id: mix.name, label: mix.name, sub: `${mix.trackIds.length} tracks`, depth: 0, parent: "" });
      }
      this.rows = rows;
    } else if (this.view === "lyrics") {
      const track = this.currentTrack();
      const text = track ? (this.lyricsCache.get(track.id) ?? "") : "";
      this.rows = text
        ? text.split("\n").map((textLine, index): Row => ({ kind: "note", id: `line-${index}`, label: textLine || " ", sub: "", depth: 0, parent: "" }))
        : [{ kind: "note", id: "none", label: track ? "This song has no words here." : "Play a track to read its words.", sub: "", depth: 0, parent: "" }];
    } else if (this.view === "queue") {
      this.rows = this.queueTracks.map(
        (track, index): Row => ({
          kind: "track",
          id: track.id,
          label: `${index === this.queueIndex ? "> " : ""}${track.title}`,
          sub: `${track.artist} - ${track.album}`,
          depth: 0,
          parent: "",
        }),
      );
    } else {
      this.rows = [];
    }
    this.sel = Math.min(this.sel, Math.max(0, this.rows.length - 1));
  }

  private move(delta: number): void {
    if (this.view === "help") {
      this.helpOffset = Math.max(0, this.helpOffset + delta);
      this.paint();
      return;
    }
    if (!this.rows.length) return;
    this.sel = Math.min(this.rows.length - 1, Math.max(0, this.sel + delta));
    this.paint();
  }

  private page(delta: number): void {
    this.move(delta * Math.max(1, this.listHeight()));
  }

  private listHeight(): number {
    return Math.max(1, this.renderer.terminalHeight - 4);
  }

  private keyText(key: KeyEvent): string | null {
    if (key.ctrl || key.meta) return null;
    if (key.name === "space") return " ";
    if (key.name.length !== 1) return null;
    if (key.name === "/" && key.shift) return "?";
    return key.shift ? key.name.toUpperCase() : key.name;
  }

  private onKey(key: KeyEvent): void {
    if (this.gone) return;
    if (this.dead) {
      this.finish("login");
      return;
    }
    if (key.ctrl && key.name === "c") {
      this.finish("quit");
      return;
    }
    if (this.prompt) {
      this.keyPrompt(key);
      return;
    }
    if (this.picker) {
      this.keyPicker(key);
      return;
    }

    if (this.view === "search") {
      // typing grabs every printable key, even q and space
      const text = this.keyText(key);
      if (text !== null) {
        this.query += text;
        this.sel = 0;
        this.offset = 0;
        this.refreshRows();
        this.paint();
        return;
      }
    }
    const name = key.name;
    if (name === "escape") {
      if (this.view === "search" && this.query) {
        this.query = "";
        this.sel = 0;
        this.offset = 0;
        this.refreshRows();
        this.paint();
        return;
      }
      if (this.view === "search") {
        this.setView("library");
        return;
      }
      if (this.view === "help") this.setView("library");
      else if (this.drill) {
        this.drill = null;
        this.refreshRows();
        this.paint();
      }
      return;
    }
    if (name === "q") {
      this.finish("quit");
      return;
    }
    if (name === "?" || (name === "/" && key.shift)) {
      this.setView("help");
      return;
    }
    if (name === "tab") {
      const at = VIEWS.findIndex((item) => item.id === this.view);
      const next = VIEWS[(at + (key.shift ? VIEWS.length - 1 : 1)) % VIEWS.length];
      if (next) this.setView(next.id);
      return;
    }
    if (this.view !== "search") {
      const jump = VIEWS.find((item) => item.key === name);
      if (jump) {
        this.setView(jump.id);
        return;
      }
    }
    switch (name) {
      case "up":
      case "k":
        this.move(-1);
        break;
      case "down":
      case "j":
        this.move(1);
        break;
      case "left":
      case "h":
        this.flipSelected(false);
        break;
      case "right":
        this.flipSelected(true);
        break;
      case "pageup":
        this.page(-1);
        break;
      case "pagedown":
        this.page(1);
        break;
      case "home":
        if (this.view === "help") {
          this.helpOffset = 0;
        } else {
          this.sel = 0;
        }
        this.paint();
        break;
      case "end":
        if (this.view === "help") {
          this.helpOffset = helpLines().length;
        } else {
          this.sel = Math.max(0, this.rows.length - 1);
        }
        this.paint();
        break;
      case "enter":
      case "return":
        this.playSelected();
        break;
      case "space":
        this.toggle();
        break;
      case "n":
        this.jumpTrack(1);
        break;
      case "p":
        this.jumpTrack(-1);
        break;
      case "[":
        this.step(-10);
        break;
      case "]":
        this.step(10);
        break;
      case "-":
        this.changeVolume(-0.05);
        break;
      case "=":
      case "+":
        this.changeVolume(0.05);
        break;
      case "s":
        this.flipShuffle();
        break;
      case "r":
        this.repeat = cycleRepeat(this.repeat);
        this.note(`Repeat is ${this.repeat}.`);
        this.paint();
        break;
      case "l":
        void this.toggleLike(this.selectedTrack() ?? this.currentTrack());
        break;
      case "a":
        this.openPicker();
        break;
      case "d":
        void this.removeFromPlaylist();
        break;
      case "backspace":
        if (this.view === "search" && this.query) {
          this.query = this.query.slice(0, -1);
          this.sel = 0;
          this.offset = 0;
          this.refreshRows();
          this.paint();
        }
        break;
      default:
        break;
    }
  }

  private jumpTrack(direction: 1 | -1): void {
    if (direction === 1) {
      const next = nextIndex(this.queueState());
      if (next !== null) this.startTrack(this.queueTracks, next);
      this.paint();
      return;
    }
    const prev = prevIndex(this.queueState(), this.pos);
    if (prev === null || prev === this.queueIndex) {
      this.step(-this.pos);
      return;
    }
    this.startTrack(this.queueTracks, prev);
    this.paint();
  }

  private flipShuffle(): void {
    if (this.shuffle) {
      this.shuffle = false;
    } else {
      this.shuffle = true;
      this.queueTracks = reorderUpcoming(this.queueTracks, this.queueIndex);
    }
    this.note(this.shuffle ? "Shuffle is on." : "Shuffle is off.");
    this.paint();
  }

  private openPicker(): void {
    const track = this.selectedTrack() ?? this.currentTrack();
    if (!track) return;
    this.picker = { trackId: track.id, sel: 0 };
    this.api
      .playlists()
      .then(({ playlists }) => {
        this.playlists = playlists ?? [];
        this.paint();
      })
      .catch((error: unknown) => this.say(error));
    this.paint();
  }

  private keyPicker(key: KeyEvent): void {
    if (!this.picker) return;
    const count = this.playlists.length + 1;
    if (key.name === "escape") {
      this.picker = null;
      this.paint();
      return;
    }
    if (key.name === "up" || key.name === "k") {
      this.picker.sel = (this.picker.sel + count - 1) % count;
      this.paint();
      return;
    }
    if (key.name === "down" || key.name === "j") {
      this.picker.sel = (this.picker.sel + 1) % count;
      this.paint();
      return;
    }
    if (key.name === "enter" || key.name === "return") {
      const trackId = this.picker.trackId;
      if (this.picker.sel === this.playlists.length) {
        this.prompt = { label: "New playlist name", value: "", after: (name) => void this.createAndFill(name) };
        this.paint();
        return;
      }
      const list = this.playlists[this.picker.sel];
      this.picker = null;
      if (!list) return;
      this.api
        .addTracks(list.id, [trackId])
        .then(() => this.note(`Kept in ${list.name}.`))
        .catch((error: unknown) => this.say(error));
      this.paint();
    }
  }

  private keyPrompt(key: KeyEvent): void {
    if (!this.prompt) return;
    if (key.name === "escape") {
      this.prompt = null;
      this.paint();
      return;
    }
    if (key.name === "enter" || key.name === "return") {
      const after = this.prompt.after;
      const value = this.prompt.value.trim();
      this.prompt = null;
      if (value) after(value);
      else this.paint();
      return;
    }
    if (key.name === "backspace") {
      this.prompt.value = this.prompt.value.slice(0, -1);
      this.paint();
      return;
    }
    if (key.name.length === 1 && !key.ctrl && !key.meta) {
      this.prompt.value += key.shift ? key.name.toUpperCase() : key.name;
      this.paint();
    }
  }

  private async removeFromPlaylist(): Promise<void> {
    if (this.drill?.kind !== "playlist" || !this.library) return;
    const row = this.rows[this.sel];
    if (!row || row.kind !== "track") return;
    try {
      const { playlists } = await this.api.playlists();
      this.playlists = playlists ?? [];
      const list = this.playlists.find((item) => item.name === this.drill?.title);
      if (!list) return;
      await this.api.removeTrack(list.id, row.id);
      this.liked.delete(row.id);
      const detail = await this.api.playlistDetail(list.id);
      const library = this.library;
      const tracks = (detail.trackIds ?? []).map((id) => library.byId.get(id)).filter((t): t is Track => !!t);
      if (this.drill) {
        this.drill = { ...this.drill, sub: `${tracks.length} tracks`, rows: tracks.map((track) => trackRow(track, this.liked.has(track.id), 0, "")) };
        this.rows = this.drill.rows;
        this.sel = Math.min(this.sel, Math.max(0, this.rows.length - 1));
      }
    } catch (error) {
      this.say(error);
    }
    this.paint();
  }

  private track(parent: BoxRenderable, child: TextRenderable): void {
    parent.add(child);
    const list = this.kids.get(parent) ?? [];
    list.push(child);
    this.kids.set(parent, list);
  }

  private kid(parent: BoxRenderable, content: string, fg: string, bg: string, width: number): void {
    this.track(parent, new TextRenderable(this.renderer, { content: truncate(content, width), fg, bg, width: "100%" }));
  }

  private clearKids(parent: BoxRenderable): void {
    for (const child of this.kids.get(parent) ?? []) parent.remove(child);
    this.kids.set(parent, []);
  }

  private paint(): void {
    if (this.gone) return;
    const width = this.renderer.terminalWidth;
    const showSide = width >= 60;
    this.side.visible = showSide;
    const sideW = width >= 100 ? 32 : 24;
    this.side.width = sideW;
    const listW = showSide ? width - sideW - 1 : width;
    this.paintHeader();
    this.paintList(listW);
    if (showSide) this.paintSide(sideW);
    this.paintBottom(width);
  }

  private paintHeader(): void {
    this.clearKids(this.header);
    for (const item of VIEWS) {
      const active = this.view === item.id && !this.drill;
      this.track(this.header, new TextRenderable(this.renderer, {
        content: ` ${item.key} ${item.tab} `,
        fg: active ? INK : PAPER,
        bg: active ? PAPER : INK,
      }));
    }
    this.track(this.header, new TextRenderable(this.renderer, { content: "", flexGrow: 1 }));
    this.track(this.header, new TextRenderable(this.renderer, { content: ` ${this.accountName} `, fg: FADED, bg: INK }));
  }

  private paintList(listW: number): void {
    this.clearKids(this.list);
    const visible = this.listHeight();
    if (this.prompt) {
      this.kid(this.list, `${this.prompt.label}: ${this.prompt.value}_`, PAPER, INK, listW);
      this.kid(this.list, "Enter confirms, Esc walks away.", FADED, INK, listW);
      return;
    }
    if (this.picker) {
      this.kid(this.list, "Keep this track in:", FADED, INK, listW);
      this.playlists.forEach((list, index) => {
        const active = index === this.picker?.sel;
        this.kid(this.list, `${active ? "> " : "  "}${list.name}`, active ? INK : PAPER, active ? PAPER : INK, listW);
      });
      const fresh = this.picker.sel === this.playlists.length;
      this.kid(this.list, `${fresh ? "> " : "  "}[New playlist]`, fresh ? INK : PAPER, fresh ? PAPER : INK, listW);
      this.kid(this.list, "Enter keeps, Esc walks away.", FADED, INK, listW);
      return;
    }
    if (this.view === "help") {
      const lines = helpLines();
      this.helpOffset = Math.min(this.helpOffset, Math.max(0, lines.length - visible));
      for (const helpLine of lines.slice(this.helpOffset, this.helpOffset + visible)) {
        this.kid(this.list, helpLine.text || " ", helpLine.dim ? FADED : PAPER, INK, listW);
      }
      return;
    }
    if (this.loading) {
      this.kid(this.list, `${this.loading}. The first visit takes a moment.`, PAPER, INK, listW);
      return;
    }
    if (!this.library) {
      this.kid(this.list, this.error || "The library did not load.", PAPER, INK, listW);
      this.kid(this.list, "Press q to leave, then sign in again.", FADED, INK, listW);
      return;
    }
    if (this.view === "search") this.kid(this.list, `Search: ${this.query}_`, PAPER, INK, listW);
    if (this.drill) {
      this.kid(this.list, this.drill.title, PAPER, INK, listW);
      this.kid(this.list, this.drill.sub, FADED, INK, listW);
    }
    if (!this.rows.length) {
      for (const empty of emptyState(this.view, this.query)) this.kid(this.list, empty, FADED, INK, listW);
      return;
    }
    if (this.sel < this.offset) this.offset = this.sel;
    if (this.sel >= this.offset + visible) this.offset = this.sel - visible + 1;
    const headroom = this.view === "search" || this.drill ? (this.view === "search" && this.drill ? 3 : 2) : 0;
    const slice = this.rows.slice(this.offset, this.offset + Math.max(1, visible - headroom));
    slice.forEach((row, index) => {
      const active = this.offset + index === this.sel;
      if (row.kind === "note") {
        this.kid(this.list, row.label, FADED, INK, listW);
        return;
      }
      const indent = "  ".repeat(Math.min(3, row.depth));
      const marker = row.kind === "artist" || row.kind === "album" ? (this.isOpen(row) ? "- " : "+ ") : active ? "> " : "  ";
      this.kid(this.list, `${indent}${marker}${row.label}`, active ? INK : PAPER, active ? PAPER : INK, listW);
      if (active && row.sub) this.kid(this.list, `${indent}  ${row.sub}`, FADED, INK, listW);
    });
  }

  private isOpen(row: Row): boolean {
    if (row.kind === "artist") return this.openArtists.has(row.id);
    if (row.kind === "album") return this.openAlbums.has(row.id);
    return false;
  }

  private paintSide(sideW: number): void {
    this.clearKids(this.side);
    const track = this.currentTrack();
    this.kid(this.side, "Now", FADED, INK, sideW);
    if (track) {
      const icon = this.paused ? "| " : "> ";
      this.kid(this.side, `${icon}${track.title}`, INK, PAPER, sideW);
      this.kid(this.side, `${track.artist} - ${track.album}`, FADED, INK, sideW);
      const barWidth = Math.max(8, sideW - 14);
      const fraction = this.dur > 0 ? this.pos / this.dur : 0;
      this.kid(this.side, `${formatTime(this.pos)} ${progressBar(fraction, barWidth)}`, PAPER, INK, sideW);
      const order = this.shuffle ? "shuffle" : "in order";
      this.kid(this.side, `${formatTime(this.dur)} vol ${Math.round(this.volume * 100)} ${order} repeat ${this.repeat}`, FADED, INK, sideW);
    } else {
      this.kid(this.side, "Nothing plays.", PAPER, INK, sideW);
      this.kid(this.side, "Enter starts a track.", FADED, INK, sideW);
    }
    this.kid(this.side, "─".repeat(Math.max(1, sideW)), FADED, INK, sideW);
    this.kid(this.side, "Next", FADED, INK, sideW);
    const upcoming = this.queueTracks.slice(this.queueIndex + 1, this.queueIndex + 8);
    if (!upcoming.length) {
      this.kid(this.side, "The queue ends here.", FADED, INK, sideW);
    }
    upcoming.slice(0, Math.max(0, this.listHeight() - 10)).forEach((next, at) => {
      this.kid(this.side, `${at + 1}. ${this.liked.has(next.id) ? "* " : ""}${next.title}`, PAPER, INK, sideW);
    });
  }

  private paintBottom(width: number): void {
    this.clearKids(this.bottom);
    const hints = "? help";
    const message = this.freshStatus() || (this.library ? "" : this.error) || hints;
    this.kid(this.bottom, message, message === hints ? FADED : PAPER, INK, width);
  }
}

function emptyState(view: View, query: string): string[] {
  if (view === "library") return ["No tracks here. The library is empty."];
  if (view === "search") return query ? [`Nothing matches ${query}.`] : ["Type to search the library."];
  if (view === "playlists") return ["No playlists yet. Press a on a track to start one."];
  if (view === "mixes") return ["No mixes yet. Play more music first."];
  if (view === "lyrics") return ["Play a track to read its words."];
  if (view === "queue") return ["The queue is empty. Press Enter on a track to play it."];
  return [""];
}

const HELP_COL = 26;

interface HelpRow {
  keys: string;
  desc: string;
}

const HELP_SECTIONS: { title: string; rows: HelpRow[] }[] = [
  { title: "Views", rows: [{ keys: "1-6, Tab", desc: "jump to a view, Tab walks on" }] },
  {
    title: "Move",
    rows: [
      { keys: "up down k j", desc: "move" },
      { keys: "PgUp PgDn", desc: "move one screen" },
      { keys: "Home End", desc: "first and last row" },
    ],
  },
  {
    title: "Open",
    rows: [
      { keys: "Enter", desc: "play a track, open a branch" },
      { keys: "Left Right", desc: "close and open a branch" },
    ],
  },
  {
    title: "Play",
    rows: [
      { keys: "Space", desc: "pause and resume" },
      { keys: "n p", desc: "next and previous track" },
      { keys: "[ ]", desc: "back and ahead 10 seconds" },
    ],
  },
  {
    title: "Sound",
    rows: [
      { keys: "- =", desc: "softer and louder" },
      { keys: "s", desc: "shuffle on and off" },
      { keys: "r", desc: "repeat off, all, one" },
    ],
  },
  {
    title: "Lists",
    rows: [
      { keys: "l", desc: "like, kept in You liked this!" },
      { keys: "a", desc: "keep a track in a playlist" },
      { keys: "d", desc: "remove a track from a playlist" },
    ],
  },
  {
    title: "Type",
    rows: [
      { keys: "type", desc: "filter, Space types a space" },
      { keys: "Backspace", desc: "delete a letter" },
    ],
  },
  {
    title: "Leave",
    rows: [
      { keys: "Esc", desc: "walk back" },
      { keys: "q", desc: "quit at once" },
      { keys: "?", desc: "this page" },
    ],
  },
];

const HELP_FOOT = [
  "Likes live in the playlist named You liked this!",
  "Sound plays through mpv or ffplay on this machine.",
];

function helpLines(): { text: string; dim: boolean }[] {
  const lines: { text: string; dim: boolean }[] = [{ text: "Keys", dim: false }];
  for (const section of HELP_SECTIONS) {
    lines.push({ text: "", dim: false });
    lines.push({ text: section.title, dim: false });
    for (const row of section.rows) {
      const left = `  ${row.keys} `;
      const dots = ".".repeat(Math.max(2, HELP_COL - left.length));
      lines.push({ text: `${left}${dots} ${row.desc}`, dim: false });
    }
  }
  lines.push({ text: "", dim: false });
  for (const foot of HELP_FOOT) lines.push({ text: foot, dim: true });
  lines.push({ text: `Build: ${RELAY_VERSION}`, dim: true });
  lines.push({ text: "Logs live in /tmp: tapes-tui.log, tapes-relay.log, tapes-mpv-*.log", dim: true });
  return lines;
}
