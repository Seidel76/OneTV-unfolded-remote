"use strict";

/**
 * Faux serveur OneTV : reproduit les endpoints utilisés par le driver.
 * Sert à valider le driver sans Apple TV allumée. `node test/fakeOneTV.js 8765`
 */

const http = require("node:http");

const STATE = {
  isPlayerActive: true,
  isPlaying: true,
  isPaused: false,
  isBuffering: false,
  isLive: true,
  contentType: "channel",
  contentTitle: "M6",
  currentTime: 12,
  duration: 12,
  volume: 0.6,
  isMuted: false,
  logoURL: "https://example.invalid/m6.png",
  currentProgramme: { title: "Le 19.45", start: 0, end: 100 },
  audioTracks: [
    { name: "Français", isSelected: true },
    { name: "English", isSelected: false }
  ],
  subtitleTracks: [
    { name: "Off", isSelected: true },
    { name: "Français", isSelected: false }
  ]
};

const PLAYER = {
  is_active: true,
  current_channel: { id: "chan-1", name: "M6", logo_url: "https://example.invalid/m6.png" }
};

const CHANNELS = {
  channels: [
    { id: "chan-1", name: "M6", stream_url: "http://x/1", order: 1, category: "FRANCE FHD" },
    { id: "chan-2", name: "TF1", stream_url: "http://x/2", order: 2, category: "FRANCE FHD" },
    { id: "chan-3", name: "---●★| CINÉMA |★●---", stream_url: "http://x/3", order: 3, category: "FRANCE FHD" },
    { id: "chan-4", name: "CANAL+ CINEMA(S)", stream_url: "http://x/4", order: 4, category: "CINÉMA" },
    // Sans catégorie : le vrai flux en contient (category null) — elles doivent rester
    // atteignables, sinon une partie du bouquet est invisible dans le navigateur.
    { id: "chan-5", name: "ARTE", stream_url: "http://x/5", order: 5, category: null }
  ]
};

// Forme réelle de `/api/v1/favorites` : ni `stream_url`, mais un `stable_key` et l'EPG.
// L'ordre est celui de la playlist — surtout ne pas le trier.
const FAVORITES = {
  total: 3,
  channels: [
    { id: "chan-2", name: "TF1", category: "FRANCE FHD", stable_key: "url:http://x/2" },
    { id: "chan-1", name: "M6", category: "FRANCE FHD", stable_key: "url:http://x/1" },
    { id: "chan-4", name: "CANAL+ CINEMA(S)", category: "CINÉMA", stable_key: "url:http://x/4" }
  ]
};

const CATEGORIES = {
  total: 2,
  categories: [
    { name: "FRANCE FHD", channels_count: 3 },
    { name: "CINÉMA", channels_count: 1 }
  ]
};

const MOVIES = {
  totalCategories: 1,
  categories: [
    {
      categoryId: "21",
      categoryName: "|FR| NOUVEAUTÉS",
      moviesCount: 2,
      movies: [
        { id: "742976", name: "|FR| L'Invitation (2026)", posterURL: "http://x/p1.png" },
        { id: "742975", name: "|FR| Des Minions (2026)", posterURL: "http://x/p2.png" }
      ]
    }
  ]
};

const SERIES = {
  categories: [
    {
      categoryId: "1351",
      categoryName: "|FR| NOUVEAUTÉS",
      seriesCount: 1,
      series: [{ id: "2456", name: "|FR| Ted Lasso (2020)", posterURL: "http://x/s1.png" }]
    }
  ]
};

const CONTINUE = {
  total: 1,
  items: [
    {
      id: "742966",
      title: "Jackass: Best and Last",
      contentType: "movie",
      posterURL: "http://x/cw.png",
      currentTime: 380.7,
      duration: 5717.8,
      progressPercent: 6
    }
  ]
};

// Forme réelle de `/api/v1/now` : le programme en cours de TOUTES les chaînes, en une
// seule réponse indexable par `channel_id`.
const NOW = {
  now_playing: [
    {
      channel_id: "chan-2",
      channel_name: "TF1",
      program_title: "Le 20h",
      progress_percent: 44.46,
      start: "2026-08-11T23:05:00Z",
      end: "2026-08-12T03:50:00Z"
    },
    {
      channel_id: "chan-1",
      channel_name: "M6",
      program_title: "Le 19.45",
      progress_percent: 9.97,
      start: "2026-08-11T23:05:00Z",
      end: "2026-08-12T03:50:00Z"
    }
  ]
};

// L'app répond `loading: true` au PREMIER appel puis remplit en tâche de fond : le
// driver doit ré-appeler, sinon la catégorie paraît vide (motif « loading + rappel »).
let episodesCalls = 0;

const INFO = {
  device_id: "FAKE-DEVICE-1",
  device_name: "Salon (fake)",
  api_key: "fake-key",
  channels_generation: 1
};

function json(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      console.log(`CMD ${body}`);
      json(res, { success: true, message: "ok" });
    });
    return;
  }

  switch (req.url) {
    case "/api/v1/info":
      return json(res, INFO);
    case "/api/v1/player/state":
      return json(res, STATE);
    case "/api/v1/player":
      return json(res, PLAYER);
    case "/api/v1/channels":
      return json(res, CHANNELS);
    case "/api/v1/favorites":
      return json(res, FAVORITES);
    case "/api/v1/categories":
      return json(res, CATEGORIES);
    case "/api/v1/movies":
      return json(res, MOVIES);
    case "/api/v1/series":
      return json(res, SERIES);
    case "/api/v1/movies/21":
      return json(res, {
        categoryId: "21",
        categoryName: "|FR| NOUVEAUTÉS",
        total: 2,
        offset: 0,
        loading: false,
        items: MOVIES.categories[0].movies
      });
    case "/api/v1/series/1351":
      return json(res, {
        categoryId: "1351",
        categoryName: "|FR| NOUVEAUTÉS",
        total: 1,
        offset: 0,
        loading: false,
        items: SERIES.categories[0].series
      });
    case "/api/v1/series/2456/episodes":
      episodesCalls += 1;
      if (episodesCalls === 1) {
        return json(res, { seriesId: 2456, loading: true, episodes: [] });
      }
      return json(res, {
        seriesId: 2456,
        name: "|FR| Ted Lasso (2020)",
        loading: false,
        // Forme réelle mesurée sur l'appareil : `title` / `season` / `episode`.
        episodes: [
          { id: 121367, title: "|FR| Ted Lasso S01E01 (MULTi)", season: 1, episode: 1 },
          { id: 121368, title: "|FR| Ted Lasso S01E02 (MULTi)", season: 1, episode: 2 }
        ]
      });
    case "/api/v1/continue-watching":
      return json(res, CONTINUE);
    case "/api/v1/now":
      return json(res, NOW);
    case "/api/v1/events/stream":
      // iOS répond 501 : on couvre ce chemin, le driver doit retomber sur le sondage.
      return json(res, { error: "not implemented" }, 501);
    default:
      return json(res, { error: "not found" }, 404);
  }
});

server.listen(Number(process.argv[2]) || 8765, "127.0.0.1", () => {
  console.log(`fake OneTV sur ${server.address().port}`);
});
