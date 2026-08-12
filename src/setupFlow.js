"use strict";

/** Flux de configuration du driver OneTV. */

const {
  DriverSetupRequest,
  IntegrationSetupError,
  RequestUserInput,
  SetupComplete,
  SetupError,
  UserDataResponse
} = require("@unfoldedcircle/integration-api");

const { OneTVClient } = require("./client");
const { DEFAULT_PORT } = require("./const");
const { discover } = require("./discovery");

const pending = new Map();
// Choisi au premier écran, appliqué quel que soit le chemin ensuite (découverte,
// sélection dans la liste, saisie manuelle de repli).
let favoritesOnly = false;
let language = "en";

/**
 * @param {object} msg message de setup
 * @param {import("./config").Devices} devices
 * @param {(device: object) => Promise<void>} onDeviceAdded
 */
async function setupHandler(msg, devices, onDeviceAdded) {
  if (msg instanceof DriverSetupRequest) {
    return start(msg, devices, onDeviceAdded);
  }
  if (msg instanceof UserDataResponse) {
    return userData(msg, devices, onDeviceAdded);
  }
  pending.clear();
  return new SetupError();
}

async function start(msg, devices, onDeviceAdded) {
  const data = msg.setupData || {};
  const host = String(data.host || "").trim();
  const port = Number(data.port) || DEFAULT_PORT;
  const apiKey = String(data.api_key || "").trim() || null;
  // Les champs de setup reviennent en CHAÎNES, y compris les cases à cocher.
  // Par DÉFAUT on ne met que les favoris dans `source_list` : le reste du catalogue se
  // parcourt par catégories dans le navigateur de médias, pas dans une liste à plat.
  const allChannels =
    data.all_channels_as_sources === true || String(data.all_channels_as_sources) === "true";
  favoritesOnly = !allChannels;
  language = String(data.language || "en").toLowerCase() === "fr" ? "fr" : "en";

  if (host) {
    return finish({ host, port, apiKey, deviceId: null }, devices, onDeviceAdded);
  }

  const found = await discover();
  if (found.length === 0) {
    // Plutôt qu'un échec sec : la découverte peut échouer pour de bonnes raisons (app
    // en veille, mDNS filtré par le réseau) alors que l'adresse, elle, est connue.
    console.warn("[onetv] aucune app trouvée en mDNS — saisie manuelle proposée");
    return new RequestUserInput(
      { en: "OneTV not found", fr: "OneTV introuvable" },
      [
        {
          id: "info",
          label: { en: "Not found", fr: "Introuvable" },
          field: {
            label: {
              value: {
                en: "No OneTV app answered on the network. Make sure it is running, then enter its address manually.",
                fr: "Aucune app OneTV n'a répondu sur le réseau. Vérifiez qu'elle tourne, puis saisissez son adresse."
              }
            }
          }
        },
        {
          id: "manual_host",
          label: { en: "IP address", fr: "Adresse IP" },
          field: { text: { value: "" } }
        },
        {
          id: "manual_port",
          label: { en: "Port", fr: "Port" },
          field: { number: { value: DEFAULT_PORT, min: 1, max: 65535, steps: 1 } }
        }
      ]
    );
  }

  if (found.length === 1) {
    const device = found[0];
    return finish(
      { host: device.host, port: device.port, apiKey: apiKey || device.apiKey, deviceId: device.deviceId },
      devices,
      onDeviceAdded
    );
  }

  pending.clear();
  const items = found.map((device) => {
    const key = device.deviceId || `${device.host}:${device.port}`;
    pending.set(key, device);
    return { id: key, label: { en: device.label, fr: device.label } };
  });

  return new RequestUserInput(
    { en: "Select your OneTV device", fr: "Choisissez votre appareil OneTV" },
    [
      {
        id: "device",
        label: { en: "Device", fr: "Appareil" },
        field: { dropdown: { value: items[0].id, items } }
      }
    ]
  );
}

async function userData(msg, devices, onDeviceAdded) {
  const values = msg.inputValues || {};

  // Repli manuel après une découverte infructueuse.
  const manualHost = String(values.manual_host || "").trim();
  if (manualHost) {
    return finish(
      { host: manualHost, port: Number(values.manual_port) || DEFAULT_PORT, apiKey: null, deviceId: null },
      devices,
      onDeviceAdded
    );
  }

  const device = pending.get(values.device);
  if (!device) {
    return new SetupError();
  }
  return finish(
    { host: device.host, port: device.port, apiKey: device.apiKey, deviceId: device.deviceId },
    devices,
    onDeviceAdded
  );
}

async function finish({ host, port, apiKey, deviceId }, devices, onDeviceAdded) {
  const client = new OneTVClient({ host, port, apiKey, deviceId, favoritesOnly, language });
  try {
    // `/api/v1/info` est public : il valide l'adresse ET publie la clé d'API.
    await client.fetchInfo();
    // Les favoris sont lus DÈS le setup : les commandes `FAV_*` et les pages d'UI de
    // l'entité Remote sont construites à sa création, pas au premier sondage.
    await client.fetchFavorites();
  } catch (err) {
    console.error(`[onetv] injoignable sur ${host}:${port} — ${err.message}`);
    return new SetupError(IntegrationSetupError.ConnectionRefused);
  }

  const config = {
    identifier: client.uniqueId,
    name: client.name,
    host,
    port,
    apiKey: client.apiKey,
    deviceId: client.deviceId,
    favoritesOnly,
    language
  };
  devices.add(config);
  await onDeviceAdded(config, client.favorites);

  pending.clear();
  return new SetupComplete();
}

module.exports = { setupHandler };
