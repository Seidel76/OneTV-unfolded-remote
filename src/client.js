"use strict";

/**
 * Client HTTP + SSE de l'API télécommande de OneTV Connect.
 *
 * Mêmes endpoints (et mêmes pièges) que l'intégration Home Assistant `noopy_tv`,
 * réduits à ce dont un driver Unfolded Circle a besoin. Zéro dépendance : `fetch` et
 * `AbortController` sont natifs depuis Node 18.
 */

const { randomUUID } = require("node:crypto");
const { DEFAULT_PORT, POLL_INTERVAL_POLL_MS, POLL_INTERVAL_PUSH_MS } = require("./const");

class OneTVError extends Error {}
class OneTVConnectionError extends OneTVError {}

class OneTVClient {
  /**
   * @param {{host: string, port?: number, apiKey?: string|null, deviceId?: string|null, name?: string}} options
   */
  constructor({
    host,
    port = DEFAULT_PORT,
    apiKey = null,
    deviceId = null,
    name = "OneTV",
    favoritesOnly = false,
    language = "en"
  }) {
    this.host = host;
    this.port = port;
    this.apiKey = apiKey;
    this.deviceId = deviceId;
    this.name = name;
    // Limite la liste des sources aux favoris : 843 chaînes sont injouables au doigt
    // sur l'écran de la Remote.
    this.favoritesOnly = favoritesOnly;
    // Langue des libellés d'écran (navigateur, pages d'UI) — choisie au setup.
    this.language = language;

    this.base = `http://${host}:${port}`;

    // État consolidé, servi aux entités.
    this.info = {};
    this.state = {};
    this.player = {};
    this.channels = [];
    this.favorites = [];

    this.reachable = false;
    this.pushConnected = false;

    this._listeners = [];
    this._pollTimer = null;
    this._sseAbort = null;
    this._sseRunning = false;
    this._stopped = true;
    this._channelsGeneration = undefined;
  }

  /** Identité stable. Le deviceId l'emporte : l'IP change, pas lui. */
  get uniqueId() {
    return this.deviceId ? `onetv-${this.deviceId}` : `onetv-${this.host}-${this.port}`;
  }

  onUpdate(listener) {
    this._listeners.push(listener);
  }

  _notify() {
    for (const listener of this._listeners) {
      try {
        listener(this);
      } catch (err) {
        console.error("[onetv] listener en erreur:", err);
      }
    }
  }

  _headers() {
    return this.apiKey ? { "X-API-Key": this.apiKey } : {};
  }

  async _get(path, timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.base}${path}`, {
        headers: this._headers(),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new OneTVError(`HTTP ${response.status} sur ${path}`);
      }
      return await response.json();
    } catch (err) {
      if (err instanceof OneTVError) {
        throw err;
      }
      throw new OneTVConnectionError(`${path}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET public — utilisé par le navigateur de médias, qui a ses propres chemins. */
  get(path, timeoutMs = 8000) {
    return this._get(path, timeoutMs);
  }

  // ------------------------------------------------------------- endpoints

  /** `/api/v1/info` — public (pas d'auth) et sert aussi la clé d'API annoncée. */
  async fetchInfo() {
    const data = await this._get("/api/v1/info");
    if (data && typeof data === "object") {
      this.info = data;
      if (!this.apiKey && typeof data.api_key === "string" && data.api_key) {
        this.apiKey = data.api_key;
      }
      this.deviceId = data.device_id || data.deviceId || this.deviceId;
      this.name = data.device_name || data.name || this.name;
    }
    return this.info;
  }

  async fetchState() {
    const data = await this._get("/api/v1/player/state");
    this.state = data && typeof data === "object" ? data : {};
    return this.state;
  }

  async fetchPlayer() {
    const data = await this._get("/api/v1/player");
    this.player = data && typeof data === "object" ? data : {};
    return this.player;
  }

  /**
   * Liste des chaînes, rafraîchie seulement quand l'app dit qu'elle a changé.
   * `/api/v1/info` porte `channels_generation` (O(1) côté app) : recharger 150k chaînes
   * à chaque cycle ferait travailler la TV pour rien.
   */
  async fetchChannels(force = false) {
    const generation = this.info.channels_generation;
    if (!force && this.channels.length && generation === this._channelsGeneration) {
      return this.channels;
    }

    const data = await this._get("/api/v1/channels", 20000);
    const channels = Array.isArray(data) ? data : data && data.channels;
    if (Array.isArray(channels)) {
      this.channels = channels;
      this._channelsGeneration = generation;
    }
    return this.channels;
  }

  /**
   * `/api/v1/favorites` — les chaînes mises en favori dans l'app.
   *
   * L'endpoint n'existe que sur les versions récentes : sur une plus ancienne on garde
   * une liste vide plutôt que de faire échouer tout le cycle de rafraîchissement.
   */
  async fetchFavorites() {
    try {
      const data = await this._get("/api/v1/favorites", 10000);
      const channels = Array.isArray(data) ? data : data && data.channels;
      this.favorites = Array.isArray(channels) ? channels : [];
    } catch (err) {
      if (this.favorites.length) {
        console.info(`[onetv] favoris indisponibles: ${err.message}`);
      }
      this.favorites = [];
    }
    return this.favorites;
  }

  /**
   * `POST /api/v1/player/command`.
   *
   * ⚠️ `requestId` n'est PAS optionnel côté Swift (`RemoteCommand`) : sans lui l'app
   * répond 400 « Invalid command JSON ».
   */
  async sendCommand(command, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const payload = { command, requestId: randomUUID().replace(/-/g, "") };
    if (params) {
      payload.params = params;
    }

    let result;
    try {
      const response = await fetch(`${this.base}/api/v1/player/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this._headers() },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (response.status === 404) {
        throw new OneTVError("Commandes non supportées par cette version de OneTV");
      }
      if (!response.ok) {
        throw new OneTVError(`HTTP ${response.status} sur ${command}`);
      }
      result = await response.json();
    } catch (err) {
      if (err instanceof OneTVError) {
        throw err;
      }
      throw new OneTVConnectionError(`${command}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (!result || result.success !== true) {
      throw new OneTVError((result && (result.error || result.message)) || `${command} refusée`);
    }
    return result;
  }

  playChannel(channelId, extra) {
    return this.sendCommand("playChannel", { channelId, ...(extra || {}) });
  }

  // ---------------------------------------------------------------- boucles

  async connect() {
    this._stopped = false;
    await this.refresh();
    this._schedulePoll();
    if (!this._sseRunning) {
      this._sseLoop().catch((err) => console.error("[onetv] boucle SSE:", err));
    }
  }

  async disconnect() {
    this._stopped = true;
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._sseAbort) {
      this._sseAbort.abort();
      this._sseAbort = null;
    }
    this.pushConnected = false;
  }

  async refresh() {
    try {
      await this.fetchInfo();
      await this.fetchState();
      await this.fetchPlayer();
      await this.fetchChannels();
      await this.fetchFavorites();
      this.reachable = true;
    } catch (err) {
      if (this.reachable) {
        console.info(`[onetv] ${this.host} injoignable: ${err.message}`);
      }
      this.reachable = false;
    }
    this._notify();
  }

  _schedulePoll() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
    }
    if (this._stopped) {
      return;
    }
    const delay = this.pushConnected ? POLL_INTERVAL_PUSH_MS : POLL_INTERVAL_POLL_MS;
    this._pollTimer = setTimeout(async () => {
      await this.refresh();
      this._schedulePoll();
    }, delay);
    if (this._pollTimer.unref) {
      this._pollTimer.unref();
    }
  }

  /**
   * Flux `/api/v1/events/stream` — servi par l'app Apple TV. Un appareil qui répond 501
   * n'a pas de push : on abandonne le flux et le sondage prend le relais.
   *
   * ⚠️ Ne JAMAIS déduire « connecté » d'un event `snapshot` : le serveur étiquette son
   * état initial selon la situation. La connexion HTTP elle-même est le seul signal.
   */
  async _sseLoop() {
    this._sseRunning = true;
    let backoff = 2000;

    try {
      while (!this._stopped) {
        this._sseAbort = new AbortController();
        try {
          const response = await fetch(`${this.base}/api/v1/events/stream`, {
            headers: { Accept: "text/event-stream", ...this._headers() },
            signal: this._sseAbort.signal
          });

          if (response.status === 501) {
            console.info(`[onetv] ${this.host}: pas de flux d'événements, sondage seul`);
            this.pushConnected = false;
            return;
          }
          if (!response.ok || !response.body) {
            throw new Error(`SSE HTTP ${response.status}`);
          }

          this.pushConnected = true;
          backoff = 2000;
          this._schedulePoll();
          console.info(`[onetv] ${this.host}: flux SSE connecté`);

          let buffer = "";
          for await (const chunk of response.body) {
            buffer += Buffer.from(chunk).toString("utf8");
            let index;
            while ((index = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, index).trim();
              buffer = buffer.slice(index + 1);
              if (!line.startsWith("data:")) {
                continue;
              }
              const body = line.slice(5).trim();
              if (!body) {
                continue;
              }
              try {
                await this._handleEvent(JSON.parse(body));
              } catch {
                // Ligne partielle ou event non JSON : sans importance.
              }
            }
          }
        } catch (err) {
          if (this._stopped) {
            return;
          }
          console.debug(`[onetv] SSE ${this.host} interrompu: ${err.message}`);
        }

        this.pushConnected = false;
        this._notify();
        this._schedulePoll();
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, 60000);
      }
    } finally {
      this._sseRunning = false;
    }
  }

  async _handleEvent(event) {
    const payload = event && typeof event.data === "object" && event.data ? event.data : event;
    const state = payload.playback_state || payload.playbackState;
    if (state && typeof state === "object") {
      this.state = state;
      this.reachable = true;
      this._notify();
      return;
    }
    // Event sans état complet (zap, changement de contenu) : on resynchronise.
    await this.refresh();
  }
}

module.exports = { OneTVClient, OneTVError, OneTVConnectionError };
