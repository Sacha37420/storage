"""Réglages des tests : `python manage.py test --settings=config.settings_test`.

Base SQLite en mémoire — les tests ne touchent ni l'instance PostgreSQL du lab
ni son volume de fichiers (chaque test pose son propre MEDIA_ROOT temporaire).
Tout le reste vient de config.settings, pour tester le vrai câblage (classe
d'authentification, permissions par défaut, URLs).
"""
from .settings import *  # noqa: F401,F403

DATABASES = {
    'default': {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': ':memory:',
    }
}

# Valeurs fixes : les tests ne doivent pas dépendre du .env de l'installation.
KEYCLOAK_CLIENT_ID = 'storage'
KEYCLOAK_REQUIRED_GROUPS = 'famille,developers'
KEYCLOAK_SERVICE_WRITE_SHARES = {'appli-admin': 'appli'}
KEYCLOAK_SERVICE_WRITE_PREFIXES = {}
KEYCLOAK_TRUSTED_CLIENTS = {'storage', 'autre-app', 'appli-admin'}
