"""POST /api/shares/ — un nom réservé à un compte de service ne se prend pas
en self-service, et un jeton sans échéance est refusé.

Même socle que test_file_content_view : vrais JWT RS256 signés par une clé
locale, seul le client JWKS est remplacé.
"""
import time

import jwt
from django.test import override_settings

from api.models import Share

from .test_file_content_view import _KEY, _Base, make_token


def bearer(token):
    return {'HTTP_AUTHORIZATION': f'Bearer {token}'}


class NomsReservesAuxComptesDeServiceTests(_Base):

    def creer(self, name, token):
        return self.client.post('/api/shares/', {'name': name}, format='json', **bearer(token))

    def test_partage_exact_d_un_compte_de_service(self):
        # settings_test : KEYCLOAK_SERVICE_WRITE_SHARES = {'appli-admin': 'appli'}
        self.assertEqual(self.creer('appli', make_token('mallory')).status_code, 400)
        self.assertFalse(Share.objects.filter(name='appli').exists())
        service = make_token('service-account-appli-admin', azp='appli-admin',
                             groups=(), email=False)
        self.assertEqual(self.creer('appli', service).status_code, 201)

    @override_settings(
        KEYCLOAK_SERVICE_WRITE_PREFIXES={'conc-admin': 'conciergerie-bien-'},
        KEYCLOAK_TRUSTED_CLIENTS={'storage', 'autre-app', 'appli-admin', 'conc-admin'},
    )
    def test_prefixe_d_un_compte_de_service(self):
        self.assertEqual(self.creer('conciergerie-bien-42', make_token('mallory')).status_code, 400)
        self.assertFalse(Share.objects.filter(name='conciergerie-bien-42').exists())
        # Le compte de service du préfixe crée lui-même ses partages.
        service = make_token('service-account-conc-admin', azp='conc-admin',
                             groups=(), email=False)
        self.assertEqual(self.creer('conciergerie-bien-42', service).status_code, 201)
        # Un autre compte de service n'entre pas dans ce préfixe.
        autre = make_token('service-account-appli-admin', azp='appli-admin',
                           groups=(), email=False)
        self.assertEqual(self.creer('conciergerie-bien-43', autre).status_code, 400)

    def test_un_nom_libre_reste_libre(self):
        self.assertEqual(self.creer('vacances', make_token('alice')).status_code, 201)


class EcheanceObligatoireTests(_Base):

    def test_jeton_sans_exp_refuse(self):
        token = jwt.encode({'preferred_username': 'alice', 'azp': 'storage',
                            'groups': ['famille'], 'email': 'alice@example.org',
                            'iat': int(time.time()) - 5}, _KEY, algorithm='RS256')
        self.assertIn(self.client.get('/api/me/', **bearer(token)).status_code, (401, 403))
