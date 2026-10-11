"""En-têtes de service d'un fichier déposé — décide ce que le navigateur a le
droit d'en faire.

Pourquoi ce module existe (faille constatée le 2026-10-11) : la vue de contenu
renvoyait le `content_type` fourni par le déposant, en `inline`, sans
`nosniff` ni CSP. Avec le repli `?token=`, l'adresse d'un fichier s'ouvre par
simple navigation : un `.html` déposé s'exécutait sur l'origine du lab, que
toutes les apps partagent.

Règle : **le type déclaré par le déposant ne décide de rien par lui-même.** Il
n'est jamais recopié tel quel dans la réponse ; il sert seulement de clé dans
des listes blanches tenues ici. Tout ce qui n'est pas dans une liste sort en
`application/octet-stream`, en pièce jointe.

  1. `nosniff` sur TOUTE réponse : le navigateur s'en tient au type annoncé.
     C'est ce qui rend sûr le cas du « type menteur » — un HTML déclaré
     `image/png` est servi `image/png` et s'affiche comme une image cassée,
     jamais comme une page.
  2. Liste blanche INLINE (`_INLINE_TYPES`) : ce qu'un navigateur affiche sans
     jamais exécuter de script du document — images matricielles, audio,
     vidéo, PDF (lu par la visionneuse intégrée, hors de l'origine), texte
     brut. Le type émis est la forme canonique de la liste, pas la chaîne du
     déposant.
  3. Tout le reste : `Content-Disposition: attachment` + CSP `sandbox`. Le
     type n'est conservé que s'il est dans la liste blanche PASSANTE (formats
     inertes dont une app peut avoir besoin : glTF, STEP, zip, bureautique…).
     Sinon `application/octet-stream`. HTML, XHTML, SVG, tout XML, JavaScript,
     CSS et tout type inconnu tombent donc en octet-stream par construction,
     sans qu'il y ait de liste noire à tenir à jour.

Pourquoi réécrire le type et ne pas se contenter de `attachment` : plusieurs
apps du lab relaient les octets ET le `Content-Type` de storage (proxys de
conciergerie, restauration, atelier-3d), ou rouvrent le fichier depuis un
`Blob` dans un nouvel onglet (conciergerie : `URL.createObjectURL`). Un blob
`text/html` ou `image/svg+xml` s'exécute sur l'origine de la page qui l'a
créé, quels que soient les en-têtes d'ici. En octet-stream, il se télécharge.

Conséquence assumée : un SVG n'est plus affichable par `<img src>` directement
depuis storage (aucun n'est stocké à ce jour). Le rendre affichable
supposerait de l'assainir ou de le servir depuis une autre origine.

`sandbox` n'est pas posé sur le PDF : il empêche la visionneuse intégrée de
Chromium de se charger, et l'affichage des factures (conciergerie) en dépend.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from django.utils.http import content_disposition_header

OCTET_STREAM = 'application/octet-stream'

CSP_INLINE = 'sandbox'
CSP_ATTACHMENT = "sandbox; default-src 'none'"

# Variantes d'écriture courantes → forme canonique.
_ALIASES = {
    'image/jpg': 'image/jpeg',
    'image/pjpeg': 'image/jpeg',
    'image/x-png': 'image/png',
    'image/x-ms-bmp': 'image/bmp',
    'image/vnd.microsoft.icon': 'image/x-icon',
    'audio/mp3': 'audio/mpeg',
    'audio/x-mp3': 'audio/mpeg',
    'audio/x-wav': 'audio/wav',
    'audio/wave': 'audio/wav',
    'audio/x-flac': 'audio/flac',
    'audio/x-m4a': 'audio/mp4',
    'application/x-pdf': 'application/pdf',
}

# Liste blanche INLINE : formats rendus sans exécution de script du document.
# image/svg+xml n'y figurera jamais (un SVG est un document XML scriptable).
_INLINE_TYPES = frozenset({
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
    'image/bmp', 'image/x-icon',
    'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/opus',
    'audio/wav', 'audio/webm', 'audio/flac',
    'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
})
_PDF = 'application/pdf'
_TEXT = 'text/plain'

# Jeux de caractères acceptés pour le texte brut. Tout autre (UTF-7 en tête,
# historiquement utilisé pour faire relire du texte comme du balisage) est
# remplacé par utf-8.
_SAFE_CHARSETS = frozenset({'utf-8', 'us-ascii', 'iso-8859-1', 'iso-8859-15', 'windows-1252'})

# Liste blanche PASSANTE : types conservés tels quels, mais toujours en pièce
# jointe. Formats de données inertes — aucun n'est interprété comme document
# actif par un navigateur.
_PASSTHROUGH_EXACT = frozenset({
    OCTET_STREAM,
    'application/json', 'application/geo+json',
    'application/zip', 'application/gzip', 'application/x-tar',
    'application/x-7z-compressed', 'application/x-bzip2', 'application/vnd.rar',
    'application/msword', 'application/rtf', 'application/epub+zip',
    'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
    'text/csv', 'text/tab-separated-values', 'text/markdown',
    'text/calendar', 'text/vcard',
})
_PASSTHROUGH_PREFIXES = (
    'application/vnd.openxmlformats-officedocument.',
    'application/vnd.oasis.opendocument.',
)
# Familles entières conservées : aucun sous-type n'y est un document
# scriptable, à l'exception structurelle des dérivés XML (écartés plus bas).
_PASSTHROUGH_FAMILIES = frozenset({'image', 'audio', 'video', 'font', 'model'})

_ESSENCE_RE = re.compile(r'^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$')
_CHARSET_RE = re.compile(r'charset\s*=\s*"?([a-z0-9._-]+)"?', re.IGNORECASE)
_CONTROL_RE = re.compile(r'[\x00-\x1f\x7f]')


@dataclass(frozen=True)
class ServingPolicy:
    content_type: str
    inline: bool
    csp: str | None


def _essence(declared: str | None) -> str:
    """Type/sous-type en minuscules, sans paramètres ; '' si illisible."""
    essence = (declared or '').split(';', 1)[0].strip().lower()
    if not _ESSENCE_RE.match(essence):
        return ''
    return _ALIASES.get(essence, essence)


def _is_xml(essence: str) -> bool:
    """Tout type XML est un document potentiellement scriptable (un espace de
    noms XHTML suffit) : `*/xml`, `*+xml`, SVG compris."""
    subtype = essence.split('/', 1)[1]
    return subtype == 'xml' or subtype.endswith('+xml') or 'svg' in subtype


def _is_passthrough(essence: str) -> bool:
    if not essence or _is_xml(essence):
        return False
    if essence in _PASSTHROUGH_EXACT or essence.startswith(_PASSTHROUGH_PREFIXES):
        return True
    return essence.split('/', 1)[0] in _PASSTHROUGH_FAMILIES


def serving_policy(declared: str | None) -> ServingPolicy:
    """Politique de service pour un fichier dont le déposant a déclaré
    `declared` comme type. Fonction pure : aucune E/S, aucune exception."""
    essence = _essence(declared)

    if essence == _TEXT:
        match = _CHARSET_RE.search(declared or '')
        charset = match.group(1).lower() if match else 'utf-8'
        if charset not in _SAFE_CHARSETS:
            charset = 'utf-8'
        return ServingPolicy(f'{_TEXT}; charset={charset}', inline=True, csp=CSP_INLINE)
    if essence == _PDF:
        return ServingPolicy(_PDF, inline=True, csp=None)
    if essence in _INLINE_TYPES:
        return ServingPolicy(essence, inline=True, csp=CSP_INLINE)
    if _is_passthrough(essence):
        return ServingPolicy(essence, inline=False, csp=CSP_ATTACHMENT)
    return ServingPolicy(OCTET_STREAM, inline=False, csp=CSP_ATTACHMENT)


def safe_filename(name: str) -> str:
    """Nom de fichier présentable dans un en-tête : sans caractère de contrôle
    (un saut de ligne ferait lever BadHeaderError, donc un 500)."""
    return _CONTROL_RE.sub('_', name) or 'fichier'


def apply_serving_headers(response, declared: str | None, filename: str) -> ServingPolicy:
    """Pose sur `response` les en-têtes de la politique. Le `Content-Type` est
    réécrit ici aussi : la réponse ne porte jamais la chaîne du déposant."""
    policy = serving_policy(declared)
    response['Content-Type'] = policy.content_type
    response['X-Content-Type-Options'] = 'nosniff'
    response['Content-Disposition'] = content_disposition_header(
        not policy.inline, safe_filename(filename),
    )
    if policy.csp:
        response['Content-Security-Policy'] = policy.csp
    return policy
