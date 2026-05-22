from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='chatgroupmembership',
            name='position_x',
            field=models.FloatField(default=50.0),
        ),
        migrations.AddField(
            model_name='chatgroupmembership',
            name='position_y',
            field=models.FloatField(default=50.0),
        ),
        migrations.AddField(
            model_name='chatgroupmembership',
            name='position_updated_at',
            field=models.DateTimeField(auto_now=True),
        ),
    ]
