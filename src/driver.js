#!/usr/bin/env node
"use strict";

/** Driver d'intégration OneTV pour Unfolded Circle Remote Two / Three. */

const fs = require("node:fs");
const path = require("node:path");

const { DeviceStates, Events, IntegrationAPI, StatusCodes } = require("@unfoldedcircle/integration-api");

const { OneTVClient } = require("./client");
const { Devices } = require("./config");
const mediaPlayer = require("./mediaPlayer");
const remote = require("./remote");
const { setupHandler } = require("./setupFlow");

const api = new IntegrationAPI();
const devices = new Devices();
/** @type {Map<string, OneTVClient>} */
const clients = new Map();

// ------------------------------------------------------------------ entités

/** Publie l'état courant vers la Remote (appelé par le client à chaque changement). */
function pushAttributes(client) {
  api.updateEntityAttributes(mediaPlayer.entityId(client), mediaPlayer.attributes(client));
  api.updateEntityAttributes(remote.entityId(client), remote.attributes(client));
}

function clientFor(entityId) {
  const identifier = entityId.slice(entityId.indexOf(".") + 1);
  return clients.get(identifier);
}

async function addDevice(config, seedFavorites) {
  const existing = clients.get(config.identifier);
  if (existing) {
    await existing.disconnect();
  }

  const client = new OneTVClient({
    host: config.host,
    port: config.port,
    apiKey: config.apiKey,
    deviceId: config.deviceId,
    name: config.name,
    favoritesOnly: config.favoritesOnly !== false,
    language: config.language || "en"
  });

  // ⚠️ Les commandes `FAV_*` et les pages « Favoris » sont figées à la CRÉATION de
  // l'entité Remote : sans cette lecture préalable, elles resteraient vides jusqu'au
  // prochain démarrage. L'échec n'est pas bloquant (app éteinte au boot de la Remote).
  if (Array.isArray(seedFavorites)) {
    client.favorites = seedFavorites;
  } else {
    await client.fetchFavorites();
  }

  client.onUpdate(() => pushAttributes(client));
  clients.set(config.identifier, client);

  // ⚠️ NE PAS retirer les entités CONFIGURÉES pour les republier : la Remote garde son
  // abonnement, et l'entité retirée répond 404 à toute commande. Les entités déjà
  // publiées restent donc en place ; ce sont leurs données qui doivent suivre, d'où la
  // résolution du client à chaque appel (`clientFor`) plutôt qu'une capture.
  api.addAvailableEntity(
    mediaPlayer.build(
      client,
      async (entity, cmdId, params) => {
        const target = clientFor(entity.id);
        return target ? mediaPlayer.handleCommand(target, cmdId, params) : StatusCodes.ServiceUnavailable;
      },
      clientFor
    )
  );
  api.addAvailableEntity(
    remote.build(client, async (entity, cmdId, params) => {
      const target = clientFor(entity.id);
      return target ? remote.handleCommand(target, cmdId, params) : StatusCodes.ServiceUnavailable;
    })
  );
}

// ------------------------------------------------------------- cycle de vie

api.on(Events.Connect, async () => {
  for (const client of clients.values()) {
    await client.connect();
  }
  await api.setDeviceState(DeviceStates.Connected);
});

api.on(Events.Disconnect, async () => {
  for (const client of clients.values()) {
    await client.disconnect();
  }
  await api.setDeviceState(DeviceStates.Disconnected);
});

api.on(Events.EnterStandby, async () => {
  // La Remote dort : rien à sonder, on lâche les sockets.
  for (const client of clients.values()) {
    await client.disconnect();
  }
});

api.on(Events.ExitStandby, async () => {
  for (const client of clients.values()) {
    await client.connect();
  }
});

api.on(Events.SubscribeEntities, async (entityIds) => {
  for (const entityId of entityIds || []) {
    const client = clientFor(entityId);
    if (!client) {
      continue;
    }
    await client.connect();
    pushAttributes(client);
  }
});

api.on(Events.UnsubscribeEntities, async (entityIds) => {
  // media_player et remote partagent le même appareil : on ne coupe que si AUCUNE des
  // deux entités n'est plus abonnée, sinon on tuerait le sondage de l'autre.
  const ids = entityIds || [];
  const configured = api.getConfiguredEntities();
  for (const entityId of ids) {
    const client = clientFor(entityId);
    if (!client) {
      continue;
    }
    const siblings = [mediaPlayer.entityId(client), remote.entityId(client)];
    const stillUsed = siblings.some(
      (sibling) => !ids.includes(sibling) && Boolean(configured.getEntity(sibling))
    );
    if (!stillUsed) {
      await client.disconnect();
    }
  }
});

/**
 * Localise driver.json — les chemins diffèrent entre dev et archive installée.
 * Sur la Remote, le binaire vit dans ./bin et driver.json à la RACINE de l'archive :
 * c'est donc le dossier PARENT qu'il faut regarder aussi.
 */
function driverJsonPath() {
  const candidates = [
    process.env.UC_DRIVER_JSON,
    path.join(__dirname, "driver.json"),
    path.join(__dirname, "..", "driver.json"),
    path.join(process.cwd(), "driver.json"),
    path.join(process.cwd(), "..", "driver.json")
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`driver.json introuvable (essayés: ${candidates.join(", ")})`);
}

async function main() {
  for (const config of devices.all) {
    await addDevice(config);
  }
  api.init(driverJsonPath(), (msg) => setupHandler(msg, devices, addDevice));
}

main().catch((err) => {
  console.error("[onetv] démarrage impossible:", err);
  process.exit(1);
});
