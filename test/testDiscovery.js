"use strict";

/** Vérifie la découverte mDNS en publiant un faux service `_noopytv._tcp`. */

const { Bonjour } = require("bonjour-service");

const { discover } = require("../src/discovery");
const { ZEROCONF_TYPE } = require("../src/const");

async function run() {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: "Salon Test",
    type: ZEROCONF_TYPE,
    protocol: "tcp",
    port: 8765,
    txt: { deviceId: "FAKE-DEVICE-1", apiKey: "fake-key", model: "Apple TV", sse: "true" }
  });

  let found = [];
  try {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    found = await discover(5000);
  } finally {
    service.stop(() => {});
    bonjour.destroy();
  }

  const ours = found.find((device) => device.deviceId === "FAKE-DEVICE-1");
  if (!ours) {
    console.log(`❌ service non découvert (trouvés: ${found.map((d) => d.label).join(", ") || "aucun"})`);
    process.exit(1);
  }

  const ok = ours.port === 8765 && ours.apiKey === "fake-key" && Boolean(ours.host);
  console.log(`${ok ? "✅" : "❌"} découvert: ${ours.label} apiKey=${ours.apiKey}`);
  process.exit(ok ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
