"""GET/DELETE /api/files/<espace>/content/<chemin> — en-têtes rendus et
contrôles d'accès de la vue.

Les jetons sont de vrais JWT RS256 signés par une clé générée ici ; seul le
client JWKS (appel réseau vers Keycloak) est remplacé. Tout le reste de
KeycloakJWTAuthentication s'exécute réellement : signature, expiration, azp,
groupes, courriel, compte de service, repli ?token=.
"""
import shutil
import tempfile
import time
from types import SimpleNamespace
from unittest import mock

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from django.core.files.base import ContentFile
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from api.authentication import KeycloakJWTAuthentication
from api.content_safety import CSP_ATTACHMENT, CSP_INLINE
from api.models import Share, ShareMember, StoredFile

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)

HTML = b'<!doctype html><script>document.title="EXEC"</script><h1>x</h1>'
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 16
PDF = b'%PDF-1.4\n%%EOF\n'


def make_token(username='alice', *, azp='storage', groups=('famille',), email=True,
               exp_in=300, key=_KEY, **extra):
    claims = {'preferred_username': username, 'azp': azp, 'groups': list(groups),
              'exp': int(time.time()) + exp_in, **extra}
    if email:
        claims['email'] = f'{username}@example.org'
    return jwt.encode(claims, key, algorithm='RS256')


class _Base(TestCase):
    def setUp(self):
        self._media = tempfile.mkdtemp(prefix='storage-test-')
        override = override_settings(MEDIA_ROOT=self._media)
        override.enable()
        self.addCleanup(override.disable)
        self.addCleanup(shutil.rmtree, self._media, ignore_errors=True)
        jwks = SimpleNamespace(
            get_signing_key_from_jwt=lambda token: SimpleNamespace(key=_KEY.public_key()),
        )
        patcher = mock.patch.object(KeycloakJWTAuthentication, '_get_jwks_client', return_value=jwks)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = APIClient()

    def put(self, namespace, path, data, content_type, share=None):
        return StoredFile.objects.create(
            namespace=namespace, share=share, relative_path=path,
            content=ContentFile(data, name='blob'), size=len(data),
            content_type=content_type, uploaded_by_email='alice@example.org',
        )

    def get(self, namespace, path, token=None, query_token=None, **kw):
        headers = {'HTTP_AUTHORIZATION': f'Bearer {token}'} if token else {}
        url = f'/api/files/{namespace}/content/{path}'
        if query_token is not None:
            url += f'?token={query_token}'
        return self.client.get(url, **headers, **kw)

    @staticmethod
    def body(response):
        return b''.join(response.streaming_content)


class ContentHeadersTests(_Base):
    """Ce que le navigateur reçoit, par famille de type."""

    def serve(self, name, data, declared):
        self.put('alice', name, data, declared)
        response = self.get('alice', name, make_token())
        self.assertEqual(response.status_code, 200)
        return response

    def assert_attachment_octet_stream(self, response):
        self.assertEqual(response['Content-Type'], 'application/octet-stream')
        self.assertTrue(response['Content-Disposition'].startswith('attachment'))
        self.assertEqual(response['Content-Security-Policy'], CSP_ATTACHMENT)
        self.assertEqual(response['X-Content-Type-Options'], 'nosniff')

    def assert_inline(self, response, content_type, csp=CSP_INLINE):
        self.assertEqual(response['Content-Type'], content_type)
        self.assertTrue(response['Content-Disposition'].startswith('inline'))
        self.assertEqual(response['X-Content-Type-Options'], 'nosniff')
        if csp is None:
            self.assertNotIn('Content-Security-Policy', response)
        else:
            self.assertEqual(response['Content-Security-Policy'], csp)

    def test_html(self):
        r = self.serve('page.html', HTML, 'text/html')
        self.assert_attachment_octet_stream(r)
        self.assertEqual(self.body(r), HTML)  # les octets, eux, sont intacts

    def test_xhtml(self):
        self.assert_attachment_octet_stream(self.serve('p.xhtml', HTML, 'application/xhtml+xml'))

    def test_svg(self):
        self.assert_attachment_octet_stream(self.serve('i.svg', SVG, 'image/svg+xml'))

    def test_xml(self):
        for i, declared in enumerate(('text/xml', 'application/xml', 'application/rss+xml')):
            with self.subTest(declared):
                self.assert_attachment_octet_stream(self.serve(f'd{i}.xml', b'<a/>', declared))

    def test_javascript(self):
        for i, declared in enumerate(('text/javascript', 'application/javascript')):
            with self.subTest(declared):
                self.assert_attachment_octet_stream(self.serve(f's{i}.js', b'alert(1)', declared))

    def test_pdf(self):
        self.assert_inline(self.serve('f.pdf', PDF, 'application/pdf'), 'application/pdf', csp=None)

    def test_png(self):
        r = self.serve('i.png', PNG, 'image/png')
        self.assert_inline(r, 'image/png')
        self.assertEqual(self.body(r), PNG)

    def test_texte(self):
        self.assert_inline(self.serve('n.txt', b'<script>x</script>', 'text/plain'),
                           'text/plain; charset=utf-8')

    def test_type_inconnu_ou_absent(self):
        for i, declared in enumerate(('', 'application/x-inconnu', 'nimporte')):
            with self.subTest(declared):
                self.assert_attachment_octet_stream(self.serve(f'u{i}.bin', b'\x00\x01', declared))

    def test_type_menteur_html_declare_image(self):
        # Servi image/png + nosniff : le navigateur n'y lira jamais du HTML.
        r = self.serve('faux.png', HTML, 'image/png')
        self.assert_inline(r, 'image/png')

    def test_nom_png_contenu_et_type_html(self):
        # L'extension ne rachète rien : seul le type déclaré compte, et il
        # n'est pas dans la liste inline.
        self.assert_attachment_octet_stream(self.serve('x.png', HTML, 'text/html'))

    def test_nom_html_type_declare_texte(self):
        self.assert_inline(self.serve('y.html', HTML, 'text/plain'), 'text/plain; charset=utf-8')

    def test_majuscules_et_parametres(self):
        self.assert_attachment_octet_stream(self.serve('a.html', HTML, 'TEXT/HTML; Charset=UTF-8'))
        self.assert_attachment_octet_stream(self.serve('b.svg', SVG, ' Image/SVG+XML ;x=1'))
        self.assert_inline(self.serve('c.png', PNG, 'IMAGE/PNG; name="c.png"'), 'image/png')

    def test_formats_inertes_gardent_leur_type_en_piece_jointe(self):
        for name, declared in (('m.glb', 'model/gltf-binary'), ('p.step', 'model/step'),
                               ('d.json', 'application/json')):
            with self.subTest(declared):
                r = self.serve(name, b'{}', declared)
                self.assertEqual(r['Content-Type'], declared)
                self.assertTrue(r['Content-Disposition'].startswith('attachment'))
                self.assertEqual(r['Content-Security-Policy'], CSP_ATTACHMENT)
                self.assertEqual(r['X-Content-Type-Options'], 'nosniff')

    def test_nom_de_fichier_non_ascii_et_guillemets(self):
        r = self.serve('été "ü".txt', b'x', 'text/plain')
        self.assertIn("filename*=utf-8''", r['Content-Disposition'])
        r = self.serve('a"b.txt', b'x', 'text/plain')
        self.assertEqual(r['Content-Disposition'], 'inline; filename="a\\"b.txt"')

    def test_nom_de_fichier_ascii_inchange(self):
        # Forme historique, que les clients existants reçoivent déjà.
        r = self.serve('photo.png', PNG, 'image/png')
        self.assertEqual(r['Content-Disposition'], 'inline; filename="photo.png"')

    def test_meme_politique_par_le_repli_token(self):
        self.put('alice', 'p.html', HTML, 'text/html')
        r = self.get('alice', 'p.html', query_token=make_token())
        self.assertEqual(r.status_code, 200)
        self.assert_attachment_octet_stream(r)

    def test_erreur_404_reste_du_json(self):
        r = self.get('alice', 'absent.html', make_token())
        self.assertEqual(r.status_code, 404)
        self.assertTrue(r['Content-Type'].startswith('application/json'))


class ContentAccessTests(_Base):
    """Contrôles d'accès de la vue — inchangés par ce lot, figés ici."""

    def setUp(self):
        super().setUp()
        self.put('alice', 'a.png', PNG, 'image/png')
        self.share = Share.objects.create(name='photos', owner_username='alice')
        self.put('photos', 's.png', PNG, 'image/png', share=self.share)

    def test_sans_jeton(self):
        self.assertIn(self.get('alice', 'a.png').status_code, (401, 403))

    def test_jeton_vide_en_parametre(self):
        self.assertIn(self.get('alice', 'a.png', query_token='').status_code, (401, 403))

    def test_jeton_invalide(self):
        self.assertIn(self.get('alice', 'a.png', 'pas-un-jwt').status_code, (401, 403))
        self.assertIn(self.get('alice', 'a.png', query_token='pas-un-jwt').status_code, (401, 403))

    def test_signature_d_une_autre_cle(self):
        self.assertIn(self.get('alice', 'a.png', make_token(key=_OTHER_KEY)).status_code, (401, 403))

    def test_jeton_expire(self):
        self.assertIn(self.get('alice', 'a.png', make_token(exp_in=-60)).status_code, (401, 403))
        self.assertIn(self.get('alice', 'a.png', query_token=make_token(exp_in=-60)).status_code, (401, 403))

    def test_client_non_autorise_admin_cli(self):
        self.assertIn(self.get('alice', 'a.png', make_token(azp='admin-cli')).status_code, (401, 403))
        self.assertIn(self.get('alice', 'a.png', query_token=make_token(azp='admin-cli')).status_code, (401, 403))

    def test_hors_groupes_requis(self):
        self.assertIn(self.get('alice', 'a.png', make_token(groups=())).status_code, (401, 403))
        self.assertIn(self.get('alice', 'a.png', make_token(groups=('inconnu',))).status_code, (401, 403))

    def test_sans_courriel(self):
        self.assertIn(self.get('alice', 'a.png', make_token(email=False)).status_code, (401, 403))

    def test_proprietaire_lit_son_espace(self):
        self.assertEqual(self.get('alice', 'a.png', make_token('alice')).status_code, 200)

    def test_client_tiers_de_confiance(self):
        self.assertEqual(self.get('alice', 'a.png', make_token('alice', azp='autre-app')).status_code, 200)

    def test_espace_personnel_d_un_autre(self):
        # L'espace personnel d'autrui n'est pas un partage : introuvable.
        self.assertEqual(self.get('alice', 'a.png', make_token('bob')).status_code, 404)
        self.assertEqual(self.get('alice', 'a.png', query_token=make_token('bob')).status_code, 404)

    def test_partage_non_membre(self):
        self.assertEqual(self.get('photos', 's.png', make_token('bob')).status_code, 403)

    def test_partage_membre_lecture(self):
        ShareMember.objects.create(share=self.share, member_email='bob@example.org', role='read')
        token = make_token('bob')
        self.assertEqual(self.get('photos', 's.png', token).status_code, 200)
        r = self.client.delete('/api/files/photos/content/s.png', HTTP_AUTHORIZATION=f'Bearer {token}')
        self.assertEqual(r.status_code, 403)
        self.assertTrue(StoredFile.objects.filter(namespace='photos', relative_path='s.png').exists())

    def test_partage_membre_ecriture_supprime(self):
        ShareMember.objects.create(share=self.share, member_email='bob@example.org', role='write')
        r = self.client.delete('/api/files/photos/content/s.png',
                               HTTP_AUTHORIZATION=f'Bearer {make_token("bob")}')
        self.assertEqual(r.status_code, 204)
        self.assertFalse(StoredFile.objects.filter(namespace='photos', relative_path='s.png').exists())

    def test_partage_par_groupe(self):
        self.share.required_groups = 'developers'
        self.share.save()
        self.assertEqual(self.get('photos', 's.png', make_token('bob', groups=('developers',))).status_code, 200)
        self.assertEqual(self.get('photos', 's.png', make_token('bob', groups=('famille',))).status_code, 403)

    def test_ancetre_dans_la_hierarchie_ne_donne_aucun_droit(self):
        enfant = Share.objects.create(name='photos-ete', owner_username='alice', parent=self.share)
        ShareMember.objects.create(share=enfant, member_email='bob@example.org', role='read')
        self.assertEqual(self.get('photos', 's.png', make_token('bob')).status_code, 403)

    def test_compte_de_service_limite_a_son_partage(self):
        appli = Share.objects.create(name='appli', owner_username='alice')
        self.put('appli', 'x.png', PNG, 'image/png', share=appli)
        token = make_token('service-account-appli-admin', azp='appli-admin', groups=(), email=False)
        self.assertEqual(self.get('appli', 'x.png', token).status_code, 200)
        self.assertEqual(self.get('photos', 's.png', token).status_code, 403)
        self.assertEqual(self.get('alice', 'a.png', token).status_code, 403)

    def test_fichier_absent(self):
        self.assertEqual(self.get('alice', 'absent.png', make_token()).status_code, 404)

    def test_suppression_par_le_proprietaire(self):
        r = self.client.delete('/api/files/alice/content/a.png',
                               HTTP_AUTHORIZATION=f'Bearer {make_token()}')
        self.assertEqual(r.status_code, 204)
        self.assertEqual(self.get('alice', 'a.png', make_token()).status_code, 404)

    def test_methodes_non_prevues(self):
        for method in ('post', 'put', 'patch'):
            with self.subTest(method):
                r = getattr(self.client, method)('/api/files/alice/content/a.png',
                                                 HTTP_AUTHORIZATION=f'Bearer {make_token()}')
                self.assertEqual(r.status_code, 405)
