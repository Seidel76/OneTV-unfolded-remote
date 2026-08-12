"use strict";

/** Entité media_player OneTV. */

const {
  MediaPlayer,
  MediaPlayerAttributes: Attributes,
  MediaPlayerCommands: Commands,
  MediaPlayerDeviceClasses: DeviceClasses,
  MediaPlayerFeatures: Features,
  MediaPlayerStates: States,
  StatusCodes
} = require("@unfoldedcircle/integration-api");

const { OneTVConnectionError, OneTVError } = require("./client");
const { CMD, SEEK_STEP_SECONDS, VOLUME_STEP } = require("./const");
const browseMedia = require("./browse");
const favorites = require("./favorites");
const { isChannelNameValid } = require("./naming");

const FEATURES = [
  Features.OnOff,
  Features.PlayPause,
  Features.Stop,
  Features.Next,
  Features.Previous,
  Features.FastForward,
  Features.Rewind,
  Features.Seek,
  Features.Volume,
  Features.VolumeUpDown,
  Features.MuteToggle,
  Features.MediaDuration,
  Features.MediaPosition,
  Features.MediaTitle,
  Features.MediaArtist,
  Features.MediaAlbum,
  Features.MediaImageUrl,
  Features.MediaType,
  Features.SelectSource,
  Features.ChannelSwitcher,
  Features.AudioTrack,
  Features.Subtitle,
  Features.Info,
  Features.BrowseMedia,
  Features.PlayMedia
].filter(Boolean);

const entityId = (client) => `media_player.${client.uniqueId}`;

// -------------------------------------------------------- état → attributs

/**
 * Type de contenu, avec rattrapage du « none » menteur de l'app.
 *
 * ⚠️ Mesuré côté Home Assistant : en pleine lecture d'un épisode l'app peut renvoyer
 * `contentType: "none"` alors que titre/position/durée sont remplis (une fermeture de
 * lecteur arrive après l'ouverture de la nouvelle instance). Discriminant fiable :
 * `player.current_channel` est nul en VOD, rempli en direct.
 */
function contentType(state, player) {
  const raw = state.contentType;
  if (typeof raw === "string" && raw && raw !== "none") {
    return raw;
  }
  if (!state.isPlayerActive) {
    return "none";
  }
  if (player && player.current_channel) {
    return "channel";
  }
  if (typeof state.duration === "number" && state.duration > 0 && state.contentTitle) {
    return "movie";
  }
  return "none";
}

function playerState(client) {
  if (!client.reachable) {
    return States.Off;
  }
  const state = client.state;
  const active = state.isPlayerActive !== undefined ? state.isPlayerActive : client.player.is_active;
  if (!active) {
    return States.On;
  }
  if (state.isPaused) {
    return States.Paused;
  }
  if (state.isBuffering) {
    return States.Buffering;
  }
  // ⚠️ L'app laisse tous ses drapeaux à false entre deux transitions : lecteur actif et
  // non mis en pause = en lecture. Renvoyer ON afficherait une tuile vide.
  return States.Playing;
}

function channelName(client) {
  const current = client.player.current_channel;
  if (current && current.name) {
    return String(current.name);
  }
  if (client.state.contentType === "channel") {
    return client.state.contentTitle;
  }
  return undefined;
}

/** Ce qu'on regarde. En direct, c'est le PROGRAMME, pas la chaîne. */
function title(client) {
  const state = client.state;
  const kind = contentType(state, client.player);
  if (kind === "channel" || kind === "catchup") {
    const programme = state.currentProgramme || {};
    if (programme.title) {
      return String(programme.title);
    }
    const current = client.player.current_channel && client.player.current_channel.current_program;
    if (current && typeof current === "object" && current.title) {
      return String(current.title);
    }
    if (typeof current === "string" && current) {
      return current;
    }
    return channelName(client);
  }
  return state.contentTitle;
}

/**
 * Sources = FAVORIS D'ABORD, dans l'ordre de la playlist, puis le reste par ordre
 * alphabétique.
 *
 * L'ordre des favoris porte l'intention de l'utilisateur : on ne le trie jamais. Et sur
 * l'écran de la Remote, 843 entrées alphabétiques sont inutilisables — les favoris en
 * tête sont ce qui rend `select_source` praticable.
 *
 * Les playlists M3U portent aussi des lignes décoratives (« ---●★| MANGA |★●--- ») qui
 * ne sont pas des chaînes : elles sont filtrées (règle 12 du projet).
 */
function sourceList(client) {
  const favoriteNames = favorites.names(client);
  const ordered = [];
  const seen = new Set();

  for (const name of favoriteNames) {
    if (!seen.has(name)) {
      seen.add(name);
      ordered.push(name);
    }
  }

  if (client.favoritesOnly && ordered.length > 0) {
    return ordered;
  }

  const rest = [];
  for (const channel of client.channels) {
    if (!channel || !channel.name) {
      continue;
    }
    const name = String(channel.name);
    if (seen.has(name) || !isChannelNameValid(name)) {
      continue;
    }
    seen.add(name);
    rest.push(name);
  }
  rest.sort((a, b) => a.localeCompare(b));

  return ordered.concat(rest);
}

function attributes(client) {
  const state = client.state;
  const kind = contentType(state, client.player);
  const isLive = Boolean(state.isLive) || kind === "channel" || kind === "catchup";

  const attrs = {
    [Attributes.State]: playerState(client),
    [Attributes.SourceList]: sourceList(client)
  };

  const currentTitle = title(client);
  if (currentTitle) {
    attrs[Attributes.MediaTitle] = currentTitle;
  }

  const channel = channelName(client);
  if (channel) {
    attrs[Attributes.Source] = channel;
    attrs[Attributes.MediaArtist] = channel;
  }

  if (kind === "episode") {
    attrs[Attributes.MediaAlbum] = state.contentTitle || "";
  }

  // ⚠️ En direct, `duration` = profondeur du tampon timeshift (~12 s mesurées), pas une
  // durée de contenu : l'exposer afficherait une barre de progression absurde.
  if (!isLive && typeof state.duration === "number" && state.duration > 0) {
    attrs[Attributes.MediaDuration] = Math.round(state.duration);
    if (typeof state.currentTime === "number") {
      attrs[Attributes.MediaPosition] = Math.round(state.currentTime);
    }
  }

  let artwork;
  if (kind === "movie" || kind === "episode") {
    // Visuel PAYSAGE d'abord : l'emplacement de la Remote est horizontal, une affiche
    // verticale y perd ses bords.
    artwork = state.backdropURL || state.posterURL;
  }
  artwork =
    artwork ||
    state.logoURL ||
    (client.player.current_channel && client.player.current_channel.logo_url);
  if (artwork) {
    attrs[Attributes.MediaImageUrl] = String(artwork);
  }

  const mediaType = { channel: "TVSHOW", catchup: "TVSHOW", movie: "MOVIE", episode: "TVSHOW" }[kind];
  if (mediaType) {
    attrs[Attributes.MediaType] = mediaType;
  }

  if (typeof state.volume === "number") {
    attrs[Attributes.Volume] = Math.round(Math.min(1, Math.max(0, state.volume)) * 100);
  }
  if (state.isMuted !== undefined && state.isMuted !== null) {
    attrs[Attributes.Muted] = Boolean(state.isMuted);
  }

  return attrs;
}

// ----------------------------------------------------------------- commandes

/**
 * Complète un favori avec l'entrée complète de la playlist.
 *
 * ⚠️ Le payload `/api/v1/favorites` ne porte PAS `stream_url` : sans ce raccord, le repli
 * par URL de `playChannel` (qui sauve les bascules de playlist) disparaît dès qu'une
 * chaîne est en favori.
 */
function enrich(client, channel) {
  if (!channel || channel.stream_url) {
    return channel;
  }
  const full = client.channels.find(
    (candidate) =>
      candidate.id === channel.id ||
      (channel.stable_key && candidate.stable_key === channel.stable_key) ||
      String(candidate.name) === String(channel.name)
  );
  return full ? { ...channel, ...full } : channel;
}

function resolveChannel(client, wanted) {
  const lowered = String(wanted).toLocaleLowerCase();
  let fallback;
  // Les favoris d'abord : ce sont eux qui sont en tête de `source_list`, et l'app peut
  // les servir alors qu'ils manquent du reste (payload favoris ≠ payload chaînes).
  for (const channel of [...(client.favorites || []), ...client.channels]) {
    if (channel.id === wanted) {
      return enrich(client, channel);
    }
    const name = String(channel.name || "");
    if (name === wanted) {
      return enrich(client, channel);
    }
    if (!fallback && name.toLocaleLowerCase() === lowered) {
      fallback = channel;
    }
  }
  return fallback ? enrich(client, fallback) : undefined;
}

/** Piste suivante, en boucle. L'entité n'a pas de sélecteur : on cycle. */
function nextTrackIndex(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    return undefined;
  }
  const current = tracks.findIndex((track) => track.isSelected);
  return (current + 1) % tracks.length;
}

async function handleCommand(client, cmdId, params = {}) {
  try {
    switch (cmdId) {
      case Commands.PlayPause:
        await client.sendCommand(CMD.TOGGLE);
        break;
      case Commands.Stop:
      case Commands.Off:
        // L'app n'a pas d'extinction : arrêter la lecture est le plus proche.
        await client.sendCommand(CMD.STOP);
        break;
      case Commands.On:
        // Lancer/réveiller l'app n'est pas dans son API : ça passe par l'Apple TV.
        return StatusCodes.NotImplemented;
      case Commands.Next:
      case Commands.ChannelUp:
        await client.sendCommand(CMD.NEXT_CHANNEL);
        break;
      case Commands.Previous:
      case Commands.ChannelDown:
        await client.sendCommand(CMD.PREV_CHANNEL);
        break;
      case Commands.FastForward:
        await client.sendCommand(CMD.SEEK_RELATIVE, { seconds: SEEK_STEP_SECONDS });
        break;
      case Commands.Rewind:
        await client.sendCommand(CMD.SEEK_RELATIVE, { seconds: -SEEK_STEP_SECONDS });
        break;
      case Commands.Seek: {
        const position = params.media_position;
        if (position === undefined || position === null) {
          return StatusCodes.BadRequest;
        }
        await client.sendCommand(CMD.SEEK_ABSOLUTE, { position: Number(position) });
        break;
      }
      case Commands.Live:
        await client.sendCommand(CMD.SEEK_TO_LIVE);
        break;
      case Commands.Volume: {
        const level = params.volume;
        if (level === undefined || level === null) {
          return StatusCodes.BadRequest;
        }
        await client.sendCommand(CMD.SET_VOLUME, {
          level: Math.min(1, Math.max(0, Number(level) / 100))
        });
        break;
      }
      case Commands.VolumeUp:
        await client.sendCommand(CMD.ADJUST_VOLUME, { delta: VOLUME_STEP });
        break;
      case Commands.VolumeDown:
        await client.sendCommand(CMD.ADJUST_VOLUME, { delta: -VOLUME_STEP });
        break;
      case Commands.MuteToggle:
        await client.sendCommand(CMD.TOGGLE_MUTE);
        break;
      case Commands.Mute:
      case Commands.Unmute: {
        // ⚠️ L'app n'expose qu'une BASCULE : ne l'envoyer que sur une vraie différence,
        // sinon elle repart dans l'autre sens.
        const wanted = cmdId === Commands.Mute;
        if (Boolean(client.state.isMuted) !== wanted) {
          await client.sendCommand(CMD.TOGGLE_MUTE);
        }
        break;
      }
      case Commands.SelectSource: {
        if (!params.source) {
          return StatusCodes.BadRequest;
        }
        const channel = resolveChannel(client, params.source);
        if (!channel) {
          return StatusCodes.NotFound;
        }
        const payload = { channelId: String(channel.id) };
        // L'app sait retomber sur l'URL quand l'id ne matche plus (bascule de playlist).
        if (channel.stream_url) {
          payload.url = String(channel.stream_url);
          payload.name = String(channel.name || "");
        }
        await client.sendCommand(CMD.PLAY_CHANNEL, payload);
        break;
      }
      case Commands.PlayMedia: {
        // Élément choisi dans le navigateur : chaîne, film ou épisode.
        const status = await browseMedia.play(client, params.media_id, params.media_position);
        if (status !== StatusCodes.Ok) {
          return status;
        }
        break;
      }
      case Commands.AudioTrack: {
        const index = nextTrackIndex(client.state.audioTracks);
        if (index === undefined) {
          return StatusCodes.NotFound;
        }
        await client.sendCommand(CMD.SET_AUDIO_TRACK, { trackIndex: index });
        break;
      }
      case Commands.Subtitle: {
        const index = nextTrackIndex(client.state.subtitleTracks);
        if (index === undefined) {
          return StatusCodes.NotFound;
        }
        await client.sendCommand(CMD.SET_SUBTITLE_TRACK, { trackIndex: index });
        break;
      }
      default:
        return StatusCodes.NotImplemented;
    }
  } catch (err) {
    if (err instanceof OneTVConnectionError) {
      console.warn(`[onetv] injoignable pour ${cmdId}: ${err.message}`);
      return StatusCodes.ServiceUnavailable;
    }
    if (err instanceof OneTVError) {
      console.warn(`[onetv] commande ${cmdId} refusée: ${err.message}`);
      return StatusCodes.ServerError;
    }
    throw err;
  }

  await client.refresh();
  return StatusCodes.Ok;
}

function build(client, cmdHandler) {
  const entity = new MediaPlayer(entityId(client), client.name, {
    features: FEATURES,
    attributes: attributes(client),
    deviceClass: DeviceClasses.StreamingBox,
    cmdHandler
  });
  // `browse` est une MÉTHODE à surcharger (pas une option du constructeur) : la lib
  // appelle `entity.browse(options)` à chaque écran du navigateur.
  entity.browse = (options) => browseMedia.browse(client, options);
  return entity;
}

module.exports = { attributes, build, enrich, entityId, handleCommand };
