import uuid

from django.db import models

from .validators import validate_namespace_slug, validate_relative_path


class KnownUser(models.Model):
    """Compte Keycloak vu au moins une fois par cette API.

    Alimenté à chaque requête authentifiée (voir KeycloakJWTAuthentication),
    pas seulement sur /api/me/ : sert de garde-fou pour qu'un nom de partage
    ne colle jamais avec un username déjà connu, les deux partageant le même
    espace d'adressage <namespace>/<chemin>.
    """

    email = models.EmailField(primary_key=True, max_length=255)
    username = models.CharField(max_length=255, unique=True)
    first_seen = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'known_users'

    def __str__(self) -> str:
        return self.username


class Share(models.Model):
    """Partage nommé : espace de fichiers appartenant à un utilisateur, qui en
    contrôle l'accès pour d'autres comptes (par email, cf. ShareMember) et/ou
    pour tout un groupe Keycloak (cf. required_groups).

    Le nom sert de namespace dans l'adressage des fichiers (<namespace>/<chemin>)
    et est immuable — pas d'endpoint de renommage, ça romprait tout lien déjà
    distribué à un tiers.
    """

    name = models.CharField(
        max_length=64, primary_key=True, validators=[validate_namespace_slug],
    )
    owner_username = models.CharField(max_length=255, db_index=True)
    # CSV, même convention que settings.KEYCLOAK_REQUIRED_GROUPS. Vide (défaut) :
    # comportement inchangé, seuls owner_username + ShareMember donnent accès.
    # Non vide : tout compte dont le claim 'groups' du token croise un de ces
    # groupes a accès en lecture/écriture (même statut que le propriétaire),
    # sans ligne ShareMember à maintenir — la source de vérité reste Keycloak/
    # LDAP, pas une liste dupliquée ici. Hors self-service (pas exposé par
    # POST /api/shares/), provisionné via `manage.py create_group_share`.
    required_groups = models.CharField(max_length=255, blank=True, default='')
    # Hiérarchie de partages : PURE ORGANISATION, aucun héritage de droits.
    # api.permissions.resolve_namespace (la seule fonction qui décide d'un
    # accès direct) ignore totalement ce champ et continue de résoudre
    # exactement le partage demandé par son nom, comme avant — un enfant
    # n'hérite jamais des droits de son parent, ses propres required_groups/
    # ShareMember priment complètement. `parent` ne sert qu'à la découverte
    # (api/discovery.py) : remonter la chaîne de conteneurs jusqu'à un
    # partage profond auquel on a un accès direct, pour naviguer dans l'UI —
    # sans jamais exposer le contenu (fichiers, membres, sous-partages) d'un
    # ancêtre auquel on n'a pas soi-même un accès direct (voir docstring de
    # build_share_forest).
    #
    # Contrainte de même-propriétaire : imposée en dehors du modèle (dans les
    # vues, cf. ShareDetailView.patch et api.permissions.validate_new_parent)
    # plutôt qu'ici, parce qu'un CheckConstraint ne peut pas comparer deux
    # lignes différentes de la même table. En self-service, le parent DOIT
    # appartenir au même owner_username que l'enfant — sinon n'importe qui
    # pourrait accrocher son partage sous l'arbre d'un autre compte sans son
    # accord, ce qui laisserait croire à une affiliation qui n'existe pas. La
    # commande d'administration `manage.py set_share_parent` peut déroger à
    # cette règle (même niveau de confiance qu'un accès manage.py, à l'image
    # de `create_group_share` qui contourne déjà le self-service pour
    # required_groups) — c'est le mécanisme prévu pour rattacher a posteriori
    # les partages plats créés par les chantiers App (voir le commentaire de
    # tête de cette commande).
    #
    # on_delete=PROTECT (et non CASCADE ni SET_NULL) : supprimer un partage
    # qui a encore des enfants serait soit une perte de données en cascade
    # potentiellement chez un tiers (CASCADE), soit une restructuration
    # silencieuse de l'arbre que personne n'a demandée (SET_NULL, l'enfant
    # réapparaît à la racine). PROTECT force un choix explicite : détacher ou
    # supprimer les enfants d'abord (voir ShareDetailView.delete, qui vérifie
    # `share.children.exists()` en amont pour renvoyer une erreur claire
    # plutôt que de laisser remonter l'exception Django).
    parent = models.ForeignKey(
        'self', null=True, blank=True, on_delete=models.PROTECT, related_name='children',
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'shares'
        ordering = ['name']

    def __str__(self) -> str:
        return self.name


class ShareMember(models.Model):
    """Compte autorisé à accéder à un partage dont il n'est pas propriétaire —
    en lecture seule (role='read', défaut) ou aussi en écriture (role='write')."""

    ROLE_CHOICES = [('read', 'read'), ('write', 'write')]

    share = models.ForeignKey(Share, on_delete=models.CASCADE, related_name='members')
    member_email = models.EmailField()
    role = models.CharField(max_length=10, choices=ROLE_CHOICES, default='read')
    added_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'share_members'
        unique_together = [('share', 'member_email')]
        ordering = ['member_email']

    def __str__(self) -> str:
        return f'{self.member_email} @ {self.share_id}'


def _blob_upload_path(instance, filename):
    # Chemin physique opaque, jamais dérivé de relative_path (fourni par
    # l'utilisateur) : élimine tout risque de traversée de chemin ou de
    # collision de nom sur le filesystem. relative_path/namespace ne sont que
    # des clés logiques en base, jamais des chemins réels.
    return f'blobs/{uuid.uuid4()}'


class StoredFile(models.Model):
    """Un fichier, adressé logiquement par (namespace, relative_path).

    namespace = owner_username (fichier personnel, share=None) ou share.name
    (fichier de partage) — figé à la création, un fichier ne change jamais de
    namespace.
    """

    namespace = models.CharField(max_length=255, db_index=True)
    share = models.ForeignKey(
        Share, on_delete=models.CASCADE, null=True, blank=True, related_name='files',
    )
    relative_path = models.CharField(max_length=1024, validators=[validate_relative_path])
    content = models.FileField(upload_to=_blob_upload_path)
    size = models.BigIntegerField()
    content_type = models.CharField(max_length=255, blank=True)
    uploaded_by_email = models.EmailField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'stored_files'
        unique_together = [('namespace', 'relative_path')]
        ordering = ['relative_path']

    def __str__(self) -> str:
        return f'{self.namespace}/{self.relative_path}'
