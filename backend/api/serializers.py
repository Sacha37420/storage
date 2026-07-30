from rest_framework import serializers

from .models import Share, ShareMember, StoredFile


class ShareSerializer(serializers.ModelSerializer):
    # Nom du parent (ou null) plutôt que l'objet imbriqué : c'est déjà tout ce
    # dont le frontend a besoin (clé de navigation), et ça évite un aller-
    # retour supplémentaire côté API pour un champ en lecture seule ici — la
    # mutation passe par ShareDetailView.patch (api.permissions.
    # validate_new_parent), jamais par ce serializer, pour appliquer la
    # contrainte de même-propriétaire et la détection de cycle.
    parent = serializers.CharField(source='parent_id', allow_null=True, read_only=True)

    class Meta:
        model = Share
        fields = ['name', 'owner_username', 'required_groups', 'parent', 'created_at']
        read_only_fields = ['owner_username', 'required_groups', 'parent', 'created_at']


class ShareMemberSerializer(serializers.ModelSerializer):
    class Meta:
        model = ShareMember
        fields = ['member_email', 'role', 'added_at']
        read_only_fields = ['added_at']


class StoredFileSerializer(serializers.ModelSerializer):
    class Meta:
        model = StoredFile
        fields = [
            'namespace', 'relative_path', 'size', 'content_type',
            'uploaded_by_email', 'created_at', 'updated_at',
        ]
