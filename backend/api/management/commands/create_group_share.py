from django.core.management.base import BaseCommand, CommandError
from django.core.exceptions import ValidationError

from api.models import KnownUser, Share


class Command(BaseCommand):
    """Provisionne (ou met à jour) un partage lié à un groupe Keycloak.

    Hors self-service à dessein (voir api/serializers.py, ShareSerializer :
    required_groups en lecture seule) — une app qui pourrait s'auto-attribuer
    l'accès d'un groupe entier via l'API publique serait un risque disproportionné
    pour un besoin qui ne se présente qu'une fois par app migrée vers storage.

    Exemple :
        python manage.py create_group_share atelier-3d \\
            --owner sacha --required-groups developers,famille,amis
    """

    help = 'Crée ou met à jour un partage dont required_groups donne accès à tout un groupe Keycloak.'

    def add_arguments(self, parser):
        parser.add_argument('name', help='Nom du partage (namespace)')
        parser.add_argument('--owner', required=True, help='Username Keycloak administrant ce partage')
        parser.add_argument(
            '--required-groups', required=True,
            help='Groupe(s) Keycloak séparés par des virgules, ex: developers,famille,amis',
        )

    def handle(self, *args, **options):
        name = options['name'].strip().lower()
        owner = options['owner'].strip()
        required_groups = options['required_groups'].strip()

        if name == owner or KnownUser.objects.filter(username=name).exists():
            raise CommandError(f"'{name}' est déjà utilisé comme identifiant de compte.")

        share, created = Share.objects.get_or_create(
            name=name, defaults={'owner_username': owner, 'required_groups': required_groups},
        )
        if not created:
            share.owner_username = owner
            share.required_groups = required_groups

        try:
            share.full_clean()
        except ValidationError as exc:
            raise CommandError(str(exc))
        share.save()

        verb = 'Créé' if created else 'Mis à jour'
        self.stdout.write(self.style.SUCCESS(
            f"{verb} : partage '{name}', propriétaire '{owner}', groupes requis : {required_groups}"
        ))
