from dataclasses import dataclass

from rest_framework.exceptions import NotFound, PermissionDenied

from .models import Share, ShareMember


@dataclass
class NamespaceAccess:
    namespace: str
    can_write: bool
    share: Share | None  # None pour un espace personnel


def resolve_namespace(namespace: str, user) -> NamespaceAccess:
    """Résout les droits de `user` sur `namespace`.

    Deux cas : namespace personnel (== son propre username → lecture/écriture),
    ou partage nommé `namespace` (propriétaire → lecture/écriture, membre →
    lecture seule, ni l'un ni l'autre → 403). Un namespace qui n'est ni l'un ni
    l'autre → 404.
    """
    if namespace == user.username:
        return NamespaceAccess(namespace=namespace, can_write=True, share=None)

    try:
        share = Share.objects.get(name=namespace)
    except Share.DoesNotExist:
        raise NotFound(f"Espace '{namespace}' introuvable.")

    if share.owner_username == user.username:
        return NamespaceAccess(namespace=namespace, can_write=True, share=share)

    if ShareMember.objects.filter(share=share, member_email=user.email).exists():
        return NamespaceAccess(namespace=namespace, can_write=False, share=share)

    raise PermissionDenied(f"Accès refusé à l'espace '{namespace}'.")


def require_write(access: NamespaceAccess) -> None:
    if not access.can_write:
        raise PermissionDenied("Lecture seule : vous n'êtes pas propriétaire de cet espace.")


def get_owned_share(user, name: str) -> Share:
    """Résout un partage pour les opérations réservées au propriétaire
    (gestion des membres, suppression) — distinct de resolve_namespace qui,
    lui, autorise aussi les membres en lecture seule."""
    try:
        share = Share.objects.get(name=name)
    except Share.DoesNotExist:
        raise NotFound(f"Partage '{name}' introuvable.")
    if share.owner_username != user.username:
        raise PermissionDenied("Seul le propriétaire du partage peut faire ceci.")
    return share
