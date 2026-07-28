from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [('api', '0001_initial')]

    operations = [
        migrations.AddField(
            model_name='share',
            name='required_groups',
            field=models.CharField(blank=True, default='', max_length=255),
        ),
        migrations.AddField(
            model_name='sharemember',
            name='role',
            field=models.CharField(
                choices=[('read', 'read'), ('write', 'write')], default='read', max_length=10,
            ),
        ),
    ]
