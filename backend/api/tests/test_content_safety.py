"""Politique de service par type déclaré — fonction pure, sans base ni HTTP."""
from django.test import SimpleTestCase

from api.content_safety import (
    CSP_ATTACHMENT, CSP_INLINE, OCTET_STREAM, safe_filename, serving_policy,
)


class InlineWhitelistTests(SimpleTestCase):
    def test_images_matricielles(self):
        for declared in ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'):
            with self.subTest(declared):
                p = serving_policy(declared)
                self.assertEqual((p.content_type, p.inline, p.csp), (declared, True, CSP_INLINE))

    def test_audio_video(self):
        for declared in ('audio/mpeg', 'audio/ogg', 'audio/wav', 'video/mp4', 'video/webm'):
            with self.subTest(declared):
                p = serving_policy(declared)
                self.assertEqual((p.content_type, p.inline, p.csp), (declared, True, CSP_INLINE))

    def test_pdf_inline_sans_sandbox(self):
        # sandbox bloquerait la visionneuse PDF intégrée (factures conciergerie).
        p = serving_policy('application/pdf')
        self.assertEqual((p.content_type, p.inline, p.csp), ('application/pdf', True, None))

    def test_texte_brut_charset_force(self):
        self.assertEqual(serving_policy('text/plain').content_type, 'text/plain; charset=utf-8')
        self.assertEqual(serving_policy('text/plain; charset=ISO-8859-1').content_type,
                         'text/plain; charset=iso-8859-1')
        # UTF-7 : jeu de caractères historiquement utilisé pour faire relire
        # du texte comme du balisage — jamais renvoyé.
        self.assertEqual(serving_policy('text/plain; charset=utf-7').content_type,
                         'text/plain; charset=utf-8')
        self.assertTrue(serving_policy('text/plain').inline)

    def test_alias_ramenes_a_la_forme_canonique(self):
        self.assertEqual(serving_policy('image/jpg').content_type, 'image/jpeg')
        self.assertEqual(serving_policy('audio/mp3').content_type, 'audio/mpeg')

    def test_majuscules_espaces_et_parametres(self):
        p = serving_policy('  IMAGE/PNG ; foo=bar ')
        self.assertEqual((p.content_type, p.inline), ('image/png', True))
        p = serving_policy('Application/PDF; name="x.pdf"')
        self.assertEqual((p.content_type, p.inline), ('application/pdf', True))


class ActiveContentTests(SimpleTestCase):
    """Tout ce qu'un navigateur interpréterait comme document ou script sort
    en octet-stream, pièce jointe, bac à sable — quelle que soit l'écriture."""

    ACTIFS = (
        'text/html', 'TEXT/HTML', 'text/html; charset=utf-8', ' Text/Html ;x=y',
        'application/xhtml+xml',
        'image/svg+xml', 'IMAGE/SVG+XML', 'image/svg',
        'text/xml', 'application/xml', 'application/rss+xml', 'application/atom+xml',
        'application/mathml+xml', 'model/x3d+xml', 'text/xsl', 'application/xslt+xml',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
        'text/javascript', 'application/javascript', 'application/ecmascript',
        'application/x-javascript', 'text/jscript', 'text/css', 'text/vtt',
        'application/wasm', 'application/x-shockwave-flash', 'application/java-archive',
        'multipart/x-mixed-replace', 'message/rfc822', 'text/cache-manifest',
        'application/x-httpd-php', 'text/x-component', 'application/manifest+json',
    )

    def test_types_actifs(self):
        for declared in self.ACTIFS:
            with self.subTest(declared):
                p = serving_policy(declared)
                self.assertEqual((p.content_type, p.inline, p.csp),
                                 (OCTET_STREAM, False, CSP_ATTACHMENT))

    def test_type_inconnu_vide_ou_illisible(self):
        for declared in (None, '', 'n-importe-quoi', 'a/b/c', 'text/', '/html', 'application/x-inconnu',
                         'text/html\r\nX-Injecte: 1', 'image/png\x00', 'image/png, text/html',
                         '<script>', 'text/plain2'):
            with self.subTest(declared):
                p = serving_policy(declared)
                self.assertEqual((p.content_type, p.inline, p.csp),
                                 (OCTET_STREAM, False, CSP_ATTACHMENT))

    def test_jamais_la_chaine_du_deposant(self):
        # Le type émis vient toujours d'une liste : aucun paramètre, aucune
        # casse, aucun caractère du déposant ne se retrouve dans l'en-tête.
        for declared in self.ACTIFS + ('image/png; x="</script>"', 'video/mp4;codecs=avc1'):
            with self.subTest(declared):
                emitted = serving_policy(declared).content_type
                self.assertRegex(emitted, r'^[a-z0-9.+-]+/[a-z0-9.+-]+$')


class PassthroughTests(SimpleTestCase):
    """Formats inertes : type conservé (des apps le lisent), mais jamais inline."""

    def test_types_conserves_en_piece_jointe(self):
        for declared in ('model/gltf-binary', 'model/step', 'model/stl', 'application/json',
                         'application/zip', 'text/csv', 'image/tiff', 'application/octet-stream',
                         'font/woff2', 'application/vnd.oasis.opendocument.text',
                         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'):
            with self.subTest(declared):
                p = serving_policy(declared)
                self.assertEqual((p.content_type, p.inline, p.csp), (declared, False, CSP_ATTACHMENT))


class FilenameTests(SimpleTestCase):
    def test_caracteres_de_controle_retires(self):
        self.assertEqual(safe_filename('a\r\nX-Injecte: 1.txt'), 'a__X-Injecte: 1.txt')
        self.assertEqual(safe_filename(''), 'fichier')
