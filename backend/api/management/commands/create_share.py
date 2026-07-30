from django.core.management.base import BaseCommand, CommandError
from django.core.exceptions import ValidationError
from rest_framework.exceptions import ValidationError as DRFValidationError

from api.models import KnownUser, Share
from api.permissions import validate_new_parent


class Command(BaseCommand):
    """Crée un partage vide, sans required_groups — typiquement un conteneur
    d'organisation pur (aucun ShareMember, aucun groupe requis : personne à
    part son propriétaire n'y a accès tant qu'on ne l'y ajoute pas
    explicitement), utile comme racine dans la hiérarchie avant d'y rattacher
    des partages déjà existants (cf. `set_share_parent`).

    Hors self-service par choix, comme `create_group_share` : un partage créé
    ici appartient définitivement à --owner, sans passer par une session
    utilisateur — cohérent avec le reste des commandes de provisionnement de
    cette app.

    Exemples :
        python manage.py create_share arbre-genealogique-sacha --owner sacha
        python manage.py create_share arbre-genealogique-sacha-tree-12 \\
            --owner sacha --parent arbre-genealogique-sacha
    """

    help = 'Crée un partage vide (conteneur), optionnellement déjà rattaché à un parent.'

    def add_arguments(self, parser):
        parser.add_argument('name', help='Nom du partage (namespace)')
        parser.add_argument('--owner', required=True, help='Username Keycloak (ou service:<client_id>)')
        parser.add_argument('--parent', default=None, help='Nom d\'un partage parent déjà existant (optionnel)')

    def handle(self, *args, **options):
        name = options['name'].strip().lower()
        owner = options['owner'].strip()

        if name == owner or KnownUser.objects.filter(username=name).exists():
            raise CommandError(f"'{name}' est déjà utilisé comme identifiant de compte.")

        share = Share(name=name, owner_username=owner)

        if options['parent']:
            try:
                share.parent = validate_new_parent(
                    share, options['parent'].strip().lower(), enforce_same_owner=False,
                )
            except DRFValidationError as exc:
                raise CommandError(str(exc.detail))

        try:
            share.full_clean()
        except ValidationError as exc:
            raise CommandError(str(exc))
        share.save()

        parent_msg = f", rattaché à '{share.parent.name}'" if share.parent else ''
        self.stdout.write(self.style.SUCCESS(
            f"Créé : partage '{name}', propriétaire '{owner}'{parent_msg}."
        ))
