# storage

Point d'entrée unique des **fichiers utilisateur** du lab : espaces personnels, partages, et une API
que les autres apps appellent au lieu de se donner leur propre volume ou de mettre des blobs en base.
Les octets vivent sur un volume possédé par l'infrastructure (`infra_storage-media`), monté par
`storage-backend` seul : aucune autre app ne le monte, tout accès passe par l'API et ses contrôles.

Django + DRF (`backend/`), Angular (`frontend/`). Ports 8093 / 4211, chemins `/storage-api/` et
`/storage/` derrière Caddy.

- [1. Contrat d'API](#1-contrat-dapi)
- [2. Ce que le navigateur reçoit](#2-ce-que-le-navigateur-reçoit--politique-de-service-du-contenu)
- [3. S'authentifier depuis une app](#3-sauthentifier-depuis-une-app)
- [4. Espaces et partages](#4-espaces-et-partages)
- [5. Le jeton dans l'adresse](#5-le-jeton-dans-ladresse-token)
- [6. Tests, déploiement, configuration](#6-tests-déploiement-configuration)
- [7. Suite](#7-suite)

---

## 1. Contrat d'API

Base interne (de conteneur à conteneur, réseau `dev-net`) : `http://storage-backend:8000`.
Base publique : `https://<domaine>/storage-api`. Les chemins ci-dessous s'ajoutent à l'une ou l'autre.

Toute route exige un jeton Keycloak (section 3). Sans jeton valide : 401 ou 403.
Schéma OpenAPI : `/api/schema/`, interface Swagger : `/api/docs/`.

**Adressage.** Un fichier est désigné par `(espace, chemin)`. L'espace est un nom d'utilisateur
(espace personnel) ou un nom de partage. Le chemin est libre, avec `/` comme séparateur : ni `/` en
tête ou en fin, ni segment vide, ni `.` ou `..`. Il n'existe **pas d'objet « dossier »** : un dossier
est un préfixe commun à des chemins, et disparaît avec son dernier fichier.

### Fichiers

Objet fichier renvoyé par les routes ci-dessous :

```json
{"namespace": "…", "relative_path": "…", "size": 123, "content_type": "…",
 "uploaded_by_email": "…", "created_at": "…", "updated_at": "…"}
```

| Méthode et chemin | Corps | Réponse | Codes |
|---|---|---|---|
| `GET /api/files/<espace>/` | — ; option `?prefix=<début de chemin>` | liste **plate** d'objets fichier, triée par chemin, sans pagination | 200 · 403 accès refusé · 404 espace inconnu |
| `POST /api/files/<espace>/` | multipart : `file`, `relative_path` | l'objet fichier | **201** · 400 champ manquant, chemin invalide ou fichier trop gros · 403 lecture seule |
| `GET /api/files/<espace>/content/<chemin>` | — | les octets, en flux ; en-têtes : section 2 | 200 · 403 · 404 |
| `DELETE /api/files/<espace>/content/<chemin>` | — | vide | 204 · 403 lecture seule · 404 |

À savoir :
- `POST` sur un chemin existant **remplace** le fichier (l'ancien contenu est effacé), toujours avec
  le code 201. Il n'y a ni refus ni version : c'est à l'appelant d'éviter les collisions (les apps
  du lab préfixent par un UUID ou une clé primaire).
- Le `content_type` enregistré est celui de la partie multipart ; s'il est vide, il est déduit de
  l'extension du chemin.
- La suppression est **définitive**. Pas de corbeille.
- Taille maximale par fichier : `MAX_UPLOAD_BYTES` (200 Mo par défaut).
- Les requêtes partielles (`Range`) ne sont pas prises en charge : la réponse est toujours le
  fichier entier.

### Partages

Objet partage : `{"name", "owner_username", "required_groups", "parent", "created_at"}`.
Objet membre : `{"member_email", "role", "added_at"}`, `role` valant `read` ou `write`.

| Méthode et chemin | Corps | Réponse | Codes |
|---|---|---|---|
| `GET /api/me/` | — | `{email, username, groups}` | 200 |
| `GET /api/shares/` | — | `{owned: […], member_of: […], tree: […]}` | 200 |
| `POST /api/shares/` | `{name, parent?}` | l'objet partage ; l'appelant en devient propriétaire | 201 · 400 nom invalide ou déjà pris |
| `PATCH /api/shares/<nom>/` | `{parent}` (nom d'un partage, ou `null` / `""` pour détacher) | l'objet partage | 200 · 400 · 403 · 404 |
| `DELETE /api/shares/<nom>/` | — | vide ; **efface tous les fichiers du partage** | 204 · 400 s'il a des partages enfants · 403 · 404 |
| `GET /api/shares/<nom>/members/` | — | liste d'objets membre | 200 · 403 · 404 |
| `POST /api/shares/<nom>/members/` | `{member_email, role?}` (`read` par défaut) | l'objet membre ; met à jour le rôle si le membre existe | 201 dans les deux cas · 400 |
| `DELETE /api/shares/<nom>/members/<courriel>/` | — | vide | 204 · 404 s'il n'était pas membre |

Les routes `PATCH`, `DELETE` et `members` d'un partage sont réservées à son **propriétaire**.
Un nom de partage est un slug : minuscules, chiffres, tirets, 2 à 64 caractères, sans tiret aux
extrémités. Il est immuable et ne peut pas reprendre le nom d'un compte déjà vu par l'API.

`tree` (dans `GET /api/shares/`) est l'arborescence des partages visibles par l'appelant :
`{name, owner_username, accessible, children}` et, si `accessible` est vrai, `access`
(`owner` / `group` / `member`), `can_write`, `required_groups`, `created_at`. Un nœud
`accessible: false` n'est qu'un ancêtre affiché pour la navigation : il ne donne aucun droit.

### Ce qui est stable, ce qui ne l'est pas

Utilisé par les apps du lab, donc **à ne pas changer sans les prévenir** : les quatre routes de
fichiers (forme de l'objet, code 201, remplacement au `POST`, `?prefix=`), `POST /api/shares/`,
`DELETE /api/shares/<nom>/`, et les trois routes de membres.

Utilisé par le seul frontend de `storage` : `GET /api/me/`, `GET /api/shares/`,
`PATCH /api/shares/<nom>/`.

Ne pas s'appuyer dessus : le code renvoyé par `POST /api/shares/` quand le nom est déjà pris (400
attendu, mais une app du lab a constaté un 500) — tester l'existence autrement, par exemple en
lisant d'abord les membres.

### Ce que l'API ne fait pas

Renommer, déplacer, copier, opérations par lot, dossiers vides, corbeille, archive, vignettes,
recherche, quotas, liens publics : **absents**. Voir section 7.

---

## 2. Ce que le navigateur reçoit — politique de service du contenu

Toutes les apps du lab partagent la même origine. Un fichier déposé ici ne doit donc jamais pouvoir
s'y exécuter. `GET …/content/<chemin>` ne renvoie **jamais** le type déclaré par le déposant tel
quel : ce type sert de clé dans des listes blanches (`backend/api/content_safety.py`), et la
réponse porte toujours `X-Content-Type-Options: nosniff`.

| Type déclaré au dépôt | `Content-Type` renvoyé | `Content-Disposition` | `Content-Security-Policy` |
|---|---|---|---|
| PNG, JPEG, GIF, WebP, AVIF, BMP, ICO ; audio (`mpeg`, `mp4`, `aac`, `ogg`, `opus`, `wav`, `webm`, `flac`) ; vidéo (`mp4`, `webm`, `ogg`, `quicktime`) | forme canonique | `inline` | `sandbox` |
| `application/pdf` | `application/pdf` | `inline` | aucune |
| `text/plain` | `text/plain; charset=utf-8` (ou `us-ascii`, `iso-8859-1`, `iso-8859-15`, `windows-1252` s'il est déclaré) | `inline` | `sandbox` |
| Formats inertes : `model/*`, `font/*`, autres `image/*` `audio/*` `video/*`, JSON, GeoJSON, zip, gzip, tar, 7z, CSV, TSV, Markdown, bureautique (OOXML, OpenDocument, `msword`, RTF…) | inchangé, sans paramètres | `attachment` | `sandbox; default-src 'none'` |
| **Tout le reste** : HTML, XHTML, SVG, tout XML (`*/xml`, `*+xml`), JavaScript, CSS, type inconnu, vide ou mal formé | `application/octet-stream` | `attachment` | `sandbox; default-src 'none'` |

Les octets ne sont jamais modifiés ; seuls les en-têtes le sont. Quelques alias sont ramenés à leur
forme canonique (`image/jpg` → `image/jpeg`, `audio/mp3` → `audio/mpeg`…). Le PDF n'a pas de
`sandbox` parce que la visionneuse intégrée des navigateurs ne se charge pas dans un bac à sable.

Un « type menteur » n'y gagne rien : un fichier HTML déclaré `image/png` est servi `image/png`
avec `nosniff`, et le navigateur affiche une image cassée.

### Ce que ça implique pour une app qui affiche un fichier

- **`<img>`, `<audio>`, `<video>`, `fetch`, `GLTFLoader`** : inchangés. `Content-Disposition` et la
  CSP d'une sous-ressource n'ont d'effet que lors d'une navigation.
- **Lien ouvert dans un onglet** (`<a href target="_blank">`) : image, PDF, texte, audio et vidéo
  s'affichent ; tout le reste se télécharge.
- **`fetch` puis `Blob`** : le `type` du blob est celui du tableau. Un fichier HTML ou SVG arrive
  donc en `application/octet-stream` — ce qui est voulu : un blob `text/html` rouvert dans un
  onglet s'exécuterait sur l'origine de la page. Une app qui a besoin du type d'origine doit le
  garder dans sa propre base, pas le relire ici.
- **SVG** : non affichable par `<img>` depuis `storage`. Une app qui veut afficher des SVG déposés
  par des utilisateurs doit les assainir elle-même avant de les republier.
- **Proxy** (l'app relit les octets côté serveur et les resert) : la décision d'exposer est alors
  la sienne. Reprendre le `Content-Type` de `storage` donne un type déjà filtré ; il reste à poser
  soi-même `X-Content-Type-Options: nosniff`, et à ne pas remplacer ce type par celui que l'app
  aurait reçu de l'utilisateur.

Pour qu'un nouveau format soit servi `inline`, l'ajouter à `_INLINE_TYPES` — seulement s'il ne peut
porter aucun script — avec le test correspondant dans `backend/api/tests/`.

---

## 3. S'authentifier depuis une app

Le jeton est un JWT Keycloak du realm du lab, vérifié par signature (JWKS) et expiration
(`backend/api/authentication.py`). Son `azp` (le client qui l'a émis) doit figurer dans la liste
des clients de confiance ; `admin-cli` n'y figure jamais. Trois façons d'en présenter un.

### a. Transmettre le jeton de l'utilisateur connecté

Pour une app dont l'utilisateur agit en son propre nom. Le backend de l'app recopie l'en-tête
`Authorization` qu'il a reçu, ou son frontend appelle `storage` directement (même origine derrière
Caddy, donc pas de CORS).

- Côté `storage` : ajouter le `client_id` de l'app à `KEYCLOAK_TRUSTED_CLIENTS`. Rien à faire dans
  Keycloak.
- Le jeton doit porter un `email` et un groupe de `KEYCLOAK_REQUIRED_GROUPS`.
- Les droits sont ceux de l'utilisateur : son espace personnel, les partages dont il est
  propriétaire ou membre, ceux de ses groupes.
- Exemple : `carto-lab` (`backend/api/storage_client.py`, sans compte de service) ; `code-route` et
  `craft-lab` suivent le même modèle.

Ne jamais faire transiter le jeton par une donnée persistée (paramètres de tâche, champ JSON exposé
par l'API de l'app).

### b. Compte de service

Pour une app qui écrit **sans utilisateur connecté** (tâche de fond), ou dont les règles d'accès
sont portées par ses propres modèles. L'app obtient un jeton par `client_credentials` avec son
client compagnon `<app>-admin` (créé par `scripts/create-app-client.sh` du dépôt parent dès que
`<app>/.keycloak-service-account-roles` existe, même vide).

Côté `storage`, le client est déclaré dans l'une des deux variables suivantes (inutile de le
répéter dans `KEYCLOAK_TRUSTED_CLIENTS`) :

- `KEYCLOAK_SERVICE_WRITE_SHARES` — `client_id:partage` : lecture et écriture sur **ce seul
  partage**. Exemple : `restauration` (un partage unique, republié par un proxy public de l'app).
- `KEYCLOAK_SERVICE_WRITE_PREFIXES` — `client_id:préfixe` : lecture et écriture sur tout partage
  dont le nom commence par ce préfixe, **créé automatiquement** au premier accès, avec pour
  propriétaire `service:<client_id>`. Exemple : `conciergerie` (un partage par bien).

Un compte de service n'a ni espace personnel, ni courriel, ni groupes ; tout autre espace lui
répond 403. Comme propriétaire des partages qu'il crée (par préfixe ou par `POST /api/shares/`),
il peut en gérer les membres : c'est ainsi qu'une app donne à ses utilisateurs un accès direct en
lecture, en miroir de ses propres règles.

L'obtention du jeton côté app est à reprendre de `conciergerie/backend/api/storage_client.py`
ou de `restauration/backend/api/storage_client.py`.

### c. Partage lié à un groupe

Pour une app dont **tout le groupe autorisé** lit et écrit les mêmes fichiers. Le partage porte
`required_groups` : tout jeton dont le claim `groups` croise cette liste y a les droits du
propriétaire. Rien à synchroniser — l'appartenance est lue dans le jeton à chaque requête.

Ce champ n'est pas modifiable par l'API ; il se pose par commande (section 4). Il se combine avec
(a) : c'est le jeton de l'utilisateur qui est présenté. Exemple : `carto-lab`.

### Laquelle choisir

| Situation | Voie |
|---|---|
| L'utilisateur range ses propres fichiers | a |
| Tout un groupe partage les mêmes fichiers | a + c |
| Tâche de fond, ou accès décidé par les modèles de l'app | b, un partage |
| Un espace par ressource métier (bien, projet, arbre…) | b, par préfixe, puis membres |
| Lecture anonyme | aucune : l'app republie elle-même par un proxy (cas `restauration`) |

---

## 4. Espaces et partages

| Espace | Qui lit | Qui écrit |
|---|---|---|
| **Personnel** — porte le nom d'utilisateur | son titulaire | son titulaire |
| **Partage par membres** | propriétaire et membres | propriétaire et membres `write` |
| **Partage par groupe** (`required_groups`) | propriétaire, membres, groupe | propriétaire, groupe, membres `write` |

Une seule fonction décide : `resolve_namespace` (`backend/api/permissions.py`). Toute nouvelle
route doit passer par elle.

La **hiérarchie** (`parent`) est une pure organisation : un partage enfant n'hérite d'aucun droit
de son parent, et inversement. Par l'API, un parent doit appartenir au même propriétaire. Un
partage qui a des enfants ne peut pas être supprimé.

Commandes de gestion, à lancer dans le conteneur (`docker exec storage-backend python manage.py …`) :

| Commande | Rôle |
|---|---|
| `create_share <nom> --owner <utilisateur> [--parent <nom>]` | crée un partage vide ; `--owner` peut valoir `service:<client_id>` |
| `create_group_share <nom> --owner <utilisateur> --required-groups <g1,g2>` | crée un partage lié à des groupes, ou met à jour ses groupes |
| `set_share_parent <nom> --parent <nom>` ou `--detach` | rattache ou détache, sans la contrainte de même propriétaire |

---

## 5. Le jeton dans l'adresse (`?token=`)

Le même JWT est accepté en paramètre `?token=` quand l'en-tête `Authorization` est absent, avec
exactement les mêmes contrôles. Il existe parce qu'une balise `<img>` et le chargeur interne de
`GLTFLoader` ne peuvent pas poser d'en-tête.

S'en servent aujourd'hui, dans leur frontend : `atelier-3d` (photos, maillages, lien de
téléchargement), `craft-lab` (icônes), `arbre-genealogique` (photos).

**Ce n'est pas la voie à prendre pour du nouveau code.** Un jeton dans une adresse se retrouve dans
l'historique, les journaux et tout lien copié. Préférer un `fetch` avec en-tête `Authorization`,
puis `URL.createObjectURL` pour une image ; `GLTFLoader.setRequestHeader` pour un modèle. Le
paramètre est conservé tant que ces trois apps en dépendent.

---

## 6. Tests, déploiement, configuration

### Tests

Django, sans PostgreSQL ni réseau (SQLite en mémoire, `config/settings_test.py`). Depuis la racine
du dépôt parent :

```bash
docker run --rm --env-file storage/.env --network none \
  -v "$PWD/storage/backend:/app:ro" -w /app storage-backend:latest \
  python manage.py test --settings=config.settings_test api
```

Ils couvrent la politique de service du contenu et les contrôles d'accès de la route de contenu
(`backend/api/tests/`). Les autres routes n'ont pas encore de tests. Le frontend n'a qu'un test de
bout en bout, `frontend/e2e/cloisonnement.spec.ts`, lancé par le runner du lab.

### Déploiement

Depuis le dépôt parent : `bash scripts/setup2.sh storage --yes`. Le code du backend est copié dans
l'image : toute modification demande une reconstruction. Les migrations sont appliquées au
démarrage du conteneur. Le volume `infra_storage-media` et le réseau `dev-net` sont créés par
`infra/`, pas par cette app.

Le backend tourne aujourd'hui sous le serveur de développement de Django (`runserver`, cf.
`backend/Dockerfile`).

### Variables d'environnement

Fichier `.env` à la racine du sous-module ; modèle commenté dans `.env.example`.

| Variable | Rôle |
|---|---|
| `SECRET_KEY` | clé Django |
| `DEBUG` | à laisser à `False` en service (sinon pages d'erreur techniques et CORS ouvert) |
| `ALLOWED_HOSTS` | hôtes acceptés, séparés par des virgules |
| `SCRIPT_NAME` | préfixe sous lequel Caddy publie l'API |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SCHEMA` | base PostgreSQL et schéma de l'app |
| `MEDIA_ROOT` | répertoire des octets dans le conteneur (point de montage du volume) |
| `MAX_UPLOAD_BYTES` | taille maximale d'un fichier déposé |
| `KEYCLOAK_ISSUER_URI` | realm dont les clés signent les jetons acceptés |
| `KEYCLOAK_CLIENT_ID` | client de l'app elle-même |
| `KEYCLOAK_REQUIRED_GROUPS` | groupes admis à utiliser l'API (comptes humains) ; vide = aucun filtre |
| `KEYCLOAK_TRUSTED_CLIENTS` | clients dont les jetons sont acceptés (voie a) |
| `KEYCLOAK_SERVICE_WRITE_SHARES` | comptes de service bornés à un partage (voie b) |
| `KEYCLOAK_SERVICE_WRITE_PREFIXES` | comptes de service bornés à un préfixe (voie b) |
| `KEYCLOAK_PUBLIC_URL`, `KEYCLOAK_REALM` | adresse publique de Keycloak, pour Swagger et le frontend |
| `CORS_ALLOWED_ORIGINS`, `FRONTEND_URL`, `SERVER_URL_LAN`, `SERVER_URL_WAN`, `PORT_FRONTEND` | origines autorisées hors même origine |
| `DOMAIN`, `PORT_BACKEND` | lus par Caddy et par le frontend pour construire les adresses |

Les trois listes Keycloak ne sont pas des secrets, mais les vider coupe l'accès des apps
correspondantes (refus à leur prochain appel). À compléter dans `.env` **et** dans `.env.example` à
chaque nouvelle app.

---

## 7. Suite

L'interface et l'API sont minimales : pas de sélection, de renommage, de déplacement, de corbeille
ni d'aperçu. L'analyse, la cible et le plan par lots sont dans `to_do_storage.md`, à la racine du
dépôt parent.
