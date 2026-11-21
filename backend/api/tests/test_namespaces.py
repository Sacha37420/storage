"""Noms d'espace : un compte ne lit jamais l'espace d'un autre en prenant son nom.

Les fichiers sont rangés par nom d'espace (`StoredFile.namespace`) : un partage
qui porte le nom d'un espace personnel, ou le nom promis à un compte de service,
donnait à son propriétaire tout ce qui y était déposé. Même patron de jetons
que test_file_content_view (RS256 signé par une clé locale, seul le client JWKS
est remplacé).
"""
import time

import jwt
from django.core.exceptions import ValidationError
from django.test import override_settings

from api.models import KnownUser, Share
from api.validators import validate_relative_path

from .test_file_content_view import _KEY, PNG, _Base, make_token

REFUS = (401, 403)


class EspacePersonnelPrisTests(_Base):
    def test_partage_cree_avant_la_premiere_connexion_ne_lit_pas_l_espace(self):
        bob = {'HTTP_AUTHORIZATION': f"Bearer {make_token('bob')}"}
        self.assertEqual(self.client.post('/api/shares/', {'name': 'carol'}, format='json', **bob).status_code, 201)
        # Fichier déposé « dans son espace » par carol (état d'avant correction).
        self.put('carol', 'secret.png', PNG, 'image/png')
        self.assertIn(self.get('carol', 'secret.png', make_token('carol')).status_code, REFUS)
        self.assertEqual(self.client.get('/api/files/carol/', HTTP_AUTHORIZATION=f"Bearer {make_token('carol')}").status_code, 403)

    def test_compte_nomme_comme_un_partage_n_y_entre_pas(self):
        Share.objects.create(name='photos', owner_username='alice')
        self.put('photos', 's.png', PNG, 'image/png')
        self.assertEqual(self.get('photos', 's.png', make_token('photos')).status_code, 403)
        self.assertEqual(self.get('photos', 's.png', make_token('alice')).status_code, 200)

    def test_espace_personnel_sans_partage_homonyme_reste_ouvert(self):
        self.put('alice', 'a.png', PNG, 'image/png')
        self.assertEqual(self.get('alice', 'a.png', make_token('alice')).status_code, 200)


@override_settings(
    KEYCLOAK_SERVICE_WRITE_PREFIXES={'conc-admin': 'conc-bien-'},
    KEYCLOAK_TRUSTED_CLIENTS={'storage', 'autre-app', 'appli-admin', 'conc-admin'},
)
class NomsReservesAuxServicesTests(_Base):
    def post_share(self, name, token):
        return self.client.post('/api/shares/', {'name': name}, format='json',
                                HTTP_AUTHORIZATION=f'Bearer {token}')

    def test_un_humain_ne_prend_pas_le_prefixe_d_un_service(self):
        self.assertEqual(self.post_share('conc-bien-1', make_token('bob')).status_code, 400)
        self.assertFalse(Share.objects.filter(name='conc-bien-1').exists())

    def test_un_humain_ne_prend_pas_le_partage_d_un_service(self):
        self.assertEqual(self.post_share('appli', make_token('bob')).status_code, 400)
        self.assertFalse(Share.objects.filter(name='appli').exists())

    def test_le_service_cree_encore_ses_propres_noms(self):
        jeton = make_token('service-account-conc-admin', azp='conc-admin', groups=(), email=False)
        self.assertEqual(self.post_share('conc-bien-2', jeton).status_code, 201)
        self.assertEqual(Share.objects.get(name='conc-bien-2').owner_username, 'service:conc-admin')

    def test_un_nom_ordinaire_reste_libre(self):
        self.assertEqual(self.post_share('vacances', make_token('bob')).status_code, 201)

    def test_prefixe_avec_un_nom_invalide_ne_cree_rien(self):
        jeton = make_token('service-account-conc-admin', azp='conc-admin', groups=(), email=False)
        for nom in ('conc-bien-' + 'x' * 70, 'conc-bien-ABC'):
            with self.subTest(nom):
                r = self.client.get(f'/api/files/{nom}/', HTTP_AUTHORIZATION=f'Bearer {jeton}')
                self.assertEqual(r.status_code, 403)
                self.assertFalse(Share.objects.filter(name=nom).exists())


class JetonEtCompteTests(_Base):
    def setUp(self):
        super().setUp()
        self.put('alice', 'a.png', PNG, 'image/png')

    def test_jeton_sans_exp_refuse(self):
        jeton = jwt.encode({'preferred_username': 'alice', 'azp': 'storage', 'groups': ['famille'],
                            'email': 'alice@example.org'}, _KEY, algorithm='RS256')
        self.assertIn(self.get('alice', 'a.png', jeton).status_code, REFUS)

    @override_settings(KEYCLOAK_TRUSTED_CLIENTS={'storage', 'admin-cli'})
    def test_admin_cli_refuse_meme_liste_dans_le_env(self):
        self.assertIn(self.get('alice', 'a.png', make_token(azp='admin-cli')).status_code, REFUS)

    def test_changement_d_email_ne_donne_pas_500(self):
        auth = {'HTTP_AUTHORIZATION': f"Bearer {make_token('dave')}"}
        self.assertEqual(self.client.get('/api/me/', **auth).status_code, 200)
        nouveau = jwt.encode({'preferred_username': 'dave', 'azp': 'storage', 'groups': ['famille'],
                              'email': 'dave@autre.example.org', 'exp': int(time.time()) + 300},
                             _KEY, algorithm='RS256')
        r = self.client.get('/api/me/', HTTP_AUTHORIZATION=f'Bearer {nouveau}')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(KnownUser.objects.get(username='dave').email, 'dave@autre.example.org')


class CheminTropLongTests(_Base):
    def test_chemin_trop_long_ou_avec_nul_refuse(self):
        for chemin in ('a' * 1025, 'a\x00b'):
            with self.subTest(len(chemin)):
                with self.assertRaises(ValidationError):
                    validate_relative_path(chemin)
        validate_relative_path('a' * 1024)
