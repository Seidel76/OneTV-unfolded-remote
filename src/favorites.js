"use strict";

/**
 * Chaînes favorites : nommage des commandes, résolution et cycle.
 *
 * Les favoris viennent de `/api/v1/favorites` (les `favoriteChannelStableKeys` de l'app,
 * intersectés avec les chaînes VISIBLES — pas `allChannels`). L'ORDRE rendu est celui de
 * la playlist : on ne le trie jamais, il porte l'intention de l'utilisateur.
 */

const { isChannelNameValid } = require("./naming");

const COMMAND_PREFIX = "FAV_";
// Plafond volontaire : au-delà, la liste de commandes d'une activité devient illisible.
// On ne tronque JAMAIS en silence (cf. règle projet) — `buildCommands` journalise.
const MAX_FAVORITE_COMMANDS = 60;

/**
 * Identifiant de commande stable et lisible : `FAV_CANAL_CINEMA_S`.
 * @param {string} name
 */
function commandId(name) {
  const ascii = String(name)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${COMMAND_PREFIX}${ascii || "CHAINE"}`;
}

/** Favoris utilisables : nommés, et non-séparateurs (règle 12). */
function usable(client) {
  return (client.favorites || []).filter(
    (channel) => channel && channel.name && isChannelNameValid(String(channel.name))
  );
}

/**
 * Favoris décorés de leur identifiant de commande, dédoublonné (deux favoris peuvent
 * porter le même nom dans deux playlists — le suffixe garde des identifiants distincts).
 *
 * SEULE source des identifiants : commandes, pages d'UI et résolution en dérivent toutes,
 * sinon un bouton d'UI pointerait vers un autre favori que celui affiché.
 * @returns {Array<{channel: object, name: string, command: string}>}
 */
function entries(client) {
  const seen = new Map();
  return usable(client).map((channel) => {
    const base = commandId(channel.name);
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return {
      channel,
      name: String(channel.name),
      command: count > 1 ? `${base}_${count}` : base
    };
  });
}

/**
 * Commandes simples `FAV_*` exposées à l'entité Remote.
 * @returns {{commands: string[], dropped: number}}
 */
function buildCommands(client) {
  const commands = entries(client).map((entry) => entry.command);
  const dropped = Math.max(0, commands.length - MAX_FAVORITE_COMMANDS);
  if (dropped > 0) {
    console.warn(
      `[onetv] ${commands.length} favoris → ${MAX_FAVORITE_COMMANDS} exposés en commandes, ${dropped} ignorés (tous restent accessibles par select_source)`
    );
  }
  return { commands: commands.slice(0, MAX_FAVORITE_COMMANDS), dropped };
}

/**
 * Retrouve la chaîne derrière une commande `FAV_*`.
 *
 * Résolu à CHAQUE appel sur les favoris courants : un favori renommé ou réordonné reste
 * joignable sans reconstruire l'entité.
 */
function resolveCommand(client, command) {
  const wanted = String(command).toUpperCase();
  const found = entries(client).find((entry) => entry.command === wanted);
  return found && found.channel;
}

/** Favori suivant / précédent à partir de la chaîne en cours (cycle). */
function step(client, direction) {
  const list = usable(client);
  if (list.length === 0) {
    return undefined;
  }
  const current = client.player.current_channel || {};
  const index = list.findIndex(
    (channel) =>
      (current.id && channel.id === current.id) ||
      (current.name && String(channel.name) === String(current.name))
  );
  if (index < 0) {
    return direction > 0 ? list[0] : list[list.length - 1];
  }
  return list[(index + direction + list.length) % list.length];
}

/** Noms des favoris, dans l'ordre de la playlist. */
const names = (client) => usable(client).map((channel) => String(channel.name));

module.exports = {
  COMMAND_PREFIX,
  buildCommands,
  commandId,
  entries,
  names,
  resolveCommand,
  step,
  usable
};
