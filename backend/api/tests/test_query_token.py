"""Repli `?token=` limité à la lecture de contenu (interface I1, chantier « urgences »).

Le jeton en paramètre d'URL n'est lu que pour GET/HEAD sur
/api/files/<espace>/content/<chemin>. Partout ailleurs il est ignoré : la
requête est traitée comme s'il n'existait pas. L'en-tête Bearer reste accepté
partout. Même patron de jetons que test_file_content_view (RS256 signé par une
clé locale, seul le client JWKS est remplacé).
"""
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings

from api.models import Share, StoredFile

from .test_file_content_view import PNG, _Base, make_token

REFUS = (401, 403)


class QueryTokenTests(_Base):
    def setUp(self):
        super().setUp()
        self.put('alice', 'a.png', PNG, 'image/png')
        self.token = make_token('alice')
        self.bearer = {'HTTP_AUTHORIZATION': f'Bearer {self.token}'}

    def q(self, url, token=None):
        return f'{url}?token={token or self.token}'

    # ── Hors route de contenu : le paramètre est ignoré ──────────────────────

    def test_post_files_avec_token_en_parametre_refuse(self):
        r = self.client.post(self.q('/api/files/alice/'), {
            'file': SimpleUploadedFile('b.png', PNG, content_type='image/png'),
            'relative_path': 'b.png',
        }, format='multipart')
        self.assertIn(r.status_code, REFUS)
        self.assertFalse(StoredFile.objects.filter(namespace='alice', relative_path='b.png').exists())

    def test_delete_files_avec_token_en_parametre_refuse(self):
        self.assertIn(self.client.delete(self.q('/api/files/alice/')).status_code, REFUS)

    def test_get_files_liste_avec_token_en_parametre_refuse(self):
        self.assertIn(self.client.get(self.q('/api/files/alice/')).status_code, REFUS)

    def test_get_shares_avec_token_en_parametre_refuse(self):
        self.assertIn(self.client.get(self.q('/api/shares/')).status_code, REFUS)

    def test_post_shares_avec_token_en_parametre_refuse(self):
        r = self.client.post(self.q('/api/shares/'), {'name': 'vacances'}, format='json')
        self.assertIn(r.status_code, REFUS)
        self.assertFalse(Share.objects.filter(name='vacances').exists())

    def test_me_avec_token_en_parametre_refuse(self):
        self.assertIn(self.client.get(self.q('/api/me/')).status_code, REFUS)

    def test_delete_contenu_avec_token_en_parametre_refuse(self):
        # Même route que la lecture, mais pas une lecture : ignoré.
        r = self.client.delete(self.q('/api/files/alice/content/a.png'))
        self.assertIn(r.status_code, REFUS)
        self.assertTrue(StoredFile.objects.filter(namespace='alice', relative_path='a.png').exists())

    # ── Route de contenu, lecture : accepté ──────────────────────────────────

    def test_get_contenu_avec_token_en_parametre_accepte(self):
        r = self.client.get(self.q('/api/files/alice/content/a.png'))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.body(r), PNG)

    def test_head_contenu_avec_token_en_parametre_accepte(self):
        r = self.client.head(self.q('/api/files/alice/content/a.png'))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r['Content-Type'], 'image/png')

    def test_head_contenu_sans_jeton_refuse(self):
        self.assertIn(self.client.head('/api/files/alice/content/a.png').status_code, REFUS)

    def test_contenu_token_en_parametre_mauvais_azp_refuse(self):
        for azp in ('admin-cli', 'inconnu'):
            with self.subTest(azp):
                url = self.q('/api/files/alice/content/a.png', make_token('alice', azp=azp))
                self.assertIn(self.client.get(url).status_code, REFUS)
                self.assertIn(self.client.head(url).status_code, REFUS)

    def test_contenu_token_en_parametre_hors_groupes_refuse(self):
        url = self.q('/api/files/alice/content/a.png', make_token('alice', groups=('inconnu',)))
        self.assertIn(self.client.get(url).status_code, REFUS)

    @override_settings(FORCE_SCRIPT_NAME='/storage-api')
    def test_contenu_sous_prefixe_script_name(self):
        # Le chemin résolu est path_info (préfixe retiré) : la règle tient.
        self.assertEqual(self.client.get(self.q('/api/files/alice/content/a.png')).status_code, 200)
        self.assertIn(self.client.get(self.q('/api/shares/')).status_code, REFUS)

    # ── En-tête Bearer : accepté partout, inchangé ───────────────────────────

    def test_bearer_accepte_partout(self):
        cas = [
            ('get', '/api/me/', None, 200),
            ('get', '/api/shares/', None, 200),
            ('get', '/api/files/alice/', None, 200),
            ('get', '/api/files/alice/content/a.png', None, 200),
            ('head', '/api/files/alice/content/a.png', None, 200),
            ('post', '/api/files/alice/', 'upload', 201),
            ('post', '/api/shares/', 'share', 201),
            ('delete', '/api/files/alice/content/a.png', None, 204),
        ]
        for method, url, data, attendu in cas:
            with self.subTest(f'{method} {url}'):
                kw = {}
                if data == 'upload':
                    kw = {'data': {'file': SimpleUploadedFile('b.png', PNG, content_type='image/png'),
                                   'relative_path': 'b.png'}, 'format': 'multipart'}
                elif data == 'share':
                    kw = {'data': {'name': 'vacances'}, 'format': 'json'}
                r = getattr(self.client, method)(url, **kw, **self.bearer)
                self.assertEqual(r.status_code, attendu, getattr(r, 'data', None))

    def test_bearer_prime_et_parametre_ignore_hors_contenu(self):
        # Un ?token= quelconque à côté d'un en-tête valide ne change rien.
        r = self.client.get('/api/shares/?token=pas-un-jwt', **self.bearer)
        self.assertEqual(r.status_code, 200)

    def test_bearer_mauvais_azp_refuse_partout(self):
        h = {'HTTP_AUTHORIZATION': f'Bearer {make_token("alice", azp="admin-cli")}'}
        for url in ('/api/me/', '/api/shares/', '/api/files/alice/content/a.png'):
            with self.subTest(url):
                self.assertIn(self.client.get(url, **h).status_code, REFUS)
