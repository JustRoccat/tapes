const MESSAGES: Record<string, string> = {
  sonum_unreachable: "The music server is not answering",
  unauthenticated: "Your session ended. Sign in again.",
  invalid_key: "That access key is not valid.",
  already_configured: "An owner account already exists.",
  key_required: "Enter your access key.",
  key_too_short: "The key needs at least 12 characters.",
  name_required: "Enter a name.",
  forbidden: "You do not have access to that.",
  bad_albums: "Pick which albums to bring in.",
  no_such_job: "That search is no longer here.",
  scrape_cooldown: "A search just went out. Wait a few minutes.",
  method_not_allowed: "That cannot be done here.",
  not_found: "That is not here anymore.",
  track_ids_required: "Pick at least one track first.",
};

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, body: { error?: string } | null) {
    super(MESSAGES[body?.error ?? ""] ?? `Request failed (${status})`);
    this.status = status;
    this.code = body?.error ?? "";
  }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface PlayerState {
  trackId: string;
  queue: string[];
  positionMs: number;
  volume: number;
  shuffle: boolean;
  repeat: string;
}

export interface ListenRow {
  trackId: string;
  startedAt: number;
  playedMs: number;
  durationMs: number;
  finished: boolean;
  source: string;
}

const SESSION_COOKIE = "sonum_session";

export class ApiClient {
  readonly baseUrl: string;
  private fetchFn: FetchFn;
  // memory only, never written to disk
  private cookie = "";

  constructor(baseUrl: string, fetchFn: FetchFn = globalThis.fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchFn = fetchFn;
  }

  get sessionCookie(): string {
    return this.cookie;
  }

  setSessionCookie(cookie: string): void {
    this.cookie = cookie;
  }

  streamUrl(id: string): string {
    return `${this.baseUrl}/api/sonum/tracks/${encodeURIComponent(id)}/stream`;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      headers[key.toLowerCase()] = String(value);
    }
    if (this.cookie) headers["cookie"] = `${SESSION_COOKIE}=${this.cookie}`;
    const response = await this.fetchFn(this.baseUrl + path, { ...options, headers });
    const setCookie = response.headers.get("set-cookie") ?? "";
    const session = /(?:^|;\s*)sonum_session=([^;]*)/.exec(setCookie)?.[1];
    if (session !== undefined) this.cookie = session;
    const type = response.headers.get("content-type") ?? "";
    const body = type.includes("application/json") ? await response.json().catch(() => null) : null;
    if (!response.ok) throw new ApiError(response.status, body as { error?: string } | null);
    return body as T;
  }

  setup(): Promise<{ ready: boolean }> {
    return this.request("/api/setup");
  }

  setupOwner(name: string, key: string): Promise<{ account: unknown; key: string }> {
    return this.request("/api/setup", { method: "POST", body: JSON.stringify({ name, key }) });
  }

  login(key: string): Promise<{ account: { id: string; name: string } }> {
    return this.request("/api/login", { method: "POST", body: JSON.stringify({ key }) });
  }

  session(): Promise<{ account: { id: string; name: string } }> {
    return this.request("/api/session");
  }

  library(): Promise<{ tracks: unknown[]; albums: unknown[]; artists: unknown[] }> {
    return this.request("/api/library");
  }

  playlists(): Promise<{ playlists: { id: string; name: string }[] }> {
    return this.request("/api/playlists");
  }

  playlistDetail(id: string): Promise<{ playlist: { id: string; name: string }; trackIds: string[] }> {
    return this.request(`/api/playlists/${id}`);
  }

  createPlaylist(name: string): Promise<{ playlist: { id: string; name: string } }> {
    return this.request("/api/playlists", { method: "POST", body: JSON.stringify({ name }) });
  }

  addTracks(id: string, trackIds: string[]): Promise<unknown> {
    return this.request(`/api/playlists/${id}/tracks`, {
      method: "POST",
      body: JSON.stringify({ trackIds }),
    });
  }

  removeTrack(id: string, trackId: string): Promise<unknown> {
    return this.request(`/api/playlists/${id}/tracks/${trackId}`, { method: "DELETE" });
  }

  mixes(): Promise<{ mixes: { name: string; trackIds: string[] }[]; madeAt: number }> {
    return this.request("/api/mixes");
  }

  recommendations(limit = 12): Promise<{ picks: { trackId: string; reason: string; key: string }[] }> {
    return this.request(`/api/recommendations?limit=${limit}`);
  }

  lyrics(id: string): Promise<{ lyrics: string }> {
    return this.request(`/api/lyrics/${encodeURIComponent(id)}`);
  }

  reportListens(listens: ListenRow[]): Promise<unknown> {
    return this.request("/api/listens", { method: "POST", body: JSON.stringify({ listens }) });
  }

  playerState(): Promise<{ state: PlayerState | null }> {
    return this.request("/api/player/state");
  }

  savePlayerState(state: PlayerState): Promise<unknown> {
    return this.request("/api/player/state", { method: "POST", body: JSON.stringify(state) });
  }
}
