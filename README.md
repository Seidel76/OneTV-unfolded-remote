# uc-intg-onetv — OneTV Connect pour Unfolded Circle Remote Two / Three

Driver d'intégration qui pilote l'app **OneTV Connect** (tvOS / iOS) depuis une Remote
Unfolded Circle, via la même API HTTP que l'intégration Home Assistant `noopy_tv`.

**Écrit en Node.js — aucune compilation, aucun Docker.** La Remote embarque un runtime
Node (v22.22 en firmware 2.9.2, v20.16 en 1.9.3) et UC recommande Node justement pour ça :
on copie les sources + `node_modules`, on tarball, c'est installable. Archive ≈ 260 Ko.

## Ce qu'il expose

**`media_player`** — état de lecture, titre du programme EPG (pas juste la chaîne),
jaquette, position/durée en VOD, volume, sourdine, zapping, transport, pistes audio et
sous-titres. `source_list` = **les favoris d'abord**, dans l'ordre de la playlist, puis
le reste par ordre alphabétique.

**`remote`** — commandes simples pour les macros d'activité, mapping des touches
physiques (PLAY, ⏭/⏮ = seek ±30 s / appui long = zap, CH+/CH−, VOL, MUTE) et une page
d'UI. Commandes disponibles :

```
CHANNEL_NEXT · CHANNEL_PREVIOUS · BACK_TO_LIVE · PLAY · PAUSE · PLAY_PAUSE · STOP
SEEK_FORWARD_30 · SEEK_BACKWARD_30 · AUDIO_TRACK_NEXT · SUBTITLE_TRACK_NEXT
SUBTITLE_OFF · FAVORITE_NEXT · FAVORITE_PREVIOUS · MUTE_TOGGLE · VOLUME_UP · VOLUME_DOWN
```

## Navigateur de médias

Le catalogue n'est **jamais déversé à plat** : la Remote pagine ses requêtes et le driver
sert des écrans, comme l'app Apple Watch.

```
OneTV
├── Favoris                    → les chaînes favorites, jouables directement
├── Chaînes par catégorie      → catégories du bouquet (+ « Sans catégorie »)
│     └── <catégorie>          → chaînes + PROGRAMME EN COURS et sa progression
├── Films                      → catégories VOD
│     └── <catégorie>          → films
├── Séries                     → catégories VOD
│     └── <série>              → épisodes
└── Reprendre                  → en cours de visionnage, avec le pourcentage
```

Lecture : `play_media` route selon l'identifiant — `channel:<id>` → `playChannel`,
`movie:<id>` → `playMovie`, `episode:<série>:<saison>:<épisode>` → `playEpisode`.

Le catalogue VOD complet pèse ~0,5 Mo : il est lu **à la demande** et gardé 10 minutes.
Les préfixes provider (`|FR| `) sont retirés à l'affichage.

## Favoris

Les chaînes mises en favori dans l'app (`/api/v1/favorites`) sont exposées sur trois axes :

- **`source_list`** — **les favoris SEULS par défaut**, dans l'ordre de la playlist. Le
  reste du bouquet se parcourt par catégories dans le navigateur, pas dans une liste à
  plat de 843 entrées. Case à cocher au setup pour tout lister quand même :
  **« Lister toutes les chaînes dans les sources »**.
- **Une commande par favori** — `FAV_TF1`, `FAV_CANAL_CINEMA_S`… assignables à une touche
  physique ou à une étape d'activité. Plus `FAVORITE_NEXT` / `FAVORITE_PREVIOUS`, qui
  cyclent depuis la chaîne en cours (câblés sur DPAD droite/gauche).
- **Des pages d'UI « Favoris »** — grille de noms tapables, 20 par page.

L'ordre n'est JAMAIS trié : il porte l'intention de l'utilisateur.

⚠️ Les commandes `FAV_*` et les pages d'UI sont figées à la création de l'entité, donc
lues **au démarrage du driver**. Un favori ajouté après coup est utilisable tout de suite
via les sources et `FAVORITE_NEXT`, mais n'apparaît en commande qu'après un redémarrage
de l'intégration. La résolution, elle, est dynamique : un favori renommé reste joignable.

## Limites connues (mesurées, pas supposées)

- **`on` renvoie 501.** L'API OneTV ne sait pas se lancer elle-même. Pour allumer :
  dans l'activité, faire précéder OneTV d'une commande **Apple TV `home`** (ni `turn_on`
  ni `power_on` ne réveillent une Apple TV endormie — seul `home` marche, ~8 s).
- **Le volume est celui du MOTEUR de lecture**, pas celui du téléviseur.
- **Pas de durée en direct** : `duration` y vaut la profondeur du tampon timeshift
  (~12 s), l'afficher donnerait une barre de progression absurde.
- **Push SSE tvOS seulement** ; iOS répond 501 et retombe sur un sondage 5 s.
- Les lignes décoratives des playlists M3U (`---●★| CINÉMA |★●---`) sont filtrées de
  `source_list` (port de la règle 12 du projet, `naming.js`).
- `/api/v1/favorites` n'existe que sur les versions récentes de l'app : sur une plus
  ancienne, la liste reste vide sans faire échouer le reste.

## Développement

```bash
npm install
cp driver.json src/driver.json   # pratique en dev, ignoré par git
npm start                        # écoute sur :9090
```

Tests, aucun matériel requis (faux OneTV + faux service mDNS fournis) :

```bash
node test/testDriver.js      # setup → entités → état → commandes
node test/testDiscovery.js   # découverte _noopytv._tcp
```

`test/testDriver.js` parle le WebSocket Integration-API exactement comme la Remote et
vérifie les commandes RÉELLEMENT reçues par l'app.

Contre un vrai appareil (driver déjà lancé, config pointant dessus) :

```bash
node test/testRealDevice.js --ws 19091   # LECTURE SEULE, n'envoie aucune commande
node test/testRealBrowse.js  --ws 19091  # parcourt le vrai catalogue, lecture seule
```

## Installation sur la Remote

```bash
./build.sh
```

Puis Web Configurator → **Integrations → Add new → Install custom** → envoyer
`artifacts/uc-intg-onetv-<version>.tar.gz` (firmware ≥ 2.2.0).

Au setup : laisser l'adresse vide pour la découverte mDNS `_noopytv._tcp`, ou saisir
IP + port (8765 par défaut). Si rien n'est trouvé, le flux propose la saisie manuelle au
lieu d'échouer. La clé d'API est récupérée toute seule — elle est annoncée par
`/api/v1/info` et par les TXT mDNS.

### Alternative sans installer

Le driver tourne aussi comme intégration **externe** (Mac, NAS, Docker sur le LAN) : il
s'annonce en mDNS et la Remote le trouve dans « Add new → Discover ».

## Correspondance des commandes

| Remote | OneTV (`/api/v1/player/command`) |
|---|---|
| `play_pause` | `togglePlayPause` |
| `stop`, `off` | `stop` |
| `next` / `previous`, CH+/CH− | `nextChannel` / `previousChannel` |
| `fast_forward` / `rewind` | `seekRelative` ±30 s |
| `seek` | `seekAbsolute` |
| `live` | `seekToLive` |
| `volume`, `volume_up/down` | `setVolume`, `adjustVolume` |
| `mute_toggle` | `toggleMute` |
| `select_source` | `playChannel` (`channelId` + repli `url`) |
| `audio_track` / `subtitle` | `setAudioTrack` / `setSubtitleTrack` (cycle) |

⚠️ `requestId` est obligatoire dans chaque commande : côté Swift il n'est pas optionnel,
sans lui l'app répond `400 Invalid command JSON`.

## Notes d'implémentation

- **`bonjour-service` fait un `throw` depuis un timer** si le multicast échoue
  (`EHOSTUNREACH 224.0.0.251`) : sans callback d'erreur, ça tue tout le driver. Un
  callback est passé et la découverte rend une liste vide au lieu de planter.
- Les chaînes ne sont rechargées que quand `channels_generation` change (`/api/v1/info`,
  O(1) côté app) : re-télécharger 150k chaînes à chaque cycle ferait travailler la TV.
- `media_player` et `remote` partagent un client : on ne coupe le sondage que lorsque
  les DEUX entités sont désabonnées.
- **Les épisodes arrivent en `title` / `season` / `episode`** — pas `name` /
  `seasonNumber` / `episodeNumber`. Avec les mauvaises clés, tous les épisodes
  s'affichaient « S1E1 ».
- **Le navigateur ne présuppose aucun sondage terminé** : la Remote s'abonne et ouvre le
  navigateur dans la foulée, donc les chaînes sont chargées à la demande. Sans ça, une
  catégorie s'affichait vide.
- **`/api/v1/channels` ne porte pas d'EPG** (contrairement à `/api/v1/favorites`) : le
  programme en cours vient de **`/api/v1/now`**, UNE requête pour tout le bouquet
  (~120 Ko), gardée 60 s et lue seulement à la navigation — jamais un appel par chaîne
  affichée. Si l'EPG manque, les chaînes s'affichent quand même (sous-titre = catégorie).
- **Le payload des favoris ne porte pas `stream_url`** (contrairement à celui des
  chaînes) : chaque favori est raccordé à son entrée de playlist avant lecture, sinon le
  repli par URL de `playChannel` — celui qui sauve les bascules de playlist — disparaît
  dès qu'une chaîne est mise en favori.
