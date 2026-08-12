"use strict";

/**
 * Persistance des appareils OneTV configurés.
 *
 * Le firmware fournit `UC_CONFIG_HOME` : c'est le SEUL répertoire inscriptible d'un
 * driver installé sur la Remote (le dossier du binaire est en lecture seule).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FILENAME = "onetv_config.json";

class Devices {
  constructor() {
    const home = process.env.UC_CONFIG_HOME || process.env.HOME || os.tmpdir();
    this.path = path.join(home, FILENAME);
    this.devices = new Map();
    this.load();
  }

  get all() {
    return Array.from(this.devices.values());
  }

  get(identifier) {
    return this.devices.get(identifier);
  }

  add(device) {
    this.devices.set(device.identifier, device);
    this.store();
  }

  clear() {
    this.devices.clear();
    this.store();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.path, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.warn(`[onetv] config illisible (${err.message}), on repart à vide`);
      }
      return;
    }
    try {
      for (const device of JSON.parse(raw)) {
        if (device && device.identifier && device.host) {
          this.devices.set(device.identifier, device);
        }
      }
    } catch (err) {
      console.warn(`[onetv] config corrompue (${err.message}), on repart à vide`);
    }
  }

  store() {
    try {
      fs.writeFileSync(this.path, JSON.stringify(this.all), "utf8");
    } catch (err) {
      console.error(`[onetv] écriture de la config impossible: ${err.message}`);
    }
  }
}

module.exports = { Devices };
