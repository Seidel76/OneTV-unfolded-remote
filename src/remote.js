"use strict";

/** Entité remote OneTV — commandes simples + mapping des touches physiques. */

const {
  Buttons,
  EntityCommand,
  Remote,
  RemoteAttributes: Attributes,
  RemoteCommands: Commands,
  RemoteFeatures: Features,
  RemoteStates: States,
  Size,
  StatusCodes,
  UiPage,
  createBtnMapping,
  createUiIcon,
  createUiText
} = require("@unfoldedcircle/integration-api");

const { OneTVConnectionError, OneTVError } = require("./client");
const { CMD, SEEK_STEP_SECONDS, SIMPLE_COMMANDS, VOLUME_STEP } = require("./const");
const favorites = require("./favorites");
const mediaPlayer = require("./mediaPlayer");

const entityId = (client) => `remote.${client.uniqueId}`;

const attributes = (client) => ({
  [Attributes.State]: client.reachable ? States.On : States.Off
});

const cmd = (command) => new EntityCommand(Commands.SendCmd, { command });

/** Touches physiques de la Remote → commandes OneTV. */
function buttonMapping() {
  return [
    createBtnMapping(Buttons.Play, cmd("PLAY_PAUSE")),
    createBtnMapping(Buttons.Prev, cmd("SEEK_BACKWARD_30"), cmd("CHANNEL_PREVIOUS")),
    createBtnMapping(Buttons.Next, cmd("SEEK_FORWARD_30"), cmd("CHANNEL_NEXT")),
    createBtnMapping(Buttons.ChannelUp, cmd("CHANNEL_NEXT")),
    createBtnMapping(Buttons.ChannelDown, cmd("CHANNEL_PREVIOUS")),
    createBtnMapping(Buttons.VolumeUp, cmd("VOLUME_UP")),
    createBtnMapping(Buttons.VolumeDown, cmd("VOLUME_DOWN")),
    createBtnMapping(Buttons.Mute, cmd("MUTE_TOGGLE")),
    createBtnMapping(Buttons.DpadRight, cmd("FAVORITE_NEXT")),
    createBtnMapping(Buttons.DpadLeft, cmd("FAVORITE_PREVIOUS")),
    createBtnMapping(Buttons.DpadMiddle, cmd("PLAY_PAUSE"), cmd("STOP"))
  ];
}

/**
 * Pages « Favoris » : une grille de noms tapables directement sur l'écran de la Remote.
 *
 * 4 colonnes × 6 lignes, la dernière ligne réservée à la pagination visuelle → 20 favoris
 * par page. Construites au démarrage du driver : ajouter un favori dans l'app demande de
 * relancer l'intégration pour le voir apparaître ICI (il est utilisable tout de suite via
 * les sources et `FAVORITE_NEXT`).
 */
function favoritePages(client) {
  const entries = favorites.entries(client);
  const perPage = 20;
  const total = Math.ceil(entries.length / perPage);
  const pages = [];

  for (let start = 0; start < entries.length; start += perPage) {
    const index = pages.length + 1;
    const page = new UiPage(
      `onetv_fav_${index}`,
      total > 1 ? `Favoris ${index}/${total}` : "Favoris",
      new Size(4, 6)
    );
    entries.slice(start, start + perPage).forEach((entry, position) => {
      page.add(
        createUiText(
          entry.name,
          (position % 2) * 2,
          Math.floor(position / 2),
          cmd(entry.command),
          new Size(2, 1)
        )
      );
    });
    pages.push(page);
  }

  return pages;
}

function uiPages(client) {
  const page = new UiPage("onetv_main", "OneTV", new Size(4, 6));
  page.add(createUiIcon("uc:up-arrow-bold", 1, 0, cmd("CHANNEL_NEXT"), new Size(2, 1)));
  page.add(createUiIcon("uc:down-arrow-bold", 1, 2, cmd("CHANNEL_PREVIOUS"), new Size(2, 1)));
  page.add(createUiIcon("uc:play", 0, 1, cmd("PLAY_PAUSE")));
  page.add(createUiIcon("uc:stop", 3, 1, cmd("STOP")));
  page.add(createUiText("⟲ 30", 0, 3, cmd("SEEK_BACKWARD_30"), new Size(2, 1)));
  page.add(createUiText("30 ⟳", 2, 3, cmd("SEEK_FORWARD_30"), new Size(2, 1)));
  page.add(createUiText("Direct", 0, 4, cmd("BACK_TO_LIVE"), new Size(4, 1)));
  page.add(createUiText("Audio", 0, 5, cmd("AUDIO_TRACK_NEXT"), new Size(2, 1)));
  page.add(createUiText("Sous-titres", 2, 5, cmd("SUBTITLE_TRACK_NEXT"), new Size(2, 1)));
  return [page, ...favoritePages(client)];
}

function build(client, cmdHandler) {
  const { commands } = favorites.buildCommands(client);
  return new Remote(entityId(client), `${client.name} télécommande`, {
    features: [Features.OnOff, Features.SendCmd],
    attributes: attributes(client),
    simpleCommands: [...SIMPLE_COMMANDS, ...commands],
    buttonMapping: buttonMapping(),
    uiPages: uiPages(client),
    cmdHandler
  });
}

const SIMPLE_MAP = {
  CHANNEL_NEXT: [CMD.NEXT_CHANNEL],
  CHANNEL_PREVIOUS: [CMD.PREV_CHANNEL],
  BACK_TO_LIVE: [CMD.SEEK_TO_LIVE],
  PLAY: [CMD.PLAY],
  PAUSE: [CMD.PAUSE],
  PLAY_PAUSE: [CMD.TOGGLE],
  STOP: [CMD.STOP],
  SEEK_FORWARD_30: [CMD.SEEK_RELATIVE, { seconds: SEEK_STEP_SECONDS }],
  SEEK_BACKWARD_30: [CMD.SEEK_RELATIVE, { seconds: -SEEK_STEP_SECONDS }],
  MUTE_TOGGLE: [CMD.TOGGLE_MUTE],
  VOLUME_UP: [CMD.ADJUST_VOLUME, { delta: VOLUME_STEP }],
  VOLUME_DOWN: [CMD.ADJUST_VOLUME, { delta: -VOLUME_STEP }]
};

/** Lance une chaîne favorite (l'app retombe sur l'URL si l'id a bougé). */
async function playFavorite(client, channel) {
  const full = mediaPlayer.enrich(client, channel);
  const payload = { channelId: String(full.id) };
  if (full.stream_url) {
    payload.url = String(full.stream_url);
    payload.name = String(full.name || "");
  }
  await client.sendCommand(CMD.PLAY_CHANNEL, payload);
  return StatusCodes.Ok;
}

async function sendSimple(client, command) {
  if (command === "FAVORITE_NEXT" || command === "FAVORITE_PREVIOUS") {
    const channel = favorites.step(client, command === "FAVORITE_NEXT" ? 1 : -1);
    if (!channel) {
      return StatusCodes.NotFound;
    }
    return playFavorite(client, channel);
  }

  if (String(command).startsWith(favorites.COMMAND_PREFIX)) {
    // Résolu sur les favoris COURANTS : un favori renommé reste joignable sans
    // reconstruire l'entité.
    const channel = favorites.resolveCommand(client, command);
    if (!channel) {
      return StatusCodes.NotFound;
    }
    return playFavorite(client, channel);
  }

  if (command === "AUDIO_TRACK_NEXT" || command === "SUBTITLE_TRACK_NEXT" || command === "SUBTITLE_OFF") {
    const tracks =
      (command === "AUDIO_TRACK_NEXT" ? client.state.audioTracks : client.state.subtitleTracks) || [];
    let index;
    if (command === "SUBTITLE_OFF") {
      index = tracks.findIndex(
        (track) => !track.name || String(track.name).toLowerCase().includes("off")
      );
      if (index < 0) {
        return StatusCodes.NotFound;
      }
    } else {
      if (tracks.length === 0) {
        return StatusCodes.NotFound;
      }
      index = (tracks.findIndex((track) => track.isSelected) + 1) % tracks.length;
    }
    const swift = command === "AUDIO_TRACK_NEXT" ? CMD.SET_AUDIO_TRACK : CMD.SET_SUBTITLE_TRACK;
    await client.sendCommand(swift, { trackIndex: index });
    return StatusCodes.Ok;
  }

  const entry = SIMPLE_MAP[command];
  if (!entry) {
    return StatusCodes.NotImplemented;
  }
  await client.sendCommand(entry[0], entry[1]);
  return StatusCodes.Ok;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handleCommand(client, cmdId, params = {}) {
  try {
    if (cmdId === Commands.SendCmd) {
      if (!params.command) {
        return StatusCodes.BadRequest;
      }
      const repeat = Number(params.repeat) || 1;
      const delay = Number(params.delay) || 0;
      let status = StatusCodes.Ok;
      for (let index = 0; index < repeat; index += 1) {
        status = await sendSimple(client, String(params.command));
        if (status !== StatusCodes.Ok) {
          return status;
        }
        if (delay && index < repeat - 1) {
          await sleep(delay);
        }
      }
      return status;
    }

    if (cmdId === Commands.SendCmdSequence) {
      const sequence = params.sequence || [];
      const delay = Number(params.delay) || 0;
      for (const command of sequence) {
        const status = await sendSimple(client, String(command));
        if (status !== StatusCodes.Ok) {
          return status;
        }
        if (delay) {
          await sleep(delay);
        }
      }
      return StatusCodes.Ok;
    }

    if (cmdId === Commands.Off || cmdId === Commands.Toggle) {
      await client.sendCommand(CMD.STOP);
      return StatusCodes.Ok;
    }

    if (cmdId === Commands.On) {
      // Lancer l'app n'est pas dans son API : ça passe par l'Apple TV (cf. README).
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

  return StatusCodes.NotImplemented;
}

module.exports = { attributes, build, entityId, handleCommand };
