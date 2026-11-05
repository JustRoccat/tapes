# tapes-tui

Terminal client for Tapes. 

```
 1 Library  2 Search  3 Playlists  4 Mixes  5 Lyrics  6 Queue     Listener
+ Harbor Lights
  1 albums                                        Now
+ Tin Foil Parade                                 > Paper Lantern
                                                  Tin Foil Parade - Paper Moon
                                                  0:00 ----------
                                                  3:30 vol 90 in order repeat off
                                                  ────────────────────────
                                                  Next
                                                  1 Glass Harbor
? help
```

## Features

- Library tree: artists open into albums, albums open into tracks
- Search across tracks, albums, and artists as you type
- Playlists, mixes, and per-track recommendations from the server
- Lyrics view for the current track
- Likes kept in the "You liked this!" server playlist
- Queue, shuffle, repeat off/all/one, volume, seeking with live progress
- Listens reported past five seconds of real playback only
- Session restore: queue, track, position, and volume come back paused
- Cached chunks survive retries, replays, and backward seeks (up to 96 MB)
- Retries a dead chunk and a dead track before moving on, then holds
- Full keyboard control, help under `?`, quit with `q`

## Requirements

- [Bun](https://bun.sh) 1.3 or newer
- `mpv` for full playback, or `ffplay` as a fallback
- A running Tapes server and an access key for it


## Install and run

```bash
cd tui
bun install
bun src/main.ts
```

As a global command, from the `tui` directory:

```bash
bun install
bun link
tapes
```

The link needs `~/.bun/bin` on PATH. For one file with no Bun
needed at runtime, build a binary instead:

```bash
bun build --compile src/main.ts --outfile tapes
```

It is about 120 MB, runtime included. Copy it anywhere on PATH.

## Keys

| Key               | Action                              |
| ----------------- | ----------------------------------- |
| `1` to `6`, `Tab` | jump to a view, `Tab` walks on      |
| `up` `down` `k` `j` | move                             |
| `PgUp` `PgDn`     | move one screen                     |
| `Home` `End`      | first and last row                  |
| `Enter`           | play a track, open a branch         |
| `Left` `Right`    | close and open a branch             |
| `space`           | pause and resume                    |
| `n` `p`           | next and previous track             |
| `[` `]`           | back and ahead 10 seconds           |
| `-` `=`           | softer and louder                   |
| `s`               | shuffle on and off                  |
| `r`               | repeat off, all, one                |
| `l`               | like, kept in You liked this!       |
| `a`               | keep a track in a playlist          |
| `d`               | remove a track from a playlist      |
| type, `Backspace` | filter in search, delete a letter   |
| `Esc`             | walk back, clear the search         |
| `?`               | this page, with every shortcut      |
| `q`               | quit at once                        |


## Files

| Path                               | What                                     |
| ---------------------------------- | ---------------------------------------- |
| `~/.config/tapes/session`          | session cookie, mode 0600, about 30 days |
| `/tmp/tapes-tui.log`               | app log, newest lines matter             |
| `/tmp/tapes-relay.log`             | chunk relay log with retry history       |
| `/tmp/tapes-mpv-*.log`             | mpv log with the exit reason             |

Delete the session file to sign out. The next start asks for the key
again. An expired session does the same on its own.

## Troubleshooting

- `That access key is not valid.` The key is wrong, type it again.
- `The music server is not answering. Check the address.` The server
  is down or you connection is broken.
  `No sound: <reason>.` The player died at once, the reason names it.
  Install `mpv` if it is missing.
- `Playback keeps stopping (...). Press Enter to try this track again.`
  Two tracks died in a row, so the client holds the queue instead of
  skipping through it. Press `Enter` when the server is back.
- A stuck track ends with `Left <title> after <time>: <reason>.` Send
  the three log files above with a bug report.

## Checks

```bash
bun test
bunx tsc --noEmit
```

Tests use invented data and a fake server. They need no network and
no sound.

