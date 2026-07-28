import re

from django.core.exceptions import ValidationError

# Nom de namespace (partage) : même format qu'un slug d'app du lab — minuscules,
# chiffres, tirets. Interdit de commencer/finir par un tiret pour éviter les
# ambiguïtés visuelles dans le chemin affiché <namespace>/<chemin>.
_SLUG_RE = re.compile(r'^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$')


def validate_namespace_slug(value: str) -> None:
    if not _SLUG_RE.match(value or ''):
        raise ValidationError(
            "Nom invalide : minuscules, chiffres et tirets uniquement, "
            "sans tiret en début ou fin (2 à 64 caractères)."
        )


def validate_relative_path(value: str) -> None:
    """Valide un chemin logique <namespace>/<relative_path> — jamais utilisé
    tel quel comme chemin filesystem (voir StoredFile.content), mais doit
    rester un identifiant sans ambiguïté (pas de '..', pas de segment vide)."""
    if not value or value != value.strip():
        raise ValidationError("Chemin invalide.")
    if value.startswith('/') or value.endswith('/'):
        raise ValidationError("Le chemin ne doit pas commencer ou finir par '/'.")
    for segment in value.split('/'):
        if not segment or segment in ('.', '..'):
            raise ValidationError(f"Segment de chemin invalide : '{segment}'.")
