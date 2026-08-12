"use strict";

/**
 * Filtrage des entrées « séparateur » des playlists IPTV.
 *
 * Port de `tvOSBuzzTVChannelList.isChannelNameValid` (règle 12 du projet OneTV) : les
 * playlists M3U contiennent des lignes décoratives qui ne sont pas des chaînes —
 * `▼●★ --- |FR| M6 PLAY |FR| --- ★●▼`, `---●★| MANGA |★●---`, `====`… Elles n'ont rien
 * à faire dans une `source_list`.
 *
 * Critère de l'app : premier caractère non-blanc appartenant à un jeu de symboles
 * décoratifs (ponctuation incluse, apostrophe exclue), ou nom de 3 caractères ou moins
 * sans la moindre lettre.
 */

const JUNK_PREFIX_CHARS = new Set(
  Array.from("▼▲●★☆■□▸▹►◄◆◇○◎※†‡§¶•–—―~=+#@!|/_\\<>{}[]()«»‹›❤❥✦✧✩✪✫✬✭✮✯✰✱✲✳✴✵✶✷✸✹✺-")
);

// Équivalent de `CharacterSet.punctuationCharacters` : \p{P} en Unicode.
const PUNCTUATION = /\p{P}/u;
const LETTER = /\p{L}/u;
const WHITESPACE = /\s/u;

/**
 * @param {string | null | undefined} name
 * @returns {boolean} false pour les entrées séparateur d'une playlist
 */
function isChannelNameValid(name) {
  if (!name) {
    return false;
  }

  const first = Array.from(name).find((char) => !WHITESPACE.test(char));
  if (first === undefined) {
    return false;
  }

  if (JUNK_PREFIX_CHARS.has(first)) {
    return false;
  }
  // L'apostrophe est tolérée (« L'Équipe »), le reste de la ponctuation non.
  if (first !== "'" && PUNCTUATION.test(first)) {
    return false;
  }

  if (Array.from(name).length <= 3) {
    return LETTER.test(name);
  }

  return true;
}

module.exports = { isChannelNameValid };
