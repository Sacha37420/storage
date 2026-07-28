from rest_framework import serializers

from .models import Share, ShareMember, StoredFile


class ShareSerializer(serializers.ModelSerializer):
    class Meta:
        model = Share
        fields = ['name', 'owner_username', 'created_at']
        read_only_fields = ['owner_username', 'created_at']


class ShareMemberSerializer(serializers.ModelSerializer):
    class Meta:
        model = ShareMember
        fields = ['member_email', 'added_at']
        read_only_fields = ['added_at']


class StoredFileSerializer(serializers.ModelSerializer):
    class Meta:
        model = StoredFile
        fields = [
            'namespace', 'relative_path', 'size', 'content_type',
            'uploaded_by_email', 'created_at', 'updated_at',
        ]
