# storage — frontend

Angular 21 (composants autonomes, signaux), identité Foyer. Une seule page : l'explorateur de
fichiers. Le contrat de l'API qu'il appelle est décrit dans `../README.md` ; la feuille de route,
dans `to_do_storage.md` à la racine du dépôt parent.

## Où est quoi

```
src/app/core/                      API HTTP, Keycloak, thème — rien de propre à l'explorateur
src/app/pages/browser/
  logic/                           fonctions pures, sans Angular, testées sans navigateur
    entries.ts                     liste plate de l'API → dossiers + fichiers ; tri, filtre, noms libres
    selection.ts                   clic, Ctrl, Maj, plage, rectangle, flèches
    actions.ts                     LA table des actions (barre, menu contextuel, clavier)
    upload-queue.ts                file d'envoi, conflits de nom
  browser.store.ts                 l'état de la page, en signaux
  browser.component.*              mise en place : volet, en-tête, dialogues, bandeau d'annulation
  parts/                           liste, barre d'actions, volet des espaces, gestion du partage,
                                   panneau d'envois, zone de dépôt, icônes
```

Trois règles tiennent l'ensemble :

1. **Une action = une entrée dans `logic/actions.ts`.** La barre, le menu contextuel (clic droit,
   appui long) et le clavier lisent la même table. Pour ajouter « Dupliquer » : une entrée, plus la
   méthode correspondante dans `ActionHost` / `BrowserStore`.
2. **La logique vit dans `logic/`**, sans import Angular : elle se teste en quelques millisecondes.
3. **Aucune couleur en dur** : uniquement les variables Foyer de `src/styles.scss`. Les éléments
   rendus hors des composants (menu contextuel, rectangle de sélection) sont stylés dans ce même
   fichier, pas dans un composant.

À savoir avant de modifier :

- L'API n'a **pas d'objet « dossier »** : un dossier est un préfixe de chemin. Un dossier créé dans
  l'interface est local à la page jusqu'à son premier fichier (`BrowserStore.createFolder`).
- **Suppression** : définitive, annulable 7 s (`UNDO_DELAY_MS`). L'appel `DELETE` ne part qu'à
  l'expiration du bandeau ; quitter ou fermer la page pendant le bandeau **valide** la suppression
  (`flushPendingDelete`, requêtes `keepalive`).
- **Droit d'écriture** : lu dans `can_write` de `GET /api/shares/` (`BrowserStore.canWrite`), jamais
  recalculé ici.
- **Partage géré par une application** : reconnu au seul propriétaire `service:<client>`
  (`BrowserStore.managedBy`). Un partage d'app créé au nom d'un compte humain n'est pas
  reconnaissable avec l'API actuelle.
- Renommer, déplacer, copier : absents de l'API, donc de l'interface.

## Commandes

```bash
npm install
npm run build        # compilation stricte + bundle dans dist/
npm test             # tests unitaires de logic/ (vitest)
```

## Tests de gestes en navigateur réel

`e2e/gestes.spec.ts` est propre à cette app et **hors catalogue** : il ne définit aucun test tant
que `E2E_GESTES` n'est pas posé, si bien que le runner du lab, qui parcourt `e2e/` pour
`cloisonnement.spec.ts`, ne le voit pas. Il se lance à la main :

```bash
npm run build
LAB_ROOT=/chemin/du/depot/parent bash e2e/jouer-gestes.sh              # ce build, contre le backend en service
LAB_ROOT=/chemin/du/depot/parent bash e2e/jouer-gestes.sh --deploye    # le frontend déployé
```

Il écrit dans l'espace personnel du compte `e2edev` (fichiers `zz-…`, supprimés à la fin) et ne
touche à aucun partage.
