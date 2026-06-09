from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from django.template.loader import render_to_string

from .models import BlackboardNote, ChatGroup, ChatMessage
from .presence import (
    get_online_member_ids,
    get_online_member_states,
    mark_member_offline,
    mark_member_online,
    update_member_motion,
)


class ChatConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        self.group_slug = self.scope['url_route']['kwargs']['group_slug']
        self.user = self.scope['user']

        if not self.user.is_authenticated:
            await self.close()
            return

        self.chat_group = await self.get_chat_group(self.group_slug)
        if self.chat_group is None or not await self.is_group_member(self.chat_group, self.user):
            await self.close()
            return

        self.room_group_name = f'chat_{self.chat_group.slug}'
        await self.channel_layer.group_add(self.room_group_name, self.channel_name)
        
        self.user_group_name = f'user_{self.user.id}'
        await self.channel_layer.group_add(self.user_group_name, self.channel_name)
        
        await self.accept()

        await self.set_online()
        await self.send_room_state()
        await self.broadcast_presence()

    async def disconnect(self, close_code):
        if hasattr(self, 'room_group_name'):
            await self.set_offline()
            await self.broadcast_presence()
            await self.channel_layer.group_discard(self.room_group_name, self.channel_name)
        if hasattr(self, 'user_group_name'):
            await self.channel_layer.group_discard(self.user_group_name, self.channel_name)

    async def receive_json(self, content, **kwargs):
        message_type = content.get('type')

        if message_type == 'move':
            movement = await self.apply_movement(
                content.get('dx', 0.0),
                content.get('dy', 0.0),
            )
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'motion.update',
                    'member': movement,
                },
            )
            return

        if message_type != 'message':
            if message_type != 'blackboard_note':
                return

            note_content = (content.get('content') or '').strip()
            if not note_content:
                return

            html = await self.create_blackboard_note(self.chat_group, self.user, note_content)
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'blackboard.update',
                    'html': html,
                },
            )
            return

        text = (content.get('content') or '').strip()
        if not text:
            return

        message = await self.create_message(self.chat_group, self.user, text)
        await self.set_online()

        await self.channel_layer.group_send(
            self.room_group_name,
            {
                'type': 'chat.message',
                'message': {
                    'id': message['id'],
                    'content': message['content'],
                    'sender': message['sender'],
                    'created_at': message['created_at'],
                    'is_me': message['is_me'],
                    'sender_id': message['sender_id'],
                },
            },
        )

        await self.broadcast_presence()

    async def chat_message(self, event):
        await self.send_json({'type': 'message', 'message': event['message']})

    async def presence_update(self, event):
        await self.send_json(
            {
                'type': 'presence',
                'online_member_ids': event['online_member_ids'],
                'member_states': event.get('member_states', {}),
            },
        )

    async def motion_update(self, event):
        await self.send_json({'type': 'motion', 'member': event['member']})

    async def blackboard_update(self, event):
        payload = {'type': 'blackboard_update'}
        if event.get('html') is not None:
            payload['html'] = event['html']
        await self.send_json(payload)

    async def dm_received(self, event):
        await self.send_json({
            'type': 'dm_received',
            'message': event['message'],
            'dm_slug': event['dm_slug'],
            'partner_id': event['partner_id'],
            'partner_username': event['partner_username'],
        })

    async def set_online(self):
        await database_sync_to_async(mark_member_online)(self.chat_group.slug, self.user)

    async def set_offline(self):
        await database_sync_to_async(mark_member_offline)(self.chat_group.slug, self.user)

    async def broadcast_presence(self):
        online_member_ids = list(await database_sync_to_async(get_online_member_ids)(self.chat_group.slug))
        member_states = await database_sync_to_async(get_online_member_states)(self.chat_group.slug)
        await self.channel_layer.group_send(
            self.room_group_name,
            {
                'type': 'presence.update',
                'online_member_ids': online_member_ids,
                'member_states': member_states,
            },
        )

    async def send_room_state(self):
        online_member_ids = list(await database_sync_to_async(get_online_member_ids)(self.chat_group.slug))
        member_states = await database_sync_to_async(get_online_member_states)(self.chat_group.slug)
        await self.send_json(
            {
                'type': 'state',
                'online_member_ids': online_member_ids,
                'member_states': member_states,
            },
        )

    @database_sync_to_async
    def get_chat_group(self, group_slug):
        return ChatGroup.objects.filter(slug=group_slug).first()

    @database_sync_to_async
    def is_group_member(self, chat_group, user):
        return chat_group.members.filter(pk=user.pk).exists()

    @database_sync_to_async
    def create_message(self, chat_group, user, text):
        message = ChatMessage.objects.create(group=chat_group, sender=user, content=text)
        return {
            'id': message.id,
            'content': message.content,
            'sender': message.sender.username,
            'sender_id': message.sender_id,
            'created_at': message.created_at.isoformat(),
            'is_me': message.sender_id == user.id,
        }

    @database_sync_to_async
    def create_blackboard_note(self, chat_group, user, text):
        BlackboardNote.objects.create(group=chat_group, updater=user, content=text)
        blackboard_notes = (
            BlackboardNote.objects.filter(group=chat_group)
            .select_related('updater')
            .order_by('-pinned', '-updated_at')[:20]
        )
        return render_to_string(
            'partials/blackboard_notes.html',
            {
                'blackboard_notes': blackboard_notes,
                'active_group': chat_group,
            },
        )

    @database_sync_to_async
    def apply_movement(self, delta_x, delta_y):
        return update_member_motion(self.chat_group.slug, self.user, delta_x, delta_y)