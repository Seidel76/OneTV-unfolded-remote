"use strict";

/**
 * Parcourt le navigateur de médias d'un VRAI OneTV, en LECTURE SEULE.
 * Le driver doit déjà tourner et écouter sur `--ws`.
 *
 *   node test/testRealBrowse.js --ws 19091
 */

const args = process.argv.slice(2);
const wsPort = Number(args[args.indexOf("--ws") + 1]) || 19091;

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failures.push(label);
  }
};

async function run() {
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.req_id !== undefined && pending.has(data.req_id)) {
      pending.get(data.req_id)(data);
      pending.delete(data.req_id);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("driver injoignable en loopback")));
    setTimeout(() => reject(new Error("timeout WS")), 10000);
  });

  let id = 0;
  const request = (msg, msgData = {}) =>
    new Promise((resolve, reject) => {
      const reqId = (id += 1);
      const timer = setTimeout(() => reject(new Error(`timeout ${msg}`)), 40000);
      pending.set(reqId, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      ws.send(JSON.stringify({ kind: "req", id: reqId, msg, msg_data: msgData }));
    });

  const entities = (await request("get_available_entities", {})).msg_data.available_entities || [];
  const mpId = entities.map((e) => e.entity_id).find((e) => e.startsWith("media_player."));
  await request("subscribe_events", { entity_ids: [mpId] });

  const browse = async (mediaId, limit = 8) => {
    const res = await request("browse_media", {
      entity_id: mpId,
      media_id: mediaId,
      paging: { page: 1, limit }
    });
    return (res.msg_data && res.msg_data.media) || {};
  };

  const show = (node, label) => {
    const items = node.items || [];
    console.log(`\n${label} (${items.length} affichés) :`);
    for (const entry of items) {
      console.log(`   ${entry.can_browse ? "📁" : "▶️ "} ${entry.title}${entry.subtitle ? `  — ${entry.subtitle}` : ""}`);
    }
    return items;
  };

  const root = show(await browse(""), "RACINE");
  check("racine à 5 entrées", root.length === 5, `${root.length}`);

  const favs = show(await browse("favorites", 5), "FAVORIS");
  check("favoris jouables", favs.length > 0 && favs.every((e) => e.can_play), `${favs.length}`);

  const cats = show(await browse("channels", 10), "CATÉGORIES DE CHAÎNES");
  check("catégories de chaînes", cats.length > 0, `${cats.length}`);

  if (cats.length) {
    const inside = show(await browse(cats[0].media_id, 6), `CHAÎNES DE « ${cats[0].title} »`);
    check("chaînes d'une catégorie", inside.length > 0, `${inside.length}`);
  }

  const movieCats = show(await browse("movies", 8), "CATÉGORIES DE FILMS");
  check("catégories de films", movieCats.length > 0, `${movieCats.length}`);

  if (movieCats.length) {
    const movies = show(await browse(movieCats[0].media_id, 6), `FILMS DE « ${movieCats[0].title} »`);
    check("films listés et jouables", movies.length > 0 && movies.every((e) => e.can_play), `${movies.length}`);
  }

  const seriesCats = show(await browse("series", 6), "CATÉGORIES DE SÉRIES");
  check("catégories de séries", seriesCats.length > 0, `${seriesCats.length}`);

  if (seriesCats.length) {
    const shows = show(await browse(seriesCats[0].media_id, 4), `SÉRIES DE « ${seriesCats[0].title} »`);
    if (shows.length) {
      const episodes = show(await browse(shows[0].media_id, 6), `ÉPISODES DE « ${shows[0].title} »`);
      check("épisodes chargés (loading + rappel)", episodes.length > 0, `${episodes.length}`);
    }
  }

  const resume = show(await browse("resume", 6), "REPRENDRE");
  check("reprendre alimenté", resume.length > 0, `${resume.length}`);

  ws.close();
  console.log(`\n${failures.length ? `ÉCHECS: ${failures.join(", ")}` : "NAVIGATION RÉELLE OK ✅"}`);
  process.exit(failures.length ? 1 : 0);
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
