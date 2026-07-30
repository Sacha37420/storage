"""Construction de l'arborescence de partages visible par un utilisateur —
sert exclusivement GET /api/shares/ (découverte / navigation), et ne change
RIEN à la résolution d'un accès direct : api.permissions.resolve_namespace
reste l'unique source de vérité sur « cet utilisateur a-t-il le droit de
lire/écrire CE namespace précis ? ». Ce module ne fait que décider ce qui est
listé pour qu'on puisse naviguer jusqu'à ce qui nous est réellement partagé —
lister un ancêtre ici ne donne strictement aucun droit dessus.

Décision de sécurité documentée (cf. .claude/plans/sharing-model-
orchestration.md, objectif 4 — scénario de référence : le propriétaire d'un
dossier personnel partage un sous-dossier profond à quelqu'un qui n'avait
initialement accès à rien de ce dossier) :

  Un partage-ancêtre auquel l'utilisateur n'a PAS d'accès direct est tout de
  même listé — son NOM et son PROPRIÉTAIRE sont visibles — dès lors qu'il est
  sur le chemin d'un partage auquel l'utilisateur a accès plus profondément.
  C'est un choix délibéré, pas un oubli : l'objectif explicite est de pouvoir
  remonter jusqu'à ce qui nous est réellement partagé (comme une arborescence
  de dossiers où l'on voit les dossiers parents sans avoir le droit d'y
  entrer). Le nom d'un partage n'est pas un secret dans ce lab (il apparaît
  déjà dans les URLs qu'un propriétaire distribue) ; le propriétaire l'est
  encore moins (déjà exposé par ShareSerializer à tout membre direct).

  En échange, AUCUN autre détail de cet ancêtre n'est exposé : pas de
  required_groups, pas de created_at, pas de liste de membres, pas
  d'enfants en dehors de la branche qui mène à l'accès réel de l'utilisateur
  (ses éventuels autres enfants/fichiers restent invisibles — c'est
  exactement le « pas les fichiers/dossiers/partages voisins auxquels il n'a
  pas droit » de l'objectif 4). Le contenu (fichiers) de cet ancêtre reste
  protégé par resolve_namespace exactement comme avant : le lister ici
  n'ouvre aucune route d'accès, ce n'est qu'une entrée de menu vers un
  dossier qu'on ne peut pas ouvrir.

Coût : une passe unique sur TOUTES les lignes de la table `shares`, en
mémoire (pas de récursion SQL). À l'échelle d'un lab avec quelques dizaines
de comptes et un partage par ressource métier, ça reste de l'ordre de
quelques centaines de lignes — largement dans le budget d'un endpoint appelé
à l'ouverture de la page, pas en boucle chaude. Si le lab grossissait au
point où ça devenait un problème, la bonne réponse serait de restreindre la
requête initiale (ex. filtrer par préfixe d'app) plutôt que d'introduire une
pagination qui casserait la construction de l'arbre.
"""
from .models import Share, ShareMember
from .permissions import MAX_SHARE_HIERARCHY_DEPTH


def _access_of(
    share: Share, *, username: str, groups: set[str], member_roles: dict[str, str],
) -> tuple[str | None, bool]:
    """Reproduit l'ordre de priorité de resolve_namespace (owner > groupe
    requis > ShareMember) pour décider POURQUOI (et avec quel droit
    d'écriture) `share` est directement accessible — sans jamais y toucher
    pour un compte de service (aucune notion de groupes/membre pour lui, cf.
    KeycloakServiceUser ; il n'atteint cette fonction que si un jour un
    compte de service appelle GET /api/shares/, ce qu'aucune app du lab ne
    fait aujourd'hui, cf. storage_client.py de chaque app migrée)."""
    if share.owner_username == username:
        return 'owner', True
    required = {g.strip() for g in share.required_groups.split(',') if g.strip()}
    if required and required & groups:
        return 'group', True
    role = member_roles.get(share.name)
    if role is not None:
        return 'member', role == 'write'
    return None, False


def build_share_forest(user) -> list[dict]:
    """Retourne la forêt (liste de racines, chacune avec ses `children`
    imbriqués) des partages visibles par `user` : ses partages directement
    accessibles (owner/groupe/membre), plus les ancêtres nécessaires pour y
    naviguer (accessible=False, détails minimaux — voir docstring du module).
    """
    all_shares = list(Share.objects.all())
    by_name = {s.name: s for s in all_shares}

    username = getattr(user, 'username', '') or ''
    email = getattr(user, 'email', '') or ''
    claims = getattr(user, 'claims', None) or {}
    groups = set(claims.get('groups') or [])

    member_roles: dict[str, str] = {}
    if email:
        member_roles = {
            m.share_id: m.role
            for m in ShareMember.objects.filter(member_email=email).only('share_id', 'role')
        }

    accessible: dict[str, tuple[str, bool]] = {}
    for s in all_shares:
        reason, can_write = _access_of(s, username=username, groups=groups, member_roles=member_roles)
        if reason:
            accessible[s.name] = (reason, can_write)

    # Ajoute les ancêtres (conteneurs purs) de chaque partage accessible.
    relevant = set(accessible)
    for name in list(accessible):
        cur = by_name.get(name)
        depth = 0
        while cur is not None and cur.parent_id and depth < MAX_SHARE_HIERARCHY_DEPTH:
            parent = by_name.get(cur.parent_id)
            if parent is None:
                break  # parent_id pointe hors de ce jeu de résultats (ne devrait pas arriver)
            relevant.add(parent.name)
            cur = parent
            depth += 1

    # Index enfants → uniquement parmi les partages "pertinents" (accessibles
    # ou ancêtres nécessaires) : un enfant non pertinent (ni accessible, ni
    # sur le chemin d'un accès) n'apparaît jamais, c'est ce qui garde les
    # voisins invisibles.
    children_by_parent: dict[str | None, list[Share]] = {}
    for name in relevant:
        s = by_name[name]
        children_by_parent.setdefault(s.parent_id, []).append(s)
    for lst in children_by_parent.values():
        lst.sort(key=lambda s: s.name)

    def serialize(s: Share) -> dict:
        is_accessible = s.name in accessible
        node = {
            'name': s.name,
            'owner_username': s.owner_username,
            'accessible': is_accessible,
            'children': [serialize(c) for c in children_by_parent.get(s.name, [])],
        }
        if is_accessible:
            reason, can_write = accessible[s.name]
            node.update({
                'access': reason,
                'can_write': can_write,
                'required_groups': s.required_groups,
                'created_at': s.created_at.isoformat(),
            })
        return node

    return [serialize(s) for s in children_by_parent.get(None, [])]
