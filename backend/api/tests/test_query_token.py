"""`?token=` refusé partout, Bearer accepté partout (chantier « failles », I4).

Le repli « jeton en paramètre d'URL », autrefois admis pour GET/HEAD sur
/api/files/<espace>/content/<chemin>, est retiré : un jeton dans une URL fuit
par l'historique, les journaux d'un proxy et l'en-tête Referer. Seul l'en-tête
`Authorization: Bearer` authentifie, sur toutes les routes ; un paramètre
`token` est ignoré (requête traitée comme anonyme), même valide, même à côté
d'un en-tête valide. Même patron de jetons que test_file_content_view (RS256
signé par une clé locale, seul le client JWKS est remplacé).
"""
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings

from api.models import Share, StoredFile

from .test_file_content_view import PNG, _Base, make_token

REFUS = (401, 403)
CONTENU = '/api/files/alice/content/a.png'


class QueryTokenTests(_Base):
    def setUp(self):
        super().setUp()
        self.put('alice', 'a.png', PNG, 'image/png')
        self.token = make_token('alice')
        self.bearer = {'HTTP_AUTHORIZATION': f'Bearer {self.token}'}

    def q(self, url, token=None):
        return f'{url}?token={token or self.token}'

    # ── Route de contenu : un jeton valide en paramètre est refusé ───────────

    def test_get_contenu_avec_token_en_parametre_refuse(self):
        r = self.client.get(self.q(CONTENU))
        self.assertIn(r.status_code, REFUS)
        self.assertNotIn(PNG, r.content)

    def test_head_contenu_avec_token_en_parametre_refuse(self):
        r = self.client.head(self.q(CONTENU))
        self.assertIn(r.status_code, REFUS)
        self.assertNotEqual(r.get('Content-Type'), 'image/png')

    def test_contenu_token_en_parametre_refuse_quel_que_soit_le_jeton(self):
        # Ni un client tiers de confiance, ni un compte de service, ni le
        # client storage lui-même : l'emplacement du jeton suffit à refuser.
        for nom, jeton in (
            ('storage', make_token('alice')),
            ('tiers de confiance', make_token('alice', azp='autre-app')),
            ('admin-cli', make_token('alice', azp='admin-cli')),
            ('hors groupes', make_token('alice', groups=('inconnu',))),
        ):
            with self.subTest(nom):
                url = self.q(CONTENU, jeton)
                self.assertIn(self.client.get(url).status_code, REFUS)
                self.assertIn(self.client.head(url).status_code, REFUS)

    @override_settings(FORCE_SCRIPT_NAME='/storage-api')
    def test_contenu_sous_prefixe_script_name_refuse(self):
        self.assertIn(self.client.get(self.q(CONTENU)).status_code, REFUS)
        self.assertIn(self.client.head(self.q(CONTENU)).status_code, REFUS)
        self.assertEqual(self.client.get(CONTENU, **self.bearer).status_code, 200)

    def test_head_contenu_sans_jeton_refuse(self):
        self.assertIn(self.client.head(CONTENU).status_code, REFUS)

    # ── Autres routes : un jeton valide en paramètre est refusé ──────────────

    def test_post_files_avec_token_en_parametre_refuse(self):
        r = self.client.post(self.q('/api/files/alice/'), {
            'file': SimpleUploadedFile('b.png', PNG, content_type='image/png'),
            'relative_path': 'b.png',
        }, format='multipart')
        self.assertIn(r.status_code, REFUS)
        self.assertFalse(StoredFile.objects.filter(namespace='alice', relative_path='b.png').exists())

    def test_delete_files_avec_token_en_parametre_refuse(self):
        self.assertIn(self.client.delete(self.q('/api/files/alice/')).status_code, REFUS)
        self.assertTrue(StoredFile.objects.filter(namespace='alice', relative_path='a.png').exists())

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
        r = self.client.delete(self.q(CONTENU))
        self.assertIn(r.status_code, REFUS)
        self.assertTrue(StoredFile.objects.filter(namespace='alice', relative_path='a.png').exists())

    # ── En-tête Bearer : accepté partout ─────────────────────────────────────

    def test_bearer_accepte_partout(self):
        cas = [
            ('get', '/api/me/', None, 200),
            ('get', '/api/shares/', None, 200),
            ('get', '/api/files/alice/', None, 200),
            ('get', CONTENU, None, 200),
            ('head', CONTENU, None, 200),
            ('post', '/api/files/alice/', 'upload', 201),
            ('post', '/api/shares/', 'share', 201),
            ('delete', CONTENU, None, 204),
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

    def test_bearer_contenu_rend_les_octets(self):
        r = self.client.get(CONTENU, **self.bearer)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.body(r), PNG)
        h = self.client.head(CONTENU, **self.bearer)
        self.assertEqual(h.status_code, 200)
        self.assertEqual(h['Content-Type'], 'image/png')

    # ── Un ?token= à côté d'un Bearer valide ne change rien ──────────────────

    def test_bearer_valide_et_parametre_quelconque(self):
        for parametre in ('pas-un-jwt', make_token('bob'), make_token('alice', azp='admin-cli')):
            with self.subTest(parametre[:12]):
                for method, url in (('get', '/api/shares/'), ('get', '/api/me/'),
                                    ('get', CONTENU), ('head', CONTENU)):
                    r = getattr(self.client, method)(f'{url}?token={parametre}', **self.bearer)
                    self.assertEqual(r.status_code, 200, f'{method} {url}')
                me = self.client.get(f'/api/me/?token={parametre}', **self.bearer)
                self.assertEqual(me.data['email'], 'alice@example.org')

    def test_parametre_valide_ne_rattrape_pas_un_bearer_refuse(self):
        h = {'HTTP_AUTHORIZATION': f'Bearer {make_token("alice", azp="admin-cli")}'}
        for method, url in (('get', '/api/me/'), ('get', CONTENU), ('head', CONTENU)):
            with self.subTest(f'{method} {url}'):
                r = getattr(self.client, method)(self.q(url), **h)
                self.assertIn(r.status_code, REFUS)

    def test_bearer_mauvais_azp_refuse_partout(self):
        h = {'HTTP_AUTHORIZATION': f'Bearer {make_token("alice", azp="admin-cli")}'}
        for url in ('/api/me/', '/api/shares/', CONTENU):
            with self.subTest(url):
                self.assertIn(self.client.get(url, **h).status_code, REFUS)
