from django.db import migrations


def seed_member_positions(apps, schema_editor):
    ChatGroupMembership = apps.get_model('core', 'ChatGroupMembership')

    memberships = list(
        ChatGroupMembership.objects
        .select_related('group')
        .order_by('group_id', 'user_id', 'id')
    )

    grouped = {}
    for membership in memberships:
        grouped.setdefault(membership.group_id, []).append(membership)

    for _, group_memberships in grouped.items():
        for index, membership in enumerate(group_memberships):
            # Move only untouched default positions away from center.
            if float(membership.position_x) != 50.0 or float(membership.position_y) != 50.0:
                continue

            x = 12.0 + ((membership.user_id * 37 + index * 11) % 76)
            y = 12.0 + ((membership.user_id * 53 + index * 7) % 76)
            membership.position_x = x
            membership.position_y = y

        ChatGroupMembership.objects.bulk_update(group_memberships, ['position_x', 'position_y'])


class Migration(migrations.Migration):

    dependencies = [
        ('core', '0002_chatgroupmembership_position_fields'),
    ]

    operations = [
        migrations.RunPython(seed_member_positions, migrations.RunPython.noop),
    ]
