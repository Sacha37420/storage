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

    Compte de service (cf. KeycloakServiceUser) : lecture/écriture uniquement
    sur le partage précis configuré pour lui (write_share) — court-circuite
    tout le reste, aucune notion de namespace personnel pour une identité
    machine.

    Compte humain, trois cas : namespace personnel (== son propre username →
    lecture/écriture) ; partage nommé `namespace` dont il est propriétaire
    (→ lecture/écriture) ou dont le groupe Keycloak requis (`required_groups`)
    croise ses groupes (→ lecture/écriture, même statut que le propriétaire) ;
    ou membre explicite (`ShareMember`, → lecture ou écriture selon son rôle).
    Ni l'un ni l'autre → 403. Un namespace qui ne correspond à rien → 404.
    """
    if getattr(user, 'is_service_account', False):
        if namespace == user.write_share:
            share = Share.objects.filter(name=namespace).first()
            return NamespaceAccess(namespace=namespace, can_write=True, share=share)
        raise PermissionDenied(f"Ce compte de service n'a pas accès à '{namespace}'.")

    if namespace == user.username:
        return NamespaceAccess(namespace=namespace, can_write=True, share=None)

    try:
        share = Share.objects.get(name=namespace)
    except Share.DoesNotExist:
        raise NotFound(f"Espace '{namespace}' introuvable.")

    if share.owner_username == user.username:
        return NamespaceAccess(namespace=namespace, can_write=True, share=share)

    required = {g.strip() for g in share.required_groups.split(',') if g.strip()}
    if required and required & set(user.claims.get('groups') or []):
        return NamespaceAccess(namespace=namespace, can_write=True, share=share)

    member = ShareMember.objects.filter(share=share, member_email=user.email).first()
    if member:
        return NamespaceAccess(namespace=namespace, can_write=(member.role == 'write'), share=share)

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
