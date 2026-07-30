import mimetypes

from django.conf import settings
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError
from django.http import FileResponse
from rest_framework import status
from rest_framework.exceptions import NotFound, ValidationError as DRFValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .discovery import build_share_forest
from .models import KnownUser, Share, ShareMember, StoredFile
from .permissions import get_owned_share, require_write, resolve_namespace, validate_new_parent
from .serializers import ShareMemberSerializer, ShareSerializer, StoredFileSerializer
from .validators import validate_namespace_slug, validate_relative_path


class MeView(APIView):
    """GET /api/me/ — identité de l'utilisateur authentifié."""

    def get(self, request):
        return Response({
            'email': request.user.email,
            'username': request.user.username,
            'groups': request.user.claims.get('groups', []),
        })


class ShareListCreateView(APIView):
    """
    GET  /api/shares/ — partages dont je suis propriétaire + dont je suis
         membre (comportement historique, conservé tel quel), PLUS `tree` :
         l'arborescence complète des partages qui me sont visibles — les
         miens/ceux dont je suis membre, et les ancêtres nécessaires pour
         naviguer jusqu'à eux (accessible=False, détails minimaux — voir
         api/discovery.py pour la décision de sécurité documentée).
    POST /api/shares/ — {name, parent?} → crée un partage dont je deviens
         propriétaire, optionnellement rattaché sous un partage que je
         possède déjà (voir api.permissions.validate_new_parent : le parent
         doit m'appartenir, self-service oblige).
    """

    def get(self, request):
        owned = Share.objects.filter(owner_username=request.user.username)
        member_of = (
            Share.objects.filter(members__member_email=request.user.email)
            .exclude(owner_username=request.user.username)
        )
        return Response({
            'owned': ShareSerializer(owned, many=True).data,
            'member_of': ShareSerializer(member_of, many=True).data,
            'tree': build_share_forest(request.user),
        })

    def post(self, request):
        name = (request.data.get('name') or '').strip().lower()
        try:
            validate_namespace_slug(name)
        except DjangoValidationError as exc:
            raise DRFValidationError({'name': exc.messages})

        # Le nom de partage partage le même espace d'adressage que les
        # namespaces personnels (usernames) : une collision rendrait
        # <namespace>/<chemin> ambigu.
        if name == request.user.username or KnownUser.objects.filter(username=name).exists():
            raise DRFValidationError({'name': ["Ce nom est déjà utilisé comme identifiant de compte."]})

        share = Share(name=name, owner_username=request.user.username)

        parent_name = (request.data.get('parent') or '').strip().lower()
        if parent_name:
            share.parent = validate_new_parent(share, parent_name, enforce_same_owner=True)

        try:
            share.full_clean()
            share.save()
        except DjangoValidationError as exc:
            # full_clean() valide l'unicité de `name` en base AVANT le save() —
            # une collision est donc levée ici, pas par l'IntegrityError ci-dessous
            # (qui ne couvre plus qu'une éventuelle course concurrentielle).
            raise DRFValidationError(getattr(exc, 'message_dict', {'name': exc.messages}))
        except IntegrityError:
            raise DRFValidationError({'name': ['Ce nom de partage est déjà pris.']})
        return Response(ShareSerializer(share).data, status=status.HTTP_201_CREATED)


class ShareDetailView(APIView):
    """
    DELETE /api/shares/<name>/ — propriétaire uniquement, cascade sur les
           fichiers du partage. Refuse (400) s'il reste des enfants — voir
           Share.parent (on_delete=PROTECT) : il faut les détacher ou les
           supprimer explicitement d'abord, jamais de suppression en cascade
           silencieuse d'un sous-partage qui peut appartenir à quelqu'un
           d'autre.
    PATCH  /api/shares/<name>/ — {parent} → rattache (nom d'un partage que je
           possède déjà) ou détache (null/"") ce partage dans la hiérarchie.
           Propriétaire uniquement ; voir api.permissions.validate_new_parent
           pour les contrôles (existence, anti-cycle, même-propriétaire).
    """

    def patch(self, request, name):
        share = get_owned_share(request.user, name)
        if 'parent' not in request.data:
            raise DRFValidationError({'parent': ['Requis (nom de partage, ou null/"" pour détacher).']})
        parent_name = request.data.get('parent')
        share.parent = validate_new_parent(share, (parent_name or '').strip().lower(), enforce_same_owner=True)
        share.save(update_fields=['parent'])
        return Response(ShareSerializer(share).data)

    def delete(self, request, name):
        share = get_owned_share(request.user, name)
        if share.children.exists():
            raise DRFValidationError({
                'detail': ["Ce partage a des enfants : détachez-les ou supprimez-les d'abord."],
            })
        for stored in share.files.all():
            stored.content.delete(save=False)
        share.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ShareMembersView(APIView):
    """GET/POST /api/shares/<name>/members/ — propriétaire uniquement."""

    def get(self, request, name):
        share = get_owned_share(request.user, name)
        return Response(ShareMemberSerializer(share.members.all(), many=True).data)

    def post(self, request, name):
        share = get_owned_share(request.user, name)
        email = (request.data.get('member_email') or '').strip().lower()
        if not email:
            raise DRFValidationError({'member_email': ['Requis.']})
        role = request.data.get('role', 'read')
        if role not in ('read', 'write'):
            raise DRFValidationError({'role': ["Doit être 'read' ou 'write'."]})
        member, created = ShareMember.objects.get_or_create(
            share=share, member_email=email, defaults={'role': role},
        )
        if not created and member.role != role:
            member.role = role
            member.save(update_fields=['role'])
        return Response(ShareMemberSerializer(member).data, status=status.HTTP_201_CREATED)


class ShareMemberDetailView(APIView):
    """DELETE /api/shares/<name>/members/<email>/ — propriétaire uniquement."""

    def delete(self, request, name, email):
        share = get_owned_share(request.user, name)
        deleted, _ = ShareMember.objects.filter(share=share, member_email=email).delete()
        if not deleted:
            raise NotFound(f"'{email}' n'est pas membre de '{name}'.")
        return Response(status=status.HTTP_204_NO_CONTENT)


class FileListUploadView(APIView):
    """
    GET  /api/files/<namespace>/ — liste (option ?prefix=).
    POST /api/files/<namespace>/ — upload multipart (file, relative_path).
    """

    def get(self, request, namespace):
        resolve_namespace(namespace, request.user)  # 404/403 si accès refusé
        qs = StoredFile.objects.filter(namespace=namespace)
        prefix = request.query_params.get('prefix', '')
        if prefix:
            qs = qs.filter(relative_path__startswith=prefix)
        return Response(StoredFileSerializer(qs, many=True).data)

    def post(self, request, namespace):
        access = resolve_namespace(namespace, request.user)
        require_write(access)

        upload = request.FILES.get('file')
        relative_path = (request.data.get('relative_path') or '').strip()
        if not upload:
            raise DRFValidationError({'file': ['Requis.']})
        try:
            validate_relative_path(relative_path)
        except DjangoValidationError as exc:
            raise DRFValidationError({'relative_path': exc.messages})

        if upload.size > settings.MAX_UPLOAD_BYTES:
            raise DRFValidationError(
                {'file': [f'Fichier trop volumineux (max {settings.MAX_UPLOAD_BYTES} octets).']}
            )

        content_type = upload.content_type or mimetypes.guess_type(relative_path)[0] or ''

        existing = StoredFile.objects.filter(namespace=namespace, relative_path=relative_path).first()
        if existing:
            existing.content.delete(save=False)  # purge l'ancien blob, jamais réutilisé
            existing.content = upload
            existing.size = upload.size
            existing.content_type = content_type
            existing.uploaded_by_email = request.user.email
            existing.share = access.share
            existing.save()
            stored = existing
        else:
            stored = StoredFile.objects.create(
                namespace=namespace,
                share=access.share,
                relative_path=relative_path,
                content=upload,
                size=upload.size,
                content_type=content_type,
                uploaded_by_email=request.user.email,
            )
        return Response(StoredFileSerializer(stored).data, status=status.HTTP_201_CREATED)


class FileContentView(APIView):
    """GET/DELETE /api/files/<namespace>/content/<path:relative_path>."""

    def get(self, request, namespace, relative_path):
        resolve_namespace(namespace, request.user)
        stored = _get_stored_file(namespace, relative_path)
        response = FileResponse(
            stored.content.open('rb'),
            content_type=stored.content_type or 'application/octet-stream',
        )
        filename = stored.relative_path.rsplit('/', 1)[-1]
        response['Content-Disposition'] = f'inline; filename="{filename}"'
        return response

    def delete(self, request, namespace, relative_path):
        access = resolve_namespace(namespace, request.user)
        require_write(access)
        stored = _get_stored_file(namespace, relative_path)
        stored.content.delete(save=False)
        stored.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


def _get_stored_file(namespace: str, relative_path: str) -> StoredFile:
    try:
        return StoredFile.objects.get(namespace=namespace, relative_path=relative_path)
    except StoredFile.DoesNotExist:
        raise NotFound(f"Fichier '{relative_path}' introuvable dans '{namespace}'.")
