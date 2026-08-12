"use strict";

/**
 * Validation contre un VRAI OneTV, en LECTURE SEULE par défaut.
 *
 * Le driver doit déjà tourner (il est lancé à part, éventuellement via le relais
 * Terminal quand le LAN est bloqué pour ce process) et écouter sur `--ws`.
 *
 *   node test/testRealDevice.js --ws 19091
 *
 * Aucune commande n'est envoyée à l'appareil : on s'abonne et on lit l'état publié.
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
  const events = [];
  const pending = new Map();

  ws.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.req_id !== undefined && pending.has(data.req_id)) {
      pending.get(data.req_id)(data);
      pending.delete(data.req_id);
      return;
    }
    events.push(data);
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("driver injoignable en loopback")));
    setTimeout(() => reject(new Error("timeout connexion WS")), 10000);
  });

  const request = (id, msg, msgData = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${msg}`)), 25000);
      pending.set(id, (data) => {
        clearTimeout(timer);
        resolve(data);
      });
      ws.send(JSON.stringify({ kind: "req", id, msg, msg_data: msgData }));
    });

  const res = await request(1, "get_available_entities", {});
  const entities = res.msg_data.available_entities || [];
  const ids = entities.map((entity) => entity.entity_id);
  check("entités publiées depuis la config persistée", ids.length === 2, ids.join(", "));

  const mpId = ids.find((id) => id.startsWith("media_player."));
  const rmId = ids.find((id) => id.startsWith("remote."));
  if (!mpId) {
    console.log("Aucune entité media_player — le driver a-t-il chargé la config ?");
    process.exit(1);
  }

  const remoteEntity = entities.find((entity) => entity.entity_id === rmId);
  const options = remoteEntity.options || {};
  const favCommands = (options.simple_commands || []).filter((name) => name.startsWith("FAV_"));
  const allPages = (options.user_interface || {}).pages || [];
  // Ne garder que les pages de favoris : la page principale porte des icônes sans texte
  // et fausserait la comparaison d'ordre.
  const favPages = allPages.filter((page) => String(page.page_id).startsWith("onetv_fav_"));
  console.log(`\nFavoris exposés en commandes (${favCommands.length}) :`);
  console.log("  " + favCommands.join(" · "));
  console.log(`Pages d'UI : ${allPages.map((page) => `${page.name} (${page.items.length})`).join(", ")}`);
  check("commandes favorites générées", favCommands.length > 0, `${favCommands.length}`);
  check("pages Favoris générées", favPages.length >= 1, `${favPages.length} page(s) de favoris`);

  await request(2, "subscribe_events", { entity_ids: [mpId, rmId] });

  const change = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("aucun entity_change reçu")), 25000);
    const poll = setInterval(() => {
      const found = events.find(
        (data) => data.msg === "entity_change" && data.msg_data.entity_id === mpId
      );
      if (found) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve(found);
      }
    }, 250);
  });

  const attrs = change.msg_data.attributes || {};
  const sources = attrs.source_list || [];
  console.log("\n=== état lu sur l'appareil réel ===");
  console.log(JSON.stringify({ ...attrs, source_list: `${sources.length} chaînes` }, null, 2));
  console.log(`\n10 premières sources : ${sources.slice(0, 10).join(" · ")}`);

  const favNames = favPages.flatMap((page) => page.items.map((item) => item.text));
  check(
    "favoris en tête de source_list, ordre préservé",
    favNames.length > 0 && JSON.stringify(sources.slice(0, favNames.length)) === JSON.stringify(favNames),
    `attendu ${favNames.slice(0, 3).join(",")} — vu ${sources.slice(0, 3).join(",")}`
  );

  check("l'app répond (état ≠ OFF)", attrs.state && attrs.state !== "OFF", String(attrs.state));
  check("liste des chaînes non vide", (attrs.source_list || []).length > 0, `${(attrs.source_list || []).length}`);
  const junk = (attrs.source_list || []).filter((name) => /^[▼▲●★☆■□=~+\-|]/.test(name));
  check("aucun séparateur dans la liste (règle 12)", junk.length === 0, junk.slice(0, 3).join(" / "));

  ws.close();
  console.log(`\n${failures.length ? `ÉCHECS: ${failures.join(", ")}` : "LECTURE SEULE OK ✅"}`);
  process.exit(failures.length ? 1 : 0);
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
