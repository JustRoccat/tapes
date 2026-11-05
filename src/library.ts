export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  duration: number;
  addedAt: number;
  year: number | null;
  releaseMbid: string;
  stream: string;
}

export interface Album {
  name: string;
  artist: string;
  year: number | null;
  trackCount: number;
  trackIds: string[];
}

export interface Artist {
  name: string;
  aliases: string[];
  albumCount: number;
  trackIds: string[];
}

export interface Library {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
  byId: Map<string, Track>;
  albumsByKey: Map<string, Album>;
  artistsByName: Map<string, Artist>;
}

interface RawTrack {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  album_artist?: string;
  duration_seconds?: number;
  added_at?: number;
  year?: number | null;
  release_mbid?: string;
}

interface RawAlbum {
  name: string;
  artist: string;
  is_compilation?: boolean;
  year?: number | null;
  track_ids?: string[];
}

interface RawArtist {
  name: string;
  album_count?: number;
  track_ids?: string[];
}

export function albumKey(album: Pick<Album, "name" | "artist">): string {
  return `${album.name}|||${album.artist}`;
}

export function albumKeyForTrack(track: Pick<Track, "album" | "albumArtist" | "artist">): string {
  return `${track.album}|||${track.albumArtist || track.artist}`;
}

const fold = (name: string): string => name.trim().toLowerCase();
const isCredit = (name: string): boolean => name.includes("&") || name.includes(",");
const splitCredit = (name: string): string[] =>
  name.split(/[&,]/).map((part) => part.trim()).filter(Boolean);

export function mergeArtists(raw: RawArtist[]): Artist[] {
  const groups = new Map<string, { name: string; count: number; aliases: string[]; trackIds: string[] }>();
  const ensure = (name: string, count: number): { name: string; count: number; aliases: string[]; trackIds: string[] } => {
    const key = fold(name);
    let group = groups.get(key);
    if (!group) {
      group = { name, count, aliases: [], trackIds: [] };
      groups.set(key, group);
    }
    if (group.aliases.every((alias) => fold(alias) !== fold(name))) group.aliases.push(name);
    return group;
  };
  for (const artist of raw) {
    if (isCredit(artist.name)) continue;
    const group = ensure(artist.name, artist.album_count ?? 0);
    group.trackIds.push(...(artist.track_ids ?? []));
  }
  const islands: Artist[] = [];
  for (const artist of raw) {
    if (!isCredit(artist.name)) continue;
    // "A & B" folds into A when A is already here
    const owner = splitCredit(artist.name).map((part) => groups.get(fold(part))).find(Boolean);
    if (!owner) {
      islands.push({ name: artist.name, aliases: [artist.name], albumCount: 0, trackIds: [...(artist.track_ids ?? [])] });
      continue;
    }
    if (owner.aliases.every((alias) => fold(alias) !== fold(artist.name))) owner.aliases.push(artist.name);
    owner.trackIds.push(...(artist.track_ids ?? []));
  }
  return [...groups.values(), ...islands].map((group) => ({
    name: group.name,
    aliases: group.aliases,
    albumCount: 0,
    trackIds: [...new Set(group.trackIds)],
  }));
}

export function mergeAlbums(raw: RawAlbum[], tracks: Track[], artists: Artist[]): Album[] {
  const groupFold = new Map<string, string>();
  const display = new Map<string, string>();
  for (const artist of artists) {
    for (const alias of artist.aliases) groupFold.set(fold(alias), fold(artist.name));
    display.set(fold(artist.name), artist.name);
  }
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const parent = raw.map((_, index) => index);
  const head = (index: number): number => {
    while (parent[index] !== index) index = parent[index] ?? index;
    return index;
  };
  const keyToFirst = new Map<string, number>();
  // one record can sit as several rows: a shared release or title glues them
  raw.forEach((album, index) => {
    const counts = new Map<string, number>();
    for (const id of album.track_ids ?? []) {
      const release = byId.get(id)?.releaseMbid ?? "";
      if (release) counts.set(release, (counts.get(release) ?? 0) + 1);
    }
    const [release] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
    const artistKey = groupFold.get(fold(album.artist)) ?? fold(album.artist);
    for (const key of [release ? `mb:${release}` : "", `tt:${album.name.trim().toLowerCase()}~${artistKey}`]) {
      if (!key) continue;
      const first = keyToFirst.get(key);
      if (first === undefined) keyToFirst.set(key, head(index));
      else parent[head(index)] = head(first);
    }
  });
  const gathered = new Map<number, RawAlbum[]>();
  raw.forEach((album, index) => {
    const root = head(index);
    const rows = gathered.get(root);
    if (rows) rows.push(album);
    else gathered.set(root, [album]);
  });
  return [...gathered.values()].map((rows) => {
    const main = [...rows].sort((a, b) => (b.track_ids?.length ?? 0) - (a.track_ids?.length ?? 0))[0];
    if (!main) throw new Error("mergeAlbums met an empty group");
    const artistName = display.get(groupFold.get(fold(main.artist)) ?? fold(main.artist)) ?? main.artist;
    const seen = new Set<string>();
    const trackIds = rows
      .flatMap((row) => row.track_ids ?? [])
      .filter((id) => !seen.has(id) && (seen.add(id), true));
    return {
      name: main.name,
      artist: artistName,
      year: rows.map((row) => row.year).filter((year): year is number => !!year).sort((a, b) => b - a)[0] ?? null,
      trackCount: trackIds.length,
      trackIds,
    };
  });
}

export function normalizeTrack(raw: RawTrack, streamFor: (id: string) => string): Track {
  return {
    id: raw.id,
    title: raw.title || "Untitled",
    artist: raw.artist || "Unknown artist",
    album: raw.album || "Unknown album",
    albumArtist: raw.album_artist || raw.artist || "",
    duration: Number(raw.duration_seconds) || 0,
    addedAt: Number(raw.added_at) || 0,
    year: raw.year ?? null,
    releaseMbid: raw.release_mbid || "",
    stream: streamFor(raw.id),
  };
}

export function buildLibrary(
  rawTracks: RawTrack[],
  rawAlbums: RawAlbum[],
  rawArtists: RawArtist[],
  streamFor: (id: string) => string,
): Library {
  const tracks = rawTracks.map((raw) => normalizeTrack(raw, streamFor));
  const artists = mergeArtists(rawArtists);
  const albums = mergeAlbums(rawAlbums, tracks, artists);
  for (const artist of artists) {
    artist.albumCount = albums.filter((album) => artist.aliases.includes(album.artist)).length;
  }
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const albumsByKey = new Map<string, Album>();
  for (const album of albums) albumsByKey.set(albumKey(album), album);
  const artistsByName = new Map<string, Artist>();
  for (const artist of artists) {
    for (const alias of artist.aliases) artistsByName.set(alias, artist);
  }
  return { tracks, albums, artists, byId, albumsByKey, artistsByName };
}

export function sortTracks(tracks: Track[], mode: string): Track[] {
  const sorted = [...tracks];
  if (mode === "title") sorted.sort((a, b) => a.title.localeCompare(b.title));
  else if (mode === "addedAsc") sorted.sort((a, b) => a.addedAt - b.addedAt);
  else if (mode === "addedDesc") sorted.sort((a, b) => b.addedAt - a.addedAt);
  else sorted.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
  return sorted;
}

export function searchLibrary(library: Library, query: string): { tracks: Track[]; albums: Album[]; artists: Artist[] } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { tracks: [], albums: [], artists: [] };
  // same 50-row cap as the web client
  return {
    tracks: library.tracks
      .filter((track) => [track.title, track.artist, track.album].some((value) => value.toLowerCase().includes(needle)))
      .slice(0, 50),
    albums: library.albums
      .filter((album) => album.name.toLowerCase().includes(needle) || album.artist.toLowerCase().includes(needle))
      .slice(0, 50),
    artists: library.artists.filter((artist) => artist.name.toLowerCase().includes(needle)).slice(0, 50),
  };
}

export function tracksForAlbum(library: Library, album: Album): Track[] {
  return album.trackIds.map((id) => library.byId.get(id)).filter((track): track is Track => !!track);
}

export function truncate(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width || width <= 0) return width <= 0 ? "" : text;
  if (width === 1) return "…";
  return `${chars.slice(0, width - 1).join("")}…`;
}

export function formatTime(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function progressBar(fraction: number, width: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  return `${"=".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}`;
}
