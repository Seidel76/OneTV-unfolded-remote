"use strict";

/**
 * Test bout-en-bout du driver contre le faux OneTV, sans Remote physique.
 * Parle le WebSocket Integration-API comme le ferait la Remote.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.dirname(__dirname);
const FAKE_PORT = 18765;
const WS_PORT = 19090;

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failures.push(label);
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class RemoteClient {
  constructor(ws) {
    this.ws = ws;
    this.events = [];
    this.pending = new Map();
    this.waiters = [];
    ws.addEventListener("message", (event) => {
      const data = JSON.parse(event.data);
      if (data.req_id !== undefined && this.pending.has(data.req_id)) {
        this.pending.get(data.req_id)(data);
        this.pending.delete(data.req_id);
        return;
      }
      this.events.push(data);
      for (const waiter of this.waiters.splice(0)) {
        waiter(data);
      }
    });
  }

  request(id, msg, msgData = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout sur ${msg}`)), 20000);
      this.pending.set(id, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      this.ws.send(JSON.stringify({ kind: "req", id, msg, msg_data: msgData }));
    });
  }

  /**
   * ⚠️ `fromNow` est indispensable quand on rejoue une action déjà faite : sinon
   * l'événement de la PREMIÈRE exécution est encore dans la file et le test continue
   * avant que la seconde ait abouti (faux échec très convaincant).
   */
  async waitEvent(predicate, timeoutMs = 15000, fromNow = false) {
    if (fromNow) {
      this.events.length = 0;
    }
    const existing = this.events.find(predicate);
    if (existing) {
      return existing;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout sur event")), timeoutMs);
      const onEvent = (data) => {
        if (predicate(data)) {
          clearTimeout(timer);
          resolve(data);
        } else {
          this.waiters.push(onEvent);
        }
      };
      this.waiters.push(onEvent);
    });
  }
}

async function run() {
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "onetv-cfg-"));
  const fake = spawn(process.execPath, [path.join(__dirname, "fakeOneTV.js"), String(FAKE_PORT)]);
  const commands = [];
  fake.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.startsWith("CMD ")) {
        commands.push(JSON.parse(line.slice(4)));
      }
    }
  });

  const driver = spawn(process.execPath, [path.join(ROOT, "src", "driver.js")], {
    env: {
      ...process.env,
      UC_CONFIG_HOME: configHome,
      UC_INTEGRATION_INTERFACE: "127.0.0.1",
      UC_INTEGRATION_HTTP_PORT: String(WS_PORT),
      UC_DISABLE_MDNS_PUBLISH: "true"
    }
  });
  let driverLog = "";
  driver.stdout.on("data", (chunk) => {
    driverLog += chunk;
  });
  driver.stderr.on("data", (chunk) => {
    driverLog += chunk;
  });

  await sleep(1500);

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
      setTimeout(() => reject(new Error("connexion WS impossible")), 10000);
    });
    const remote = new RemoteClient(ws);

    console.log("→ setup du driver (adresse manuelle)");
    let res = await remote.request(1, "setup_driver", {
      driver_id: "onetv",
      setup_data: { host: "127.0.0.1", port: String(FAKE_PORT), api_key: "" }
    });
    check("setup accepté", res.code === 200, JSON.stringify(res));

    const setupEvent = await remote.waitEvent(
      (data) => data.msg === "driver_setup_change" && ["OK", "ERROR"].includes(data.msg_data.state)
    );
    check("setup terminé OK", setupEvent.msg_data.state === "OK", JSON.stringify(setupEvent.msg_data));

    console.log("→ entités disponibles");
    res = await remote.request(2, "get_available_entities", {});
    const entities = res.msg_data.available_entities || [];
    const ids = entities.map((entity) => entity.entity_id);
    check("media_player publié", ids.some((id) => id.startsWith("media_player.")), JSON.stringify(ids));
    check("remote publié", ids.some((id) => id.startsWith("remote.")), JSON.stringify(ids));

    const mpId = ids.find((id) => id.startsWith("media_player."));
    const rmId = ids.find((id) => id.startsWith("remote."));

    const remoteEntity = entities.find((entity) => entity.entity_id === rmId);
    const uiPages = (remoteEntity.options || {}).user_interface || {};
    check(
      "pages d'UI sérialisées (principale + favoris)",
      Array.isArray(uiPages.pages) && uiPages.pages.length === 2 && uiPages.pages[0].items.length >= 8,
      JSON.stringify((uiPages.pages || []).map((page) => page.page_id))
    );
    check(
      "mapping des touches sérialisé",
      Array.isArray((remoteEntity.options || {}).button_mapping) &&
        remoteEntity.options.button_mapping.length >= 8,
      JSON.stringify((remoteEntity.options || {}).button_mapping || []).slice(0, 200)
    );

    const simple = (remoteEntity.options || {}).simple_commands || [];
    check(
      "commandes favorites générées",
      simple.includes("FAV_TF1") && simple.includes("FAV_CANAL_CINEMA_S"),
      JSON.stringify(simple.filter((name) => name.startsWith("FAV_")))
    );
    check(
      "cycle favoris exposé",
      simple.includes("FAVORITE_NEXT") && simple.includes("FAVORITE_PREVIOUS"),
      JSON.stringify(simple.slice(0, 5))
    );
    const favPage = (uiPages.pages || []).find((page) => page.page_id === "onetv_fav_1");
    check(
      "page d'UI Favoris",
      Boolean(favPage) && favPage.items.length === 3,
      favPage ? `${favPage.items.length} items` : "absente"
    );
    check(
      "bouton d'UI câblé sur la bonne commande",
      Boolean(favPage) &&
        favPage.items.some(
          (item) => item.text === "CANAL+ CINEMA(S)" && item.command.params.command === "FAV_CANAL_CINEMA_S"
        ),
      favPage ? JSON.stringify(favPage.items[2]) : ""
    );

    console.log("→ abonnement (l'état réel arrive avec entity_change)");
    await remote.request(3, "subscribe_events", { entity_ids: [mpId, rmId] });
    const change = await remote.waitEvent(
      (data) => data.msg === "entity_change" && data.msg_data.entity_id === mpId
    );
    const attrs = change.msg_data.attributes || {};

    check("état = PLAYING", attrs.state === "PLAYING", String(attrs.state));
    check("titre = programme EPG", attrs.media_title === "Le 19.45", String(attrs.media_title));
    check("source = chaîne", attrs.source === "M6", String(attrs.source));
    // Par DÉFAUT, `source_list` = les favoris SEULS, dans l'ordre de la playlist : le
    // reste du catalogue se parcourt par catégories dans le navigateur de médias.
    check(
      "sources = favoris seuls par défaut, ordre préservé",
      JSON.stringify(attrs.source_list) === JSON.stringify(["TF1", "M6", "CANAL+ CINEMA(S)"]),
      JSON.stringify(attrs.source_list)
    );
    check("pas de durée en direct", attrs.media_duration === undefined, String(attrs.media_duration));
    check("volume 0..100", attrs.volume === 60, String(attrs.volume));

    console.log("→ commandes");
    const command = (id, entity, cmdId, params = {}) =>
      remote.request(id, "entity_command", {
        entity_id: entity,
        entity_type: entity.split(".")[0],
        cmd_id: cmdId,
        params
      });

    res = await command(10, mpId, "play_pause");
    check("play_pause accepté", res.code === 200, JSON.stringify(res));

    res = await command(11, mpId, "select_source", { source: "TF1" });
    check("select_source accepté", res.code === 200, JSON.stringify(res));

    res = await command(12, mpId, "select_source", { source: "Chaîne Inconnue" });
    check("source inconnue → 404", res.code === 404, JSON.stringify(res));

    res = await command(13, mpId, "volume", { volume: 40 });
    check("volume accepté", res.code === 200, JSON.stringify(res));

    res = await command(14, mpId, "audio_track");
    check("piste audio suivante", res.code === 200, JSON.stringify(res));

    res = await command(15, rmId, "send_cmd", { command: "BACK_TO_LIVE" });
    check("remote BACK_TO_LIVE", res.code === 200, JSON.stringify(res));

    res = await command(16, rmId, "send_cmd", { command: "PAS_UNE_COMMANDE" });
    check("commande inconnue → 501", res.code === 501, JSON.stringify(res));

    res = await command(17, mpId, "on");
    check("on → 501 (l'app ne s'allume pas seule)", res.code === 501, JSON.stringify(res));

    res = await command(18, rmId, "send_cmd_sequence", {
      sequence: ["CHANNEL_NEXT", "CHANNEL_NEXT", "BACK_TO_LIVE"]
    });
    check("séquence d'activité", res.code === 200, JSON.stringify(res));

    res = await command(19, rmId, "send_cmd", { command: "FAV_CANAL_CINEMA_S" });
    check("favori lancé par commande", res.code === 200, JSON.stringify(res));

    res = await command(20, rmId, "send_cmd", { command: "FAVORITE_NEXT" });
    check("favori suivant", res.code === 200, JSON.stringify(res));

    res = await command(21, rmId, "send_cmd", { command: "FAV_INEXISTANTE" });
    check("favori inconnu → 404", res.code === 404, JSON.stringify(res));

    console.log("→ navigateur de médias");
    const browse = async (id, mediaId, paging) => {
      const res2 = await remote.request(id, "browse_media", {
        entity_id: mpId,
        media_id: mediaId,
        paging: paging || { page: 1, limit: 50 }
      });
      return (res2.msg_data && res2.msg_data.media) || {};
    };

    let node = await browse(30, "");
    let titles = (node.items || []).map((entry) => entry.title);
    check(
      "racine en anglais par défaut",
      JSON.stringify(titles) ===
        JSON.stringify(["Favorites", "Channels by category", "Movies", "TV shows", "Continue watching"]),
      JSON.stringify(titles)
    );

    node = await browse(31, "favorites");
    check(
      "favoris navigables et jouables",
      (node.items || []).length === 3 && node.items[0].media_id === "channel:chan-2" && node.items[0].can_play,
      JSON.stringify((node.items || []).map((entry) => entry.media_id))
    );

    node = await browse(32, "channels");
    // ARTE n'a pas de catégorie dans le flux : elle doit rester atteignable via le
    // panier « Sans catégorie », sinon une partie du bouquet est invisible.
    check(
      "catégories de chaînes + panier sans catégorie",
      JSON.stringify((node.items || []).map((entry) => entry.title)) ===
        JSON.stringify(["FRANCE FHD", "CINÉMA", "Uncategorized"]),
      JSON.stringify((node.items || []).map((entry) => entry.title))
    );

    const orphanId = node.items[2].media_id;
    node = await browse(320, orphanId);
    check(
      "chaînes sans catégorie listées",
      JSON.stringify((node.items || []).map((entry) => entry.title)) === JSON.stringify(["ARTE"]),
      JSON.stringify((node.items || []).map((entry) => entry.title))
    );
    node = await browse(321, "channels");

    node = await browse(33, "channels:FRANCE FHD");
    check(
      "chaînes d'une catégorie (séparateur exclu)",
      JSON.stringify((node.items || []).map((entry) => entry.title)) === JSON.stringify(["M6", "TF1"]),
      JSON.stringify((node.items || []).map((entry) => entry.title))
    );
    // Le programme en cours vient de `/api/v1/now` : `/api/v1/channels` n'en a pas.
    check(
      "programme en cours affiché dans la catégorie",
      (node.items || [])[0] && node.items[0].subtitle === "Le 19.45 · 10 %",
      JSON.stringify((node.items || []).map((entry) => entry.subtitle))
    );

    node = await browse(331, "favorites");
    check(
      "programme en cours affiché dans les favoris",
      (node.items || [])[0] && node.items[0].subtitle === "Le 20h · 44 %",
      JSON.stringify((node.items || []).map((entry) => entry.subtitle))
    );

    node = await browse(34, "movies");
    check(
      "catégories de films, préfixe provider nettoyé",
      (node.items || [])[0] && node.items[0].title === "NOUVEAUTÉS" && node.items[0].media_id === "movies:21",
      JSON.stringify((node.items || [])[0])
    );

    node = await browse(35, "movies:21");
    check(
      "films d'une catégorie",
      (node.items || []).length === 2 && node.items[0].media_id === "movie:742976" && node.items[0].can_play,
      JSON.stringify((node.items || []).map((entry) => entry.title))
    );

    node = await browse(36, "series:1351");
    check(
      "séries d'une catégorie (containers)",
      (node.items || []).length === 1 && node.items[0].media_id === "serie:2456" && node.items[0].can_browse,
      JSON.stringify((node.items || [])[0])
    );

    // Le premier appel renvoie `loading: true` : sans ré-appel la liste serait vide.
    node = await browse(37, "serie:2456");
    check(
      "épisodes malgré le « loading + rappel », titres réels",
      (node.items || []).length === 2 &&
        node.items[0].media_id === "episode:2456:1:1" &&
        node.items[0].title === "Ted Lasso S01E01 (MULTi)",
      JSON.stringify((node.items || []).map((entry) => `${entry.media_id} ${entry.title}`))
    );

    node = await browse(38, "resume");
    check(
      "reprendre",
      (node.items || []).length === 1 && node.items[0].media_id === "movie:742966",
      JSON.stringify((node.items || [])[0])
    );

    node = await browse(39, "channels:FRANCE FHD", { page: 2, limit: 1 });
    check(
      "pagination respectée",
      (node.items || []).length === 1 && node.items[0].title === "TF1",
      JSON.stringify((node.items || []).map((entry) => entry.title))
    );

    console.log("→ langue française optionnelle");
    // Le setup est rejoué avec `language: fr` : les libellés doivent basculer sans
    // toucher aux identifiants (`media_id` reste stable, c'est de la donnée).
    remote.events.length = 0;
    await remote.request(50, "setup_driver", {
      driver_id: "onetv",
      setup_data: { host: "127.0.0.1", port: String(FAKE_PORT), api_key: "", language: "fr" }
    });
    await remote.waitEvent(
      (data) => data.msg === "driver_setup_change" && ["OK", "ERROR"].includes(data.msg_data.state),
      15000
    );
    node = await browse(51, "");
    check(
      "libellés en français quand demandé",
      JSON.stringify((node.items || []).map((entry) => entry.title)) ===
        JSON.stringify(["Favoris", "Chaînes par catégorie", "Films", "Séries", "Reprendre"]),
      JSON.stringify((node.items || []).map((entry) => entry.title))
    );
    check(
      "identifiants inchangés par la langue",
      JSON.stringify((node.items || []).map((entry) => entry.media_id)) ===
        JSON.stringify(["favorites", "channels", "movies", "series", "resume"]),
      JSON.stringify((node.items || []).map((entry) => entry.media_id))
    );

    console.log("→ lecture depuis le navigateur");
    res = await command(40, mpId, "play_media", { media_id: "movie:742976" });
    check("play_media film", res.code === 200, JSON.stringify(res));

    res = await command(41, mpId, "play_media", { media_id: "episode:2456:1:2" });
    check("play_media épisode", res.code === 200, JSON.stringify(res));

    res = await command(42, mpId, "play_media", { media_id: "channel:chan-4" });
    check("play_media chaîne", res.code === 200, JSON.stringify(res));

    ws.close();
  } finally {
    driver.kill();
    fake.kill();
    await sleep(300);
  }

  console.log("\n=== commandes reçues par le faux OneTV ===");
  for (const entry of commands) {
    console.log(" ", JSON.stringify(entry));
  }
  const names = commands.map((entry) => entry.command);
  const expected = [
    "togglePlayPause",
    "playChannel",
    "setVolume",
    "setAudioTrack",
    "seekToLive",
    "nextChannel"
  ];
  const missing = expected.filter((name) => !names.includes(name));
  check(`commandes app: ${expected.join(", ")}`, missing.length === 0, `manquant ${missing}`);

  const playChannel = commands.find((entry) => entry.command === "playChannel");
  check(
    "playChannel a résolu TF1 → chan-2",
    playChannel && playChannel.params.channelId === "chan-2",
    JSON.stringify(playChannel)
  );

  const favPlays = commands.filter(
    (entry) => entry.command === "playChannel" && entry.params.channelId === "chan-4"
  );
  check("FAV_CANAL_CINEMA_S → chan-4", favPlays.length >= 1, `${favPlays.length} appel(s)`);

  // FAVORITE_NEXT part de la chaîne en cours (M6, 2e favori) → CANAL+ (3e).
  const afterNext = commands[commands.length - 1];
  check(
    "FAVORITE_NEXT enchaîne depuis la chaîne en cours",
    afterNext.command === "playChannel" && afterNext.params.channelId === "chan-4",
    JSON.stringify(afterNext)
  );
  check(
    "requestId présent partout (sinon 400 côté app)",
    commands.every((entry) => Boolean(entry.requestId)),
    "manquant sur au moins une commande"
  );

  const movie = commands.find((entry) => entry.command === "playMovie");
  check("playMovie envoyé avec movieId", Boolean(movie) && movie.params.movieId === "742976", JSON.stringify(movie));
  const episode = commands.find((entry) => entry.command === "playEpisode");
  check(
    "playEpisode envoyé avec seriesId/saison/épisode",
    Boolean(episode) &&
      episode.params.seriesId === "2456" &&
      episode.params.seasonNumber === 1 &&
      episode.params.episodeNumber === 2,
    JSON.stringify(episode)
  );

  console.log(`\n${failures.length ? `ÉCHECS: ${failures.join(", ")}` : "TOUT PASSE ✅"}`);
  if (failures.length) {
    console.log("\n--- log driver ---\n" + driverLog.slice(-3000));
  }
  process.exit(failures.length ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
