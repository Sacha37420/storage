from dataclasses import dataclass

from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError as DRFValidationError

from .models import Share, ShareMember

# Garde-fou défensif contre une remontée de chaîne parent trop longue (cycle
# corrompu en base, jamais censé se produire puisque validate_new_parent
# l'interdit à l'écriture — mais une ligne éditée à la main via un shell
# Django contournerait cette validation). Sans lien avec une limite d'usage :
# la hiérarchie du lab restera très plate en pratique (quelques niveaux par
# app, cf. sharing-model-orchestration.md).
MAX_SHARE_HIERARCHY_DEPTH = 32


@dataclass
class NamespaceAccess:
    namespace: str
    can_write: bool
    share: Share | None  # None pour un espace personnel


def resolve_namespace(namespace: str, user) -> NamespaceAccess:
    """Résout les droits de `user` sur `namespace`.

    Compte de service (cf. KeycloakServiceUser) : lecture/écriture sur le
    partage précis configuré pour lui (write_share, doit déjà exister — cf.
    create_group_share) et/ou sur tout partage dont le nom commence par son
    write_prefix (créé automatiquement au premier usage : l'autorisation fine
    est déjà décidée par l'app appelante, storage ne fait que lui faire
    confiance sur ce préfixe) — court-circuite tout le reste, aucune notion de
    namespace personnel pour une identité machine.

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
        if user.write_prefix and namespace.startswith(user.write_prefix):
            share, _ = Share.objects.get_or_create(
                name=namespace, defaults={'owner_username': user.username},
            )
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


def validate_new_parent(share: Share, parent_name: str | None, *, enforce_same_owner: bool) -> Share | None:
    """Valide un changement de `Share.parent`. Retourne l'objet Share parent
    validé (ou None pour détacher `share` à la racine). Lève une
    ValidationError DRF sinon — jamais d'accès direct octroyé ou retiré par
    cette fonction, elle ne touche qu'à l'organisation (voir Share.parent).

    - Le parent doit exister.
    - Ni auto-référence, ni cycle (remontée bornée à MAX_SHARE_HIERARCHY_DEPTH,
      garde-fou défensif — voir la constante).
    - `enforce_same_owner=True` (chemin self-service, cf.
      ShareDetailView.patch) : le parent doit appartenir au même
      owner_username que l'enfant — voir Share.parent pour la justification.
      `manage.py set_share_parent` appelle avec enforce_same_owner=False
      (mêmes garanties anti-cycle, mais pas cette contrainte).
    """
    if not parent_name:
        return None

    try:
        parent = Share.objects.get(name=parent_name)
    except Share.DoesNotExist:
        raise DRFValidationError({'parent': [f"Partage parent '{parent_name}' introuvable."]})

    if parent.name == share.name:
        raise DRFValidationError({'parent': ["Un partage ne peut pas être son propre parent."]})

    if enforce_same_owner and parent.owner_username != share.owner_username:
        raise DRFValidationError({'parent': [
            "Le partage parent doit appartenir au même propriétaire."
        ]})

    cur = parent
    depth = 0
    while cur is not None:
        if cur.name == share.name:
            raise DRFValidationError({'parent': ["Rattachement refusé : créerait un cycle."]})
        if depth >= MAX_SHARE_HIERARCHY_DEPTH:
            raise DRFValidationError({'parent': ["Hiérarchie trop profonde pour être validée."]})
        cur = cur.parent
        depth += 1

    return parent
