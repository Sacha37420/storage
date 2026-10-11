# Feuille de route — storage

Le plan par lots de `storage` (analyse, décisions du propriétaire, état de chaque lot) est tenu
dans `to_do_storage.md`, à la racine du dépôt du lab. Ce fichier déclare la commande de test au
lanceur du lab (`scripts/app-test.sh`), qui joue les tests avant toute mise en service.

## Commande de test
python manage.py test --settings=config.settings_test api
