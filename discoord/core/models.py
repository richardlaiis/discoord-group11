import secrets

from django.conf import settings
from django.db import models
from django.utils.text import slugify


class ChatGroup(models.Model):
	name = models.CharField(max_length=120)
	slug = models.SlugField(max_length=140, unique=True, blank=True)
	invite_code = models.CharField(max_length=12, unique=True, blank=True, editable=False)
	owner = models.ForeignKey(
		settings.AUTH_USER_MODEL,
		on_delete=models.CASCADE,
		related_name='owned_chat_groups',
	)
	members = models.ManyToManyField(
		settings.AUTH_USER_MODEL,
		through='ChatGroupMembership',
		related_name='chat_groups',
	)
	created_at = models.DateTimeField(auto_now_add=True)

	class Meta:
		ordering = ['name']

	def __str__(self):
		return self.name

	def save(self, *args, **kwargs):
		if not self.slug:
			base_slug = slugify(self.name) or 'group'
			slug = base_slug
			counter = 1
			while ChatGroup.objects.filter(slug=slug).exclude(pk=self.pk).exists():
				counter += 1
				slug = f'{base_slug}-{counter}'
			self.slug = slug

		if not self.invite_code:
			code = secrets.token_hex(4).upper()
			while ChatGroup.objects.filter(invite_code=code).exclude(pk=self.pk).exists():
				code = secrets.token_hex(4).upper()
			self.invite_code = code

		super().save(*args, **kwargs)


class ChatGroupMembership(models.Model):
	group = models.ForeignKey(ChatGroup, on_delete=models.CASCADE)
	user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
	joined_at = models.DateTimeField(auto_now_add=True)
	position_x = models.FloatField(default=50.0)
	position_y = models.FloatField(default=50.0)
	position_updated_at = models.DateTimeField(auto_now=True)

	class Meta:
		unique_together = [('group', 'user')]
		ordering = ['joined_at']

	def __str__(self):
		return f'{self.user} in {self.group}'


class ChatMessage(models.Model):
	group = models.ForeignKey(ChatGroup, on_delete=models.CASCADE, related_name='messages')
	sender = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='chat_messages')
	content = models.TextField(max_length=1000)
	created_at = models.DateTimeField(auto_now_add=True)

	class Meta:
		ordering = ['created_at']

	def __str__(self):
		return f'{self.sender} @ {self.group}'


class BlackboardNote(models.Model):
	group = models.ForeignKey(
		ChatGroup,
		on_delete=models.CASCADE,
		related_name='blackboard_notes',
	)
	author = models.ForeignKey(
		settings.AUTH_USER_MODEL,
		on_delete=models.CASCADE,
		related_name='blackboard_notes',
	)
	content = models.TextField(max_length=1000)
	pinned = models.BooleanField(default=False)
	created_at = models.DateTimeField(auto_now_add=True)
	updated_at = models.DateTimeField(auto_now=True)

	class Meta:
		ordering = ['-pinned', '-updated_at']

	def __str__(self):
		return f'Note by {self.author} in {self.group}'


class UserProfile(models.Model):
	STATUS_CHOICES = [
		('online', 'Online'),
		('idle', 'Idle'),
		('dnd', 'Do not disturb'),
		('invisible', 'Invisible'),
	]

	user = models.OneToOneField(
		settings.AUTH_USER_MODEL,
		on_delete=models.CASCADE,
		related_name='profile',
	)
	display_name = models.CharField(max_length=80, blank=True)
	pronouns = models.CharField(max_length=40, blank=True)
	bio = models.TextField(max_length=240, blank=True)
	status_text = models.CharField(max_length=120, blank=True)
	status_mode = models.CharField(max_length=12, choices=STATUS_CHOICES, default='online')
	updated_at = models.DateTimeField(auto_now=True)

	class Meta:
		ordering = ['user__username']

	def __str__(self):
		return f'Profile: {self.user}'
