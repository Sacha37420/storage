from django.core.management.base import BaseCommand, CommandError
from rest_framework.exceptions import ValidationError as DRFValidationError

from api.models import Share
from api.permissions import validate_new_parent


class Command(BaseCommand):
    """Rattache (ou détache) un partage EXISTANT à un parent, sans jamais
    toucher à son `name` ni à ses fichiers — c'est le mécanisme prévu pour
    migrer a posteriori un partage plat créé par un chantier App (ex.
    `arbre-genealogique-sacha-tree-12`) vers la hiérarchie, une fois le
    partage-conteneur voulu déjà créé (ex. via ce même outil, ou via
    `create_group_share`) : aucune app appelante n'a besoin d'être mise à
    jour, `relative_path`/`namespace` (littéralement `Share.name`, jamais
    dérivé du parent) restent identiques avant/après.

    Contrairement à la route self-service PATCH /api/shares/<name>/
    (réservée à un rattachement sous un partage du MÊME propriétaire, cf.
    Share.parent), cette commande n'impose PAS cette contrainte — même
    niveau de confiance qu'un accès manage.py, à l'image de
    `create_group_share` qui contourne déjà le self-service pour
    required_groups. Reste bornée par les mêmes garde-fous anti-cycle.

    Exemples :
        python manage.py set_share_parent arbre-genealogique-sacha-tree-12 \\
            --parent arbre-genealogique-sacha
        python manage.py set_share_parent un-partage --detach
    """

    help = "Rattache un partage existant à un parent (ou le détache avec --detach)."

    def add_arguments(self, parser):
        parser.add_argument('name', help='Nom du partage à rattacher/détacher')
        group = parser.add_mutually_exclusive_group(required=True)
        group.add_argument('--parent', help='Nom du partage parent')
        group.add_argument('--detach', action='store_true', help='Détacher (retour à la racine)')

    def handle(self, *args, **options):
        name = options['name'].strip().lower()
        try:
            share = Share.objects.get(name=name)
        except Share.DoesNotExist:
            raise CommandError(f"Partage '{name}' introuvable.")

        parent_name = None if options['detach'] else options['parent'].strip().lower()
        try:
            parent = validate_new_parent(share, parent_name, enforce_same_owner=False)
        except DRFValidationError as exc:
            raise CommandError(str(exc.detail))

        share.parent = parent
        share.save(update_fields=['parent'])

        verb = f"rattaché à '{parent.name}'" if parent else 'détaché (retour à la racine)'
        self.stdout.write(self.style.SUCCESS(f"Partage '{name}' {verb}."))
