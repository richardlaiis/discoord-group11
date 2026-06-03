# Generated migration to rename BlackboardNote author to updater

from django.db import migrations, models
import django.db.models.deletion
from django.conf import settings


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0006_userprofile'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.RenameField(
            model_name='blackboardnote',
            old_name='author',
            new_name='updater',
        ),
    ]
