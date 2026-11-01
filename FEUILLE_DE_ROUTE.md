# Feuille de route — storage

Ce fichier est lu par une machine : `validate-app.sh` refuse de déployer s'il manque ou s'il ne
contient aucun lot au format ci-dessous, et `app-test.sh` lit la commande de test. Garder les titres
tels quels.

L'analyse de l'ergonomie et les décisions du propriétaire (Q1 à Q6, 2026-10-11) sont dans
`to_do_storage.md`, à côté de ce fichier. Ce fichier était à la racine du dépôt du lab jusqu'au
2026-10-31. Son en-tête est périmé : les lots 0 à 2 sont fusionnés et en service, la branche
`ergonomie` n'existe plus, et l'app est hors `DEBUG`.

Les lots ci-dessous reprennent son plan, corrigé selon les décisions, plus les constats de l'analyse
du 2026-10-31 (vue d'ensemble : `to_do_global.md`). **Neuf apps consomment l'API : aucune route
existante ne doit changer de forme.** [C] constaté, [D] déduit.

## Commande de test
python manage.py test --settings=config.settings_test api

## Lot 1 — Lots 0, 1 et 2 de to_do_storage.md : contenu neutralisé, gestes usuels   ·   statut : livré
**Objectif :** contenu actif neutralisé (`api/content_safety.py`) ; sélection, clavier, menu
contextuel, suppression annulable, glisser-déposer, file d'envoi, conflits de nom.
**Tâches :**
- [x] Lot 0 (`39ee305`), lot 1 (`b6015dc`), lot 2 (`9613b2e`) ; refus d'un `kid` inconnu (`c35f0dd`)
**Tests à passer avant de clore le lot :**
- [x] 49 tests backend (route de contenu) ; 81 tests vitest (`logic/`)
- [x] `LAB_ROOT=$PWD bash storage/frontend/e2e/jouer-gestes.sh --deploye` : 25 gestes
**Vérifié le :** 2026-10-11 (gestes rejoués contre le déployé, cloisonnement 3/3) ; relevé le 2026-10-31 : version en service = `c35f0dd`.

## Lot 2 — `?token=` retiré, gabarit front et ports   ·   statut : en cours
**Objectif :** un jeton en paramètre d'URL ne permet plus rien (chantier T4, puis chantier failles I4 : le repli est supprimé).
**Constat [C] :** `?token=` est accepté sur toutes les routes et toutes les méthodes, partages
compris (`api/authentication.py:105`). Les trois frontends qui s'en servent (arbre-genealogique,
atelier-3d, craft-lab) n'en ont besoin que pour `GET …/content/`.
**Tâches :**
- [x] N'accepter `?token=` que pour `GET`/`HEAD` sur la route de contenu (`_query_token_allowed`,
  `api/authentication.py` : la vue résolue doit être `FileContentView`, donc indépendant du préfixe
  `SCRIPT_NAME`) ; ailleurs le paramètre est ignoré, l'en-tête Bearer reste lu partout — dépassé le 2026-11-01
- [x] Chantier failles, I4 : `?token=` n'est plus lu nulle part (`_query_token_allowed` et le repli retirés de `api/authentication.py`) ; seul l'en-tête Bearer reste. **À déployer après** arbre-genealogique, atelier-3d et craft-lab (secteur C)
- [x] Gabarit front (I2) : `tokenBases()`, PKCE, `loginRedirectUri` ; specs `token-scope`/`redirect-uri` sous vitest ; ports liés à `${LAB_BIND_ADDR:-127.0.0.1}` (I1)
**Tests à passer avant de clore le lot :**
- [x] `POST`, `DELETE` et `GET /api/shares/` avec `?token=` → refus (403, le refus habituel de
  cette API sans en-tête) ; aussi `POST /api/shares/`, `GET /api/me/`, liste `/api/files/<ns>/`,
  `DELETE …/content/…` ; `GET` et `HEAD …/content/…?token=` acceptés ; mauvais `azp` ou groupe
  refusé en `?token=` ; Bearer accepté sur toutes les routes (`api/tests/test_query_token.py`, 16 tests) — remplacé :
- [x] `?token=` refusé partout, `GET` et `HEAD …/content/…` compris, quel que soit le jeton ; Bearer accepté partout ; un `?token=` à côté d'un Bearer ne change rien (`api/tests/test_query_token.py`, 17 tests)
- [ ] Images d'atelier-3d, craft-lab et arbre-genealogique vérifiées en navigateur réel
**Vérifié le :** 2026-10-31 — `ESSAI_CMD='python manage.py test --settings=config.settings_test api'
bash chantiers/tests/essai.sh storage` : 65 tests OK (49 existants + 16). Même suite avec la
restriction neutralisée : 8 échecs, tous dans `test_query_token` (l'écart est bien détecté).
Consommateurs revérifiés par grep : les trois `mediaUrl`/`iconUrl` ne visent que
`/api/files/<ns>/content/<chemin>`. Navigateur réel : à faire après déploiement.
2026-11-01 — non déployé. Même commande : 66 tests OK ; avec l'`authentication.py` d'avant, 7 échecs (les refus de `?token=` sur le contenu). `vitest` : 88 tests OK ; image `storage-frontend:candidat` construite ; `docker compose config` : `host_ip: 127.0.0.1`. Grep `dev/` et `dev2/` : plus aucun `?token=` vers storage hors des trois apps du secteur C (corrigées, non déployées).

## Lot 3 — Tests de contrat de l'API existante   ·   statut : à faire
**Objectif :** figer ce dont dépendent les neuf consommateurs, avant tout changement d'interface.
**Constat [C] :** aucun test pour :
- `POST`/`GET /api/files/<espace>/` et `?prefix=` ;
- `shares/*`, `members/*` ;
- la hiérarchie et son override ;
- `KEYCLOAK_SERVICE_WRITE_PREFIXES`.

Le README le dit lui-même (l. 270).
**Tâches :**
- [ ] Tests de liste, de dépôt (201, remplacement au `POST`), de partages et membres, de préfixe de service et de hiérarchie
- [ ] Vérifier le 500 annoncé sur un nom de partage en doublon (README l. 93) : probablement un 400 désormais [D]
**Tests à passer avant de clore le lot :**
- [ ] `bash chantiers/tests/essai.sh storage` vert ; une mutation provoquée dans une vue fait rougir la suite
**Vérifié le :**

## Lot 4 — Documentation pour les consommateurs   ·   statut : à faire
**Objectif :** une app consommatrice trouve tout dans le README ; l'exemple de `.env` est juste.
**Tâches :**
- [ ] README : retirer le renvoi vers `/api/schema/` et `/api/docs/` (404 hors DEBUG, l. 27) ; « runserver » → gunicorn (l. 283) ; tests (l. 270) ; §7 (sélection et gestes livrés)
- [ ] Tableau des neuf consommateurs : voie (jeton transmis, compte de service, préfixe), partage ou préfixe, routes utilisées
- [ ] `.env.example` : `KEYCLOAK_TRUSTED_CLIENTS` (8 clients en service, 2 dans l'exemple) ; tdfc, arbre et atelier sont passés de `SERVICE_WRITE_SHARES` à `SERVICE_WRITE_PREFIXES`
- [ ] Mettre à jour l'en-tête de `to_do_storage.md`, et le texte de son lot 3 : corbeille et refus dans les partages d'app sont abandonnés (Q1, Q2)
**Tests à passer avant de clore le lot :**
- [ ] Les clés Keycloak de `.env` et de `.env.example` sont les mêmes (valeurs mises à part) ; relecture du tableau des consommateurs contre leur code
**Vérifié le :**

## Lot 5 — Déplacer, renommer, copier ; dossiers vides   ·   statut : à faire
**Objectif :** lot 3 de `to_do_storage.md`, sans corbeille (Q1) et sans refus dans les partages d'app (Q2).
⚙ Régime chantier : nouvelle interface consommée par plusieurs parties. Prérequis : lot 3 ci-dessus.
**Tâches :**
- [ ] `POST /api/files/<espace>/ops/` (move, copy, rename) ; objet `Folder` pour les dossiers vides
**Tests à passer avant de clore le lot :**
- [ ] Ceux de `to_do_storage.md` § Lot 3 ; les tests de contrat du lot 3 restent verts
**Vérifié le :**

## Lot 6 — Archive, informations, lien, espace occupé   ·   statut : à faire
**Objectif :** lot 4 de `to_do_storage.md` (frontend seul) : archive zip côté client, panneau
« Informations », « Copier le lien », espace occupé par dossier.
**Tâches :**
- [ ] Selon `to_do_storage.md` § Lot 4
**Tests à passer avant de clore le lot :**
- [ ] Ceux de `to_do_storage.md` § Lot 4
**Vérifié le :**

## Lot 7 — Lecture partielle, vignettes, aperçu, grille   ·   statut : à faire
**Objectif :** lot 5 de `to_do_storage.md`. Le passage à gunicorn qu'il prévoyait est déjà fait.
**Tâches :**
- [ ] `Range` sur la route de contenu ; vignettes `…/thumb/` ; aperçu (jamais de HTML ni de SVG rendu) ; vue grille ; images par `fetch` + `Blob`
**Tests à passer avant de clore le lot :**
- [ ] Ceux de `to_do_storage.md` § Lot 5 ; bundle initial sous le budget de 500 ko (546 ko aujourd'hui)
**Vérifié le :**

## Lot 8 — Partager un dossier   ·   statut : à faire
**Objectif :** lot 6 de `to_do_storage.md` : « Partager ce dossier… » (déplacer vers un partage, Q3),
liste des membres lisible par les membres.
**Tâches :**
- [ ] Selon `to_do_storage.md` § Lot 6 ; reconnaître les partages d'app créés au nom d'un humain (carto-lab, code-route, craft-lab : un champ côté backend)
**Tests à passer avant de clore le lot :**
- [ ] Ceux de `to_do_storage.md` § Lot 6
**Vérifié le :**

## Lot 9 — Front et parcours restants   ·   statut : à faire
**Objectif :** gabarit front aligné (T3), parcours jamais vérifiés.
**Tâches :**
- [ ] `tokenBases()` ; PKCE ; un seul volet latéral (fusion avec la nav Foyer)
- [ ] Ⓟ Parcours réels : glisser depuis le bureau, comportement dans un partage (lecture, écriture, groupe), tactile, lecteur d'écran
- [ ] Lot 7 de `to_do_storage.md` (recherche, archive serveur, pagination) seulement si un besoin apparaît
**Tests à passer avant de clore le lot :**
- [ ] Cloisonnement 3/3 ; 25 gestes rejoués contre le déployé
**Vérifié le :**

## Mise en service — chantier « failles » (2026-11-01)
Les mentions « non déployé » ci-dessus datent d'avant cette mise en service. Image construite pendant
que l'ancienne tournait, `scripts/app-test.sh` : 66 tests OK, puis `up -d --no-build` ; ports
publiés sur `127.0.0.1` ; client Keycloak passé en PKCE S256 exigé, URI de retour réduites à celles de
l'app (`create-app-client.sh --pkce --prune-uris`) ; cloisonnement `lab-runner` 3/3 avant et après le durcissement du client, puis de nouveau 3/3 sur Keycloak 26.8.1.
Restent les vérifications en navigateur réel notées dans les lots (images, coffres de clés, envois).
