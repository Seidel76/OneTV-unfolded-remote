"use strict";

/**
 * User-facing strings.
 *
 * Browse titles and UI page labels are plain strings in the Integration API (unlike
 * entity names, which accept an `{en, fr}` map), so the language is picked once during
 * setup and stored with the device. English is the default for a public integration.
 */

const STRINGS = {
  en: {
    remoteName: (device) => `${device} remote`,
    root: "OneTV",
    favorites: "Favorites",
    channels: "Channels by category",
    uncategorized: "Uncategorized",
    movies: "Movies",
    series: "TV shows",
    episodes: "Episodes",
    resume: "Continue watching",
    channelCount: (count) => `${count} channels`,
    pageFavorites: "Favorites",
    pageFavoritesNumbered: (index, total) => `Favorites ${index}/${total}`,
    live: "Live",
    audio: "Audio",
    subtitles: "Subtitles"
  },
  fr: {
    remoteName: (device) => `${device} télécommande`,
    root: "OneTV",
    favorites: "Favoris",
    channels: "Chaînes par catégorie",
    uncategorized: "Sans catégorie",
    movies: "Films",
    series: "Séries",
    episodes: "Épisodes",
    resume: "Reprendre",
    channelCount: (count) => `${count} chaînes`,
    pageFavorites: "Favoris",
    pageFavoritesNumbered: (index, total) => `Favoris ${index}/${total}`,
    live: "Direct",
    audio: "Audio",
    subtitles: "Sous-titres"
  }
};

const DEFAULT_LANGUAGE = "en";

/** @returns {typeof STRINGS.en} strings for the device's configured language */
function strings(client) {
  const language = (client && client.language) || DEFAULT_LANGUAGE;
  return STRINGS[language] || STRINGS[DEFAULT_LANGUAGE];
}

const languages = () => Object.keys(STRINGS);

module.exports = { DEFAULT_LANGUAGE, languages, strings };
