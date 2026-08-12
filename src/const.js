"use strict";

/** Constantes partagées du driver OneTV. */

const ZEROCONF_TYPE = "noopytv";
const DEFAULT_PORT = 8765;

// Sondage de repli. Quand le flux SSE de l'app pousse les changements, on espace ; un
// appareil sans flux (501) n'a que le sondage, on resserre.
const POLL_INTERVAL_PUSH_MS = 30000;
const POLL_INTERVAL_POLL_MS = 5000;

const SEEK_STEP_SECONDS = 30;
const VOLUME_STEP = 0.05;

// Commandes RÉELLEMENT implémentées par `AppModel.handleRemoteCommand` (Swift).
// Tout le reste est refusé par l'app avec `success: false` — ne rien inventer ici.
const CMD = {
  PLAY: "play",
  PAUSE: "pause",
  TOGGLE: "togglePlayPause",
  STOP: "stop",
  SET_VOLUME: "setVolume",
  ADJUST_VOLUME: "adjustVolume",
  TOGGLE_MUTE: "toggleMute",
  SEEK_RELATIVE: "seekRelative",
  SEEK_ABSOLUTE: "seekAbsolute",
  SEEK_TO_LIVE: "seekToLive",
  SET_AUDIO_TRACK: "setAudioTrack",
  SET_SUBTITLE_TRACK: "setSubtitleTrack",
  NEXT_CHANNEL: "nextChannel",
  PREV_CHANNEL: "previousChannel",
  PLAY_CHANNEL: "playChannel"
};

// Commandes simples exposées à l'entité Remote (macros d'activité).
const SIMPLE_COMMANDS = [
  "CHANNEL_NEXT",
  "CHANNEL_PREVIOUS",
  "BACK_TO_LIVE",
  "PLAY",
  "PAUSE",
  "PLAY_PAUSE",
  "STOP",
  "SEEK_FORWARD_30",
  "SEEK_BACKWARD_30",
  "AUDIO_TRACK_NEXT",
  "SUBTITLE_TRACK_NEXT",
  "SUBTITLE_OFF",
  "FAVORITE_NEXT",
  "FAVORITE_PREVIOUS",
  "MUTE_TOGGLE",
  "VOLUME_UP",
  "VOLUME_DOWN"
];

module.exports = {
  ZEROCONF_TYPE,
  DEFAULT_PORT,
  POLL_INTERVAL_PUSH_MS,
  POLL_INTERVAL_POLL_MS,
  SEEK_STEP_SECONDS,
  VOLUME_STEP,
  CMD,
  SIMPLE_COMMANDS
};
