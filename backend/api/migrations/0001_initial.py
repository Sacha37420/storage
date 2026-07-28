from django.db import migrations, models
import django.db.models.deletion

import api.models
import api.validators


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name='KnownUser',
            fields=[
                ('email',      models.EmailField(max_length=255, primary_key=True, serialize=False)),
                ('username',   models.CharField(max_length=255, unique=True)),
                ('first_seen', models.DateTimeField(auto_now_add=True)),
            ],
            options={
                'db_table': 'known_users',
            },
        ),
        migrations.CreateModel(
            name='Share',
            fields=[
                ('name', models.CharField(
                    max_length=64, primary_key=True, serialize=False,
                    validators=[api.validators.validate_namespace_slug],
                )),
                ('owner_username', models.CharField(db_index=True, max_length=255)),
                ('created_at',     models.DateTimeField(auto_now_add=True)),
            ],
            options={
                'db_table': 'shares',
                'ordering': ['name'],
            },
        ),
        migrations.CreateModel(
            name='ShareMember',
            fields=[
                ('id',           models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('member_email', models.EmailField(max_length=254)),
                ('added_at',     models.DateTimeField(auto_now_add=True)),
                ('share', models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='members', to='api.share',
                )),
            ],
            options={
                'db_table': 'share_members',
                'ordering': ['member_email'],
            },
        ),
        migrations.CreateModel(
            name='StoredFile',
            fields=[
                ('id',        models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('namespace', models.CharField(db_index=True, max_length=255)),
                ('relative_path', models.CharField(
                    max_length=1024, validators=[api.validators.validate_relative_path],
                )),
                ('content',           models.FileField(upload_to=api.models._blob_upload_path)),
                ('size',              models.BigIntegerField()),
                ('content_type',      models.CharField(blank=True, max_length=255)),
                ('uploaded_by_email', models.EmailField(max_length=254)),
                ('created_at',        models.DateTimeField(auto_now_add=True)),
                ('updated_at',        models.DateTimeField(auto_now=True)),
                ('share', models.ForeignKey(
                    blank=True, null=True,
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name='files', to='api.share',
                )),
            ],
            options={
                'db_table': 'stored_files',
                'ordering': ['relative_path'],
            },
        ),
        migrations.AlterUniqueTogether(
            name='sharemember',
            unique_together={('share', 'member_email')},
        ),
        migrations.AlterUniqueTogether(
            name='storedfile',
            unique_together={('namespace', 'relative_path')},
        ),
    ]
