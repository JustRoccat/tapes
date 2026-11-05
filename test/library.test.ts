import { describe, expect, test } from "bun:test";
import {
  albumKeyForTrack,
  buildLibrary,
  formatTime,
  progressBar,
  searchLibrary,
  sortTracks,
  truncate,
} from "../src/library.ts";

const streamFor = (id: string): string => `http://tapes.test/api/sonum/tracks/${id}/stream`;

function rawLibrary() {
  return {
    tracks: [
      { id: "t1", title: "North Wind", artist: "Harbor Lights, Mira Sol", album: "Winter Maps", album_artist: "Harbor Lights", duration_seconds: 210, added_at: 3 },
      { id: "t2", title: "North Wind", artist: "HARBOR LIGHTS", album: "Winter Maps", album_artist: "Harbor Lights", duration_seconds: 215, added_at: 2 },
      { id: "t3", title: "Glass Harbor", artist: "Harbor Lights & Mira Sol", album: "Winter Maps", album_artist: "Harbor Lights", duration_seconds: 190, added_at: 1 },
      { id: "t4", title: "Paper Moon", artist: "Tin Foil Parade", album: "Paper Moon", duration_seconds: 160, added_at: 4 },
    ],
    albums: [
      { name: "Winter Maps", artist: "Harbor Lights", track_ids: ["t1", "t3"] },
      { name: "Winter Maps", artist: "HARBOR LIGHTS", track_ids: ["t2"] },
      { name: "Paper Moon", artist: "Tin Foil Parade", track_ids: ["t4"] },
    ],
    artists: [
      { name: "Harbor Lights", track_ids: ["t1"] },
      { name: "HARBOR LIGHTS", track_ids: ["t2"] },
      { name: "Harbor Lights, Mira Sol", track_ids: ["t1"] },
      { name: "Harbor Lights & Mira Sol", track_ids: ["t3"] },
      { name: "Tin Foil Parade", track_ids: ["t4"] },
    ],
  };
}

describe("artist merging", () => {
  test("folds spellings and credits into one artist", () => {
    const library = buildLibrary(rawLibrary().tracks, rawLibrary().albums, rawLibrary().artists, streamFor);
    const names = library.artists.map((artist) => artist.name).sort();
    expect(names).toEqual(["Harbor Lights", "Tin Foil Parade"]);
    const harbor = library.artistsByName.get("Harbor Lights & Mira Sol");
    expect(harbor?.name).toBe("Harbor Lights");
    expect(harbor?.trackIds.sort()).toEqual(["t1", "t2", "t3"]);
  });
});

describe("album merging", () => {
  test("joins the same record under two spellings", () => {
    const library = buildLibrary(rawLibrary().tracks, rawLibrary().albums, rawLibrary().artists, streamFor);
    expect(library.albums).toHaveLength(2);
    const winter = library.albumsByKey.get(albumKeyForTrack({ album: "Winter Maps", albumArtist: "Harbor Lights", artist: "Harbor Lights" }));
    expect(winter?.trackIds.sort()).toEqual(["t1", "t2", "t3"]);
  });
});

describe("search and sort", () => {
  test("search matches title, artist and album", () => {
    const library = buildLibrary(rawLibrary().tracks, rawLibrary().albums, rawLibrary().artists, streamFor);
    expect(searchLibrary(library, "paper").tracks.map((track) => track.id)).toEqual(["t4"]);
    expect(searchLibrary(library, "harbor").artists.map((artist) => artist.name)).toEqual(["Harbor Lights"]);
    expect(searchLibrary(library, "")).toEqual({ tracks: [], albums: [], artists: [] });
  });

  test("newest tracks sort by arrival", () => {
    const library = buildLibrary(rawLibrary().tracks, rawLibrary().albums, rawLibrary().artists, streamFor);
    expect(sortTracks(library.tracks, "addedDesc").map((track) => track.id)).toEqual(["t4", "t1", "t2", "t3"]);
  });
});

describe("screen helpers", () => {
  test("long titles end with an ellipsis instead of breaking the row", () => {
    expect(truncate("North Wind Blowing Hard", 10)).toBe("North Win…");
    expect(truncate("Short", 10)).toBe("Short");
    expect(truncate("Anything", 0)).toBe("");
  });

  test("times read as minutes and seconds", () => {
    expect(formatTime(210)).toBe("3:30");
    expect(formatTime(61)).toBe("1:01");
  });

  test("the bar fills in proportion", () => {
    expect(progressBar(0.5, 10)).toBe("=====-----");
    expect(progressBar(0, 4)).toBe("----");
    expect(progressBar(1, 3)).toBe("===");
  });
});
