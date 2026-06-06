from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0010_alter_userprofile_id'),
    ]

    operations = [
        migrations.AddField(
            model_name='userprofile',
            name='skin',
            field=models.CharField(default='#facc15', max_length=7, blank=True),
        ),
    ]
