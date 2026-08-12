"use strict";

/**
 * Navigateur de médias : Favoris / Chaînes par catégorie / Films / Séries / Reprendre.
 *
 * Même découpage que l'app Apple Watch. La Remote pagine ses requêtes (`Paging`), donc
 * on ne renvoie JAMAIS 843 chaînes ni 61 catégories de films d'un bloc.
 *
 * Identifiants (`media_id`) — un schéma plat, lisible dans les logs :
 *   favorites | channels | channels:<catégorie> | movies | movies:<catId>
 *   series | series:<catId> | serie:<seriesId> | resume
 *   channel:<id> | movie:<id> | episode:<seriesId>:<saison>:<épisode>
 */

const {
  BrowseMediaItem,
  BrowseResult,
  KnownMediaClass: MediaClass,
  KnownMediaContentType: MediaType,
  Pagination,
  StatusCodes
} = require("@unfoldedcircle/integration-api");

const { CMD } = require("./const");
const favorites = require("./favorites");
const { strings } = require("./i18n");
const { isChannelNameValid } = require("./naming");

// Le catalogue VOD complet pèse ~0,5 Mo : il n'est lu qu'à la demande, et gardé un
// moment. Une navigation ne doit pas faire retravailler la TV à chaque écran.
const CATALOG_TTL_MS = 10 * 60 * 1000;
// L'EPG « en cours » change à la minute : on le garde peu de temps.
const NOW_TTL_MS = 60 * 1000;
// « loading + rappel » : l'app répond `loading: true` puis remplit en tâche de fond.
const LOADING_RETRIES = 6;
const LOADING_DELAY_MS = 700;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sentinelle du panier « sans catégorie » — jamais un nom de catégorie réel.
const UNCATEGORIZED = "\u0000none";
const UNCATEGORIZED_ID = `channels:${UNCATEGORIZED}`;

/** Cache par client, hors du client lui-même (il n'a pas à connaître le navigateur). */
const caches = new WeakMap();

function cacheFor(client) {
  let cache = caches.get(client);
  if (!cache) {
    cache = new Map();
    caches.set(client, cache);
  }
  return cache;
}

async function cached(client, key, loader, ttlMs = CATALOG_TTL_MS) {
  const cache = cacheFor(client);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) {
    return hit.value;
  }
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Programme en cours de TOUTES les chaînes, indexé par identifiant.
 *
 * ⚠️ `/api/v1/channels` ne porte PAS d'EPG (seul `/api/v1/favorites` en a). La bonne
 * source est `/api/v1/now` : UNE requête pour tout le bouquet (~120 Ko), au lieu d'un
 * appel par chaîne affichée. Jamais dans le cycle de sondage — seulement à la navigation.
 */
async function nowIndex(client) {
  try {
    return await cached(
      client,
      "now",
      async () => {
        const payload = await client.get("/api/v1/now", 15000);
        const index = new Map();
        for (const entry of (payload && payload.now_playing) || []) {
          if (entry && entry.channel_id) {
            index.set(String(entry.channel_id), entry);
          }
        }
        return index;
      },
      NOW_TTL_MS
    );
  } catch (err) {
    // Sans EPG on affiche quand même les chaînes : c'est un bonus, pas une dépendance.
    console.info(`[onetv] EPG indisponible: ${err.message}`);
    return new Map();
  }
}

/**
 * Suit le motif « loading + rappel » de l'app : le premier appel déclenche le chargement
 * et répond `loading: true` avec une liste vide. Sans ce ré-appel, une catégorie jamais
 * ouverte sur la TV paraîtrait VIDE.
 */
async function loadUntilReady(client, path, isEmpty) {
  let payload = await client.get(path);
  for (let attempt = 0; attempt < LOADING_RETRIES; attempt += 1) {
    if (!payload || payload.loading !== true) {
      break;
    }
    if (!isEmpty(payload)) {
      break;
    }
    await sleep(LOADING_DELAY_MS);
    payload = await client.get(path);
  }
  return payload || {};
}

// ------------------------------------------------------------------ helpers

const item = (mediaId, title, options) => new BrowseMediaItem(mediaId, title, options);

const folder = (mediaId, title, options = {}) =>
  item(mediaId, title, {
    media_class: MediaClass.Directory,
    media_type: MediaType.Channels,
    can_browse: true,
    can_play: false,
    ...options
  });

/** Découpe selon la pagination demandée et rend la `Pagination` correspondante. */
function page(items, paging) {
  const offset = (paging && paging.page ? paging.page - 1 : 0) * (paging && paging.limit ? paging.limit : items.length);
  const limit = paging && paging.limit ? paging.limit : items.length;
  const slice = items.slice(offset, offset + limit);
  return {
    slice,
    pagination: new Pagination(paging && paging.page ? paging.page : 1, limit, items.length)
  };
}

function result(container, items, paging) {
  const { slice, pagination } = page(items, paging);
  container.items = slice;
  return new BrowseResult(container, pagination);
}

/** Titres provider : « |FR| Ted Lasso (2020) » → « Ted Lasso (2020) ». */
function cleanTitle(name) {
  return String(name || "")
    .replace(/^\s*(\|[A-Z0-9]{2,6}\|\s*)+/i, "")
    .trim();
}

// -------------------------------------------------------------------- écrans

function rootScreen(client, paging) {
  const t = strings(client);
  const entries = [
    folder("favorites", t.favorites, { thumbnail: "icon://uc:star" }),
    folder("channels", t.channels, { thumbnail: "icon://uc:tv" }),
    folder("movies", t.movies, { media_type: MediaType.Movie, thumbnail: "icon://uc:movie" }),
    folder("series", t.series, { media_type: MediaType.TvShow, thumbnail: "icon://uc:tv" }),
    folder("resume", t.resume, { thumbnail: "icon://uc:play" })
  ];
  return result(folder("root", t.root), entries, paging);
}

/**
 * @param channel chaîne à afficher
 * @param context catégorie déjà affichée à l'écran, le cas échéant : on ne la répète pas
 *                en sous-titre (`/api/v1/channels` ne porte pas d'EPG, contrairement à
 *                `/api/v1/favorites`).
 */
function channelItem(channel, context, now) {
  const live = now && now.get(String(channel.id));
  const title = (live && live.program_title) || (channel.current_program && channel.current_program.title);
  const percent = live && typeof live.progress_percent === "number" ? Math.round(live.progress_percent) : undefined;
  const category = channel.category && channel.category !== context ? channel.category : undefined;

  let subtitle = category;
  if (title) {
    subtitle = percent ? `${title} · ${percent} %` : title;
  }

  return item(`channel:${channel.id}`, String(channel.name), {
    media_class: MediaClass.Channel,
    media_type: MediaType.Channel,
    can_play: true,
    can_browse: false,
    subtitle,
    thumbnail: channel.logo_url || undefined
  });
}

/**
 * ⚠️ La navigation peut démarrer AVANT le premier cycle de sondage (la Remote s'abonne
 * et ouvre le navigateur dans la foulée) : sans ce chargement à la demande, une
 * catégorie de chaînes s'affichait VIDE alors que tout allait bien.
 */
async function ensureChannels(client) {
  if (!client.channels.length) {
    await client.fetchChannels(true);
  }
  return client.channels;
}

async function favoritesScreen(client, paging) {
  const now = await nowIndex(client);
  const items = favorites.usable(client).map((channel) => channelItem(channel, undefined, now));
  return result(folder("favorites", strings(client).favorites), items, paging);
}

async function channelCategoriesScreen(client, paging) {
  await ensureChannels(client);
  const categories = await cached(client, "categories", async () => {
    const payload = await client.get("/api/v1/categories");
    return (payload && payload.categories) || [];
  });

  const t = strings(client);
  const items = categories.map((category) =>
    folder(`channels:${category.name}`, String(category.name), {
      subtitle: category.channels_count ? t.channelCount(category.channels_count) : undefined
    })
  );

  // ⚠️ Le flux contient des chaînes SANS catégorie (`category: null`) : sans ce panier
  // elles n'existeraient nulle part dans le navigateur.
  const orphans = client.channels.filter(
    (channel) => !channel.category && channel.name && isChannelNameValid(String(channel.name))
  );
  if (orphans.length) {
    items.push(
      folder(UNCATEGORIZED_ID, t.uncategorized, { subtitle: t.channelCount(orphans.length) })
    );
  }

  return result(folder("channels", t.channels), items, paging);
}

async function channelsOfCategoryScreen(client, category, paging) {
  await ensureChannels(client);
  const now = await nowIndex(client);
  const uncategorized = category === UNCATEGORIZED;
  const items = client.channels
    .filter((channel) => {
      if (!channel.name || !isChannelNameValid(String(channel.name))) {
        return false;
      }
      return uncategorized ? !channel.category : String(channel.category || "") === category;
    })
    .map((channel) => channelItem(channel, category, now));
  const title = uncategorized ? strings(client).uncategorized : category;
  return result(folder(`channels:${category}`, title), items, paging);
}

async function vodCategoriesScreen(client, kind, paging) {
  const payload = await cached(client, kind, async () => client.get(`/api/v1/${kind}`, 25000));
  const categories = (payload && payload.categories) || [];
  const countKey = kind === "movies" ? "moviesCount" : "seriesCount";

  const items = categories.map((category) =>
    folder(`${kind}:${category.categoryId}`, cleanTitle(category.categoryName), {
      media_type: kind === "movies" ? MediaType.Movie : MediaType.TvShow,
      subtitle: category[countKey] ? `${category[countKey]}` : undefined
    })
  );
  const t = strings(client);
  return result(folder(kind, kind === "movies" ? t.movies : t.series), items, paging);
}

async function vodCategoryScreen(client, kind, categoryId, paging) {
  const payload = await cached(client, `${kind}:${categoryId}`, () =>
    loadUntilReady(
      client,
      `/api/v1/${kind}/${encodeURIComponent(categoryId)}`,
      (data) => !(data.items || []).length
    )
  );

  const entries = (payload.items || []).map((entry) =>
    kind === "movies"
      ? item(`movie:${entry.id}`, cleanTitle(entry.name), {
          media_class: MediaClass.Movie,
          media_type: MediaType.Movie,
          can_play: true,
          thumbnail: entry.posterURL || undefined
        })
      : folder(`serie:${entry.id}`, cleanTitle(entry.name), {
          media_class: MediaClass.TvShow,
          media_type: MediaType.TvShow,
          thumbnail: entry.posterURL || undefined
        })
  );

  const t = strings(client);
  const title = cleanTitle(payload.categoryName) || (kind === "movies" ? t.movies : t.series);
  return result(folder(`${kind}:${categoryId}`, title), entries, paging);
}

async function episodesScreen(client, seriesId, paging) {
  const payload = await cached(client, `episodes:${seriesId}`, () =>
    loadUntilReady(
      client,
      `/api/v1/series/${encodeURIComponent(seriesId)}/episodes`,
      (data) => !(data.episodes || []).length
    )
  );

  const items = (payload.episodes || []).map((episode) => {
    // ⚠️ L'app renvoie `title` / `season` / `episode` (PAS `name`/`seasonNumber`/
    // `episodeNumber`) : sans ces clés, tous les épisodes s'affichaient « S1E1 ».
    const season = episode.season ?? episode.seasonNumber ?? 1;
    const number = episode.episode ?? episode.episodeNumber ?? 0;
    const label = cleanTitle(episode.title || episode.name) || `S${season}E${number}`;
    return item(`episode:${seriesId}:${season}:${number}`, label, {
      media_class: MediaClass.Episode,
      media_type: MediaType.Episode,
      can_play: true,
      subtitle: `S${String(season).padStart(2, "0")}E${String(number).padStart(2, "0")}`,
      thumbnail: episode.posterURL || episode.imageURL || undefined
    });
  });

  return result(
    folder(`serie:${seriesId}`, cleanTitle(payload.name) || strings(client).episodes),
    items,
    paging
  );
}

async function resumeScreen(client, paging) {
  const payload = await client.get("/api/v1/continue-watching", 12000);
  const items = ((payload && payload.items) || []).map((entry) => {
    const isEpisode = entry.contentType === "episode";
    const mediaId = isEpisode
      ? `episode:${entry.seriesId ?? entry.id}:${entry.seasonNumber ?? 1}:${entry.episodeNumber ?? 1}`
      : `movie:${entry.id}`;
    const percent = Math.round(entry.progressPercent || 0);
    return item(mediaId, cleanTitle(entry.title), {
      media_class: isEpisode ? MediaClass.Episode : MediaClass.Movie,
      media_type: isEpisode ? MediaType.Episode : MediaType.Movie,
      can_play: true,
      subtitle: percent ? `${percent} %` : undefined,
      thumbnail: entry.posterURL || undefined,
      duration: entry.duration ? Math.round(entry.duration) : undefined
    });
  });
  return result(folder("resume", strings(client).resume), items, paging);
}

// ------------------------------------------------------------------ routage

async function browse(client, options = {}) {
  const mediaId = options.media_id || "root";
  const paging = options.paging;

  try {
    if (mediaId === "root") {
      return rootScreen(client, paging);
    }
    if (mediaId === "favorites") {
      return favoritesScreen(client, paging);
    }
    if (mediaId === "channels") {
      return channelCategoriesScreen(client, paging);
    }
    if (mediaId.startsWith("channels:")) {
      return channelsOfCategoryScreen(client, mediaId.slice("channels:".length), paging);
    }
    if (mediaId === "movies" || mediaId === "series") {
      return vodCategoriesScreen(client, mediaId, paging);
    }
    if (mediaId.startsWith("movies:") || mediaId.startsWith("series:")) {
      const [kind, categoryId] = [mediaId.slice(0, mediaId.indexOf(":")), mediaId.slice(mediaId.indexOf(":") + 1)];
      return vodCategoryScreen(client, kind, categoryId, paging);
    }
    if (mediaId.startsWith("serie:")) {
      return episodesScreen(client, mediaId.slice("serie:".length), paging);
    }
    if (mediaId === "resume") {
      return resumeScreen(client, paging);
    }
  } catch (err) {
    console.warn(`[onetv] navigation '${mediaId}' impossible: ${err.message}`);
    return StatusCodes.ServiceUnavailable;
  }

  console.warn(`[onetv] media_id inconnu: ${mediaId}`);
  return StatusCodes.NotFound;
}

/**
 * Lecture d'un élément choisi dans le navigateur.
 * @returns {Promise<StatusCodes>}
 */
async function play(client, mediaId, resumePosition) {
  if (!mediaId) {
    return StatusCodes.BadRequest;
  }

  if (mediaId.startsWith("channel:")) {
    const id = mediaId.slice("channel:".length);
    const channel =
      client.channels.find((candidate) => String(candidate.id) === id) ||
      (client.favorites || []).find((candidate) => String(candidate.id) === id);
    if (!channel) {
      return StatusCodes.NotFound;
    }
    const params = { channelId: id };
    if (channel.stream_url) {
      params.url = String(channel.stream_url);
      params.name = String(channel.name || "");
    }
    await client.sendCommand(CMD.PLAY_CHANNEL, params);
    return StatusCodes.Ok;
  }

  if (mediaId.startsWith("movie:")) {
    const params = { movieId: mediaId.slice("movie:".length) };
    if (resumePosition) {
      params.resumePosition = Number(resumePosition);
    }
    await client.sendCommand("playMovie", params);
    return StatusCodes.Ok;
  }

  if (mediaId.startsWith("episode:")) {
    const [, seriesId, season, episode] = mediaId.split(":");
    if (!seriesId || season === undefined || episode === undefined) {
      return StatusCodes.BadRequest;
    }
    const params = {
      seriesId,
      seasonNumber: Number(season),
      episodeNumber: Number(episode)
    };
    if (resumePosition) {
      params.resumePosition = Number(resumePosition);
    }
    await client.sendCommand("playEpisode", params);
    return StatusCodes.Ok;
  }

  return StatusCodes.NotImplemented;
}

module.exports = { browse, cleanTitle, play };
