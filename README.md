# OneTV integration for Unfolded Circle Remote Two / Three

Control the **OneTV Connect** app running on an Apple TV, iPhone or iPad from an
[Unfolded Circle](https://www.unfoldedcircle.com/) remote: zapping, transport controls,
favourites, and a full media browser with live EPG, movies and TV shows.

It talks to the app's local HTTP remote API — the same one the
[Home Assistant integration](https://github.com/Seidel76/noopy-tv-homeassistant) uses.
Everything stays on your network; nothing is sent to a third party.

> **No build tooling required.** The remote ships a Node.js runtime, so the driver is
> plain JavaScript: `npm install`, tar it up, upload. The archive is ~270 KB.

---

## Contents

- [What you get](#what-you-get)
- [Requirements](#requirements)
- [**Tutorial: from zero to zapping**](docs/TUTORIAL.md)
- [Quick install](#quick-install)
- [Media browser](#media-browser)
- [Favourites](#favourites)
- [Command reference](#command-reference)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [How it works](#how-it-works)
- [License](#license)

---

## What you get

The integration exposes **two entities** per OneTV device.

### `media_player`

| Capability | Detail |
|---|---|
| State | playing / paused / buffering / on / off |
| Now playing | current **EPG programme** title (not just the channel name), artwork, channel |
| Position | duration and position for movies and episodes |
| Volume | playback engine volume, mute toggle |
| Sources | favourite channels (optionally the whole line-up) |
| Transport | play/pause, stop, seek ±30 s, absolute seek, back to live |
| Zapping | next / previous channel |
| Tracks | cycle audio tracks and subtitles |
| Browsing | full media browser, see below |

### `remote`

Simple commands you can drop into activities and macros, a physical button mapping, and
on-screen pages.

```
CHANNEL_NEXT · CHANNEL_PREVIOUS · BACK_TO_LIVE · PLAY · PAUSE · PLAY_PAUSE · STOP
SEEK_FORWARD_30 · SEEK_BACKWARD_30 · AUDIO_TRACK_NEXT · SUBTITLE_TRACK_NEXT
SUBTITLE_OFF · FAVORITE_NEXT · FAVORITE_PREVIOUS · MUTE_TOGGLE · VOLUME_UP · VOLUME_DOWN
```

…plus one command per favourite channel (`FAV_TF1`, `FAV_BBC_ONE`, …).

Default physical mapping:

| Button | Short press | Long press |
|---|---|---|
| ▶️ Play | play / pause | — |
| ⏮ Prev | seek −30 s | previous channel |
| ⏭ Next | seek +30 s | next channel |
| CH ▲ / CH ▼ | next / previous channel | — |
| VOL ▲ / VOL ▼ | volume up / down | — |
| Mute | mute toggle | — |
| D-pad ◀ / ▶ | previous / next favourite | — |
| D-pad OK | play / pause | stop |

---

## Requirements

- An Unfolded Circle **Remote Two** or **Remote Three**, firmware **2.2.0 or newer**
  (custom integration upload landed in 2.2.0).
- **OneTV Connect** running on an Apple TV, iPhone or iPad on the same network, with its
  HTTP remote API enabled.
- **Node.js 20+** and `npm` on the machine that builds the archive — not on the remote.

---

## Quick install

New to this? Follow the **[step-by-step tutorial](docs/TUTORIAL.md)** instead — it covers
the setup wizard, building an activity and mapping buttons.

```bash
git clone https://github.com/Seidel76/OneTV-unfolded-remote.git
cd OneTV-unfolded-remote
./build.sh
```

This produces `artifacts/uc-intg-onetv-<version>.tar.gz`. Prefer not to build? Grab the
archive from the [latest release](https://github.com/Seidel76/OneTV-unfolded-remote/releases/latest).

Then, in the remote's **Web Configurator**:

1. **Integrations → Add new → Install custom**
2. Upload the `.tar.gz`
3. Start the setup and leave the address **empty** — the driver finds the app over mDNS
   (`_noopytv._tcp`). If nothing answers, it offers manual entry instead of failing.
4. Add the `media_player` and `remote` entities to a page or an activity.

Prefer not to install anything on the remote? The driver also runs as an **external
integration** on any machine on the LAN (`npm start`); it advertises itself over mDNS and
the remote finds it under *Add new → Discover*. Handy while developing.

### Setup options

| Option | Default | Meaning |
|---|---|---|
| IP address | *(empty)* | Leave empty to auto-discover over mDNS |
| Port | `8765` | OneTV's HTTP API port |
| API key | *(empty)* | Auto-detected — the app advertises it |
| Language of the media browser | English | Browser screens and on-screen labels (English or French) |
| List all channels as sources | off | When off, `source_list` holds favourites only |

---

## Media browser

The catalogue is **never dumped flat**. The remote pages its requests and the driver
serves screens, mirroring the layout of the OneTV Apple Watch app:

```
OneTV
├── Favorites               your favourite channels, with the programme now airing
├── Channels by category    every category in your line-up (+ "Uncategorized")
│     └── <category>        channels + CURRENT PROGRAMME and how far along it is
├── Movies                  VOD categories
│     └── <category>        movies, playable
├── TV shows                VOD categories
│     └── <show>            episodes, playable
└── Continue watching       what you started, with the completion percentage
```

Browsing a category on a real device looks like this:

```
Channels of « FRANCE FHD »
  ▶️ TF1        — Programmes de la nuit · 20 %
  ▶️ FRANCE 2   — SCH - Decennium · 11 %
  ▶️ FRANCE 3   — Avant que les flammes ne s'éteignent · 17 %
  ▶️ ARTE       — Wakefield · 26 %
```

Selecting an item plays it: `play_media` routes `channel:<id>` to `playChannel`,
`movie:<id>` to `playMovie` and `episode:<show>:<season>:<number>` to `playEpisode`.

---

## Favourites

Channels you starred in the app are exposed three ways:

- **As sources** — favourites only by default, in playlist order. Tick *List all channels
  as sources* if you want the whole line-up in `select_source` too.
- **As commands** — `FAV_TF1`, `FAV_CANAL_CINEMA_S`… assignable to a physical button or an
  activity step. Plus `FAVORITE_NEXT` / `FAVORITE_PREVIOUS`, which cycle from whatever is
  playing (mapped to D-pad left/right).
- **As UI pages** — a grid of tappable names, 20 per page.

The order is never sorted: it is your playlist order, and it carries intent.

> Commands and UI pages are frozen when the entity is created, so they are read **when the
> driver starts**. A favourite added afterwards is usable straight away through the sources
> and `FAVORITE_NEXT`, but only shows up as a command after the integration restarts.
> Lookup itself is dynamic: a renamed favourite still resolves.

---

## Command reference

| Remote command | OneTV command (`POST /api/v1/player/command`) |
|---|---|
| `play_pause` | `togglePlayPause` |
| `stop`, `off` | `stop` |
| `next` / `previous`, CH+/CH− | `nextChannel` / `previousChannel` |
| `fast_forward` / `rewind` | `seekRelative` ±30 s |
| `seek` | `seekAbsolute` |
| `live` | `seekToLive` |
| `volume`, `volume_up` / `volume_down` | `setVolume`, `adjustVolume` |
| `mute_toggle` | `toggleMute` |
| `select_source` | `playChannel` (`channelId`, with a `url` fallback) |
| `audio_track` / `subtitle` | `setAudioTrack` / `setSubtitleTrack` (cycles) |
| `play_media` | `playChannel` / `playMovie` / `playEpisode` |

---

## Known limitations

Measured on real hardware, not assumed.

- **`on` returns 501.** OneTV's API cannot launch itself. In an activity, send an Apple TV
  `home` command first — neither `turn_on` nor `power_on` wakes a sleeping Apple TV, only
  `home` does (~8 s).
- **Volume is the playback engine's**, not the TV's.
- **No duration while watching live.** There, `duration` reports the depth of the timeshift
  buffer (~12 s); showing it would render a nonsensical progress bar.
- **Push updates are tvOS-only.** iOS answers `501` on the event stream and falls back to a
  5 s poll.
- **Decorative playlist separators** (`---●★| CINEMA |★●---`) are filtered out of the
  sources and of the browser.
- `/api/v1/favorites` only exists in recent app builds; on older ones the list stays empty
  without breaking anything else.
- There is no "recently watched channels" endpoint (`/api/v1/recents` answers 404), so the
  browser has no such section, unlike the Apple Watch app.

---

## Troubleshooting

**Setup can't find the app.** Make sure OneTV is in the foreground on the device and that
both are on the same subnet — mDNS does not cross VLANs. The wizard falls back to manual
entry; the IP and port `8765` are enough, the API key is optional.

**Entities exist but everything reads "off".** The driver reports `off` when the app is
unreachable. Open OneTV on the device; state recovers on the next poll (≤ 5 s).

**A category looks empty.** Categories load on demand and the app answers `loading: true`
on the first call; the driver retries for you. If it stays empty, that category has never
been opened on the TV and the app has nothing cached yet — open it there once.

**Commands return 501.** That command is not implemented by the app. `on` is the expected
one (see limitations).

**Nothing happens when selecting a source.** Source names come from the app; if you renamed
a channel there, re-run the setup so the driver picks up the new list.

**Reading the logs.** The driver logs to stdout with an `[onetv]` prefix. Run it locally
with `npm start` to watch a live session.

---

## Development

```bash
npm install
cp driver.json src/driver.json   # convenience for local runs, git-ignored
npm start                        # listens on :9090
```

Tests need no hardware — a fake OneTV server and a fake mDNS service are included:

```bash
node test/testDriver.js      # setup → entities → state → commands → browser
node test/testDiscovery.js   # mDNS discovery of _noopytv._tcp
```

`test/testDriver.js` speaks the WebSocket Integration API exactly like the remote does,
and asserts on the commands the **app actually received**, not just on return codes.

Against a real device (driver already running and pointed at it):

```bash
node test/testRealDevice.js --ws 19091   # READ ONLY, sends no command
node test/testRealBrowse.js  --ws 19091  # walks the real catalogue, read only
```

Project layout:

```
driver.json          integration metadata + setup form
src/driver.js        entry point, entity lifecycle
src/client.js        OneTV HTTP + SSE client
src/mediaPlayer.js   media_player entity, state mapping
src/remote.js        remote entity, buttons, UI pages
src/browse.js        media browser screens
src/favorites.js     favourite naming, lookup, cycling
src/discovery.js     mDNS discovery
src/setupFlow.js     setup wizard
src/i18n.js          user-facing strings (en / fr)
src/naming.js        playlist separator filter
```

---

## How it works

A few decisions worth knowing before changing anything:

- **Channels are only re-fetched when the app says they changed** (`channels_generation`
  from `/api/v1/info`, O(1) on the app side). Re-downloading 150k channels every cycle
  would make the TV work for nothing.
- **`/api/v1/channels` carries no EPG** (only `/api/v1/favorites` does). The current
  programme comes from **`/api/v1/now`** — one request for the whole line-up (~120 KB),
  cached 60 s and fetched only while browsing, never one request per channel on screen.
- **The favourites payload has no `stream_url`.** Each favourite is matched back to its
  playlist entry before playback, otherwise `playChannel` loses the URL fallback that
  survives playlist switches.
- **Episodes come back as `title` / `season` / `episode`** — not `name` / `seasonNumber` /
  `episodeNumber`. With the wrong keys every episode renders as "S1E1".
- **The browser assumes no completed poll.** The remote subscribes and opens the browser
  right away, so channels are loaded on demand; otherwise a category shows up empty.
- **Configured entities are never re-published** on a second setup run — removing them
  makes the remote's subscription answer 404. Data is resolved per call instead, so
  changing the language or the source policy takes effect without a restart.
- **`bonjour-service` throws from a timer** when multicast fails (`EHOSTUNREACH
  224.0.0.251`). Without an error callback that kills the whole driver, so one is passed
  and discovery returns an empty list instead.
- **`requestId` is mandatory on every command** — it is not optional on the Swift side, and
  the app answers `400 Invalid command JSON` without it.
- `media_player` and `remote` share one client: polling stops only once **both** entities
  are unsubscribed.

---

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Unfolded Circle. OneTV Connect is a separate application; this driver
only talks to its local API.
