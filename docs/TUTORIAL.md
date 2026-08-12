# Tutorial — from zero to zapping

Fifteen minutes, start to finish. You will install the integration on your Unfolded Circle
remote, connect it to OneTV, build an activity that turns everything on, and put your
favourite channels one button press away.

**Before you start**

- OneTV Connect installed on an **Apple TV** (Android TV support is coming)
- An Unfolded Circle Remote Two or Three on firmware **2.2.0 or newer**
  (*Settings → About* on the remote)
- A computer on the same network with **Node.js 20+** installed
  (`node --version` to check)

---

## 1. Get the archive

Either download the ready-made `uc-intg-onetv-<version>.tar.gz` from the
[latest release](https://github.com/Seidel76/OneTV-unfolded-remote/releases/latest), or
build it yourself:

```bash
git clone https://github.com/Seidel76/OneTV-unfolded-remote.git
cd OneTV-unfolded-remote
./build.sh
```

You should see:

```
→ artifacts/uc-intg-onetv-0.1.1.tar.gz (268K)
```

There is no compiler and no Docker involved: the remote runs Node.js, so the script just
installs the dependencies and packs them.

---

## 2. Wake up OneTV

Open the OneTV app on the device you want to control and **leave it in the foreground**.
Two reasons:

- discovery only works while the app is running
- the app advertises its API key over mDNS, which saves you typing it

If your remote and the device are on different VLANs or subnets, discovery will not work
— note the device's IP address now, you will enter it manually in step 4.

---

## 3. Upload the integration

Open the remote's **Web Configurator** in a browser (its address is shown under
*Settings → Network* on the remote), then:

1. Go to **Integrations**
2. Click **Add new**
3. Choose **Install custom**
4. Select `uc-intg-onetv-<version>.tar.gz` and upload

The integration appears in the list, not configured yet.

---

## 4. Run the setup wizard

Click the integration to start setup. You will see four fields:

| Field | What to do |
|---|---|
| **IP address** | **Leave empty.** The driver searches the network for OneTV. |
| **Port** | Leave `8765` unless you changed it in the app. |
| **API key** | Leave empty — it is picked up automatically. |
| **Language of the media browser** | English or French. |
| **List all channels as sources** | Leave off for now (see step 7). |

Press **Next**.

- **One device found** → setup completes immediately.
- **Several found** → pick yours from the dropdown (each entry shows its name and IP).
- **None found** → the wizard offers manual entry. Type the IP you noted in step 2 and
  keep port `8765`.

When it finishes you get two new entities:

- `OneTV` — the media player
- `OneTV remote` — the command surface

---

## 5. Add them to a page

Still in the Web Configurator:

1. Open the page (or create one) where you want OneTV
2. **Add entity** → pick `OneTV`
3. **Add entity** → pick `OneTV remote`

Grab your remote. The media player tile shows what is playing — for a live channel, the
title is the **programme currently airing**, not just the channel name.

---

## 6. Browse the catalogue

On the media player tile, open the **media browser**. You land on five entries:

```
Favorites             your starred channels, each with the programme now airing
Channels by category  the categories of your line-up
Movies                VOD categories, then movies
TV shows              VOD categories, then shows, then episodes
Continue watching     what you started, with a completion percentage
```

Open *Channels by category → any category*: every channel shows what is on right now and
how far along it is, for example `FRANCE 3 — Avant que les flammes ne s'éteignent · 17 %`.

Pick anything to start playing it. Movies and episodes work the same way.

> Big line-ups load in pages, so nothing is downloaded in one lump. The first time you
> open a VOD category the app may need a moment to prepare it — the driver waits for you.

---

## 7. Choose what appears in the source list

By default the source list holds **your favourites only**, in playlist order. That keeps
`select_source` usable: an alphabetical list of 800 channels is impossible to use with a
thumb.

Want everything in there anyway? Re-run the setup and tick **List all channels as
sources**. Favourites stay on top; everything else follows alphabetically.

Either way, the full line-up remains reachable through the media browser.

---

## 8. Build a "Watch TV" activity

This is where it becomes a one-press experience.

1. **Activities → Add new**, name it *Watch TV*
2. **On sequence** — add the steps in this order:
   1. your TV → `power on` (and the right HDMI input if needed)
   2. your Apple TV → **`home`**
   3. *(optional)* a 3 s delay
   4. `OneTV remote` → `PLAY_PAUSE` or a favourite command such as `FAV_TF1`
3. **Off sequence** — `OneTV remote` → `STOP`, then your TV → `power off`

> **Why `home` and not `power on`?** Neither `turn_on` nor `power_on` wakes a sleeping
> Apple TV — only `home` does, and it takes around 8 seconds. And OneTV itself cannot
> launch: its `on` command deliberately answers *not implemented*. The Apple TV step is
> what gets the app back on screen.

---

## 9. Map the physical buttons

Inside the activity, open **Button mapping** and assign `OneTV remote` commands. The
driver already ships sensible defaults:

| Button | Short press | Long press |
|---|---|---|
| ▶️ Play | play / pause | — |
| ⏮ / ⏭ | seek ∓30 s | previous / next channel |
| CH ▲ / CH ▼ | next / previous channel | — |
| D-pad ◀ / ▶ | previous / next favourite | — |
| D-pad OK | play / pause | stop |
| VOL ▲ / ▼, Mute | volume, mute | — |

Change anything you like — for example put `BACK_TO_LIVE` on a colour button so you can
jump back to live after pausing.

---

## 10. Put favourites one press away

Every favourite channel from the app becomes a command named after it: `FAV_TF1`,
`FAV_BBC_ONE`, `FAV_CANAL_CINEMA_S`…

- Assign one to a **physical button** for instant zapping
- Or open the **Favorites** UI pages the driver generates: a grid of tappable names,
  20 per page

`FAVORITE_NEXT` and `FAVORITE_PREVIOUS` cycle through the list from whatever is playing —
they are on D-pad left/right by default.

> Add a favourite in the app later and it is immediately usable in the sources and in the
> cycle commands. It only appears as a `FAV_*` command after the integration restarts,
> because command lists are fixed when the entity is created.

---

## Where to go next

- Something not behaving? See [Troubleshooting](../README.md#troubleshooting).
- Curious about the design trade-offs? See [How it works](../README.md#how-it-works).
- Want to hack on it? `npm install && npm start` runs the driver on your computer, and the
  remote discovers it over mDNS — no upload needed between changes.
