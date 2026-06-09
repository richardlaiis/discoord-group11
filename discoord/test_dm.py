import os
import django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'discoord.settings')
django.setup()

from core.models import UserDrop, ChatGroup, ChatMessage, UserProfile
from django.contrib.auth.models import User

# create test users
user1, _ = User.objects.get_or_create(username='user1')
user2, _ = User.objects.get_or_create(username='user2')

# create DM
dm, _ = ChatGroup.objects.get_or_create(name='DM', is_dm=True, owner=user1)
dm.members.add(user1, user2)

print("DM Slug:", dm.slug)
