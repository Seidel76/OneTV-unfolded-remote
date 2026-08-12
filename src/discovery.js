"use strict";

/**
 * Découverte mDNS des apps OneTV (`_noopytv._tcp`).
 *
 * L'app publie déjà ce service pour Home Assistant, avec les mêmes clés TXT
 * (`deviceId`, `apiKey`, `model`, `manufacturer`, `sse`).
 */

const { Bonjour } = require("bonjour-service");

const { DEFAULT_PORT, ZEROCONF_TYPE } = require("./const");

function txt(properties, ...keys) {
  if (!properties) {
    return undefined;
  }
  for (const key of keys) {
    const value = properties[key];
    if (value !== undefined && value !== null && value !== "") {
      return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
    }
  }
  return undefined;
}

function pickHost(service) {
  const addresses = service.addresses || [];
  // IPv4 d'abord : l'API OneTV écoute en clair et l'IPv6 lien-local traîne un scope.
  return addresses.find((address) => address.includes(".")) || addresses[0] || service.host;
}

/**
 * @param {number} timeoutMs durée du balayage
 * @returns {Promise<Array<{host: string, port: number, name: string, deviceId?: string, apiKey?: string, label: string}>>}
 */
function discover(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const found = new Map();

    // ⚠️ Sans callback d'erreur, `bonjour-service` fait un `throw` DEPUIS un timer :
    // un simple `EHOSTUNREACH 224.0.0.251` (multicast refusé sur l'interface) tue tout
    // le driver. Mesuré sur macOS. Ici on journalise et on rend ce qu'on a.
    const onError = (err) => console.warn(`[onetv] mDNS indisponible: ${err.message}`);

    let bonjour;
    let browser;
    try {
      bonjour = new Bonjour(undefined, onError);
      browser = bonjour.find({ type: ZEROCONF_TYPE, protocol: "tcp" });
      browser.on("error", onError);
    } catch (err) {
      onError(err);
      resolve([]);
      return;
    }

    browser.on("up", (service) => {
      const host = pickHost(service);
      if (!host) {
        return;
      }
      const device = {
        host,
        port: service.port || DEFAULT_PORT,
        name: txt(service.txt, "name", "deviceName") || service.name || "OneTV",
        deviceId: txt(service.txt, "deviceId", "device_id"),
        apiKey: txt(service.txt, "apiKey", "api_key")
      };
      device.label = `${device.name} (${device.host}:${device.port})`;
      found.set(device.deviceId || `${device.host}:${device.port}`, device);
      console.info(`[onetv] découvert: ${device.label}`);
    });

    setTimeout(() => {
      try {
        browser.stop();
        bonjour.destroy();
      } catch {
        // rien à faire : on rend ce qu'on a trouvé
      }
      resolve(Array.from(found.values()));
    }, timeoutMs);
  });
}

module.exports = { discover };
