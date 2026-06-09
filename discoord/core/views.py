from django.contrib import messages
from django.contrib.auth import login
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.template.loader import render_to_string
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

from .forms import ChatGroupCreateForm, ChatGroupJoinForm, RegistrationForm, BlackboardNoteForm
from .models import ChatGroup, ChatGroupMembership, ChatMessage, BlackboardNote, UserProfile, UserDrop
from .presence import (
    get_online_member_ids,
    get_online_member_states,
    touch_member_online,
    update_member_motion,
)


def _resolve_active_group(request, groups, slug=None):
    requested_slug = slug or request.GET.get('group') or request.session.get('active_group_slug')
    if requested_slug:
        active_group = groups.filter(slug=requested_slug).first()
        if active_group:
            request.session['active_group_slug'] = active_group.slug
            return active_group

    active_group = groups.first()
    if active_group:
        request.session['active_group_slug'] = active_group.slug
    return active_group


def _broadcast_blackboard_update(group, blackboard_notes):
    channel_layer = get_channel_layer()
    if channel_layer is None:
        return

    html = render_to_string(
        'partials/blackboard_notes.html',
        {
            'blackboard_notes': blackboard_notes,
            'active_group': group,
        },
    )
    async_to_sync(channel_layer.group_send)(
        f'chat_{group.slug}',
        {
            'type': 'blackboard.update',
            'html': html,
        },
    )


@login_required
def room_view(request, slug=None):
    all_groups = (
        ChatGroup.objects.filter(members=request.user)
        .prefetch_related('members')
        .select_related('owner')
    )
    groups = all_groups.filter(is_dm=False)
    dms = []
    for dm in all_groups.filter(is_dm=True):
        dm.other_member = dm.members.exclude(id=request.user.id).first()
        dms.append(dm)
    active_group = _resolve_active_group(request, all_groups, slug=slug)
    chat_messages = []
    members = []
    room_members = []
    online_member_ids = set()

    if active_group is not None:
        chat_messages = (
            ChatMessage.objects.filter(group=active_group)
            .select_related('sender')
            .order_by('created_at')[:100]
        )
        members = active_group.members.all().order_by('username')
        memberships = {
            membership.user_id: membership
            for membership in ChatGroupMembership.objects.filter(group=active_group).select_related('user')
        }
        profiles_by_user_id = {
            profile.user_id: profile
            for profile in UserProfile.objects.filter(user__in=members)
        }
        blackboard_notes = (
            BlackboardNote.objects.filter(group=active_group)
            .select_related('updater')
            .order_by('-pinned', '-updated_at')[:20]
        )
        online_member_ids = get_online_member_ids(active_group.slug)
        live_states = get_online_member_states(active_group.slug)
        room_members = [
            {
                'id': member.id,
                'username': member.username,
                'display_name': (profiles_by_user_id.get(member.id).display_name or member.username)
                if profiles_by_user_id.get(member.id)
                else member.username,
                'position_x': live_states.get(member.id, {}).get(
                    'x',
                    memberships.get(member.id).position_x if memberships.get(member.id) else 50.0,
                ),
                'position_y': live_states.get(member.id, {}).get(
                    'y',
                    memberships.get(member.id).position_y if memberships.get(member.id) else 50.0,
                ),
                'skin': (profiles_by_user_id.get(member.id).skin if profiles_by_user_id.get(member.id) else '') or '',
                'avatar_url': profiles_by_user_id.get(member.id).avatar_image.url if (profiles_by_user_id.get(member.id) and profiles_by_user_id.get(member.id).avatar_image) else None,
            }
            for member in members
        ]
        member_cards = [
            {
                'id': member.id,
                'username': member.username,
                'display_name': (profiles_by_user_id.get(member.id).display_name or member.username)
                if profiles_by_user_id.get(member.id)
                else member.username,
                'is_online': member.id in online_member_ids,
                'avatar_url': profiles_by_user_id.get(member.id).avatar_image.url if (profiles_by_user_id.get(member.id) and profiles_by_user_id.get(member.id).avatar_image) else None,
            }
            for member in members
        ]
    else:
        blackboard_notes = BlackboardNote.objects.none()
        member_cards = []

    context = {
        'all_groups': all_groups,
        'groups': groups,
        'dms': dms,
        'active_group': active_group,
        'chat_messages': chat_messages,
        'members': members,
        'member_cards': member_cards,
        'room_members': room_members,
        'online_member_ids': online_member_ids,
        'blackboard_notes': blackboard_notes,
        'blackboard_note_form': BlackboardNoteForm(),
        'create_group_form': ChatGroupCreateForm(),
        'join_group_form': ChatGroupJoinForm(),
    }
    return render(request, 'room.html', context)


def _get_or_create_profile(user):
    profile, _ = UserProfile.objects.get_or_create(user=user)
    return profile


@login_required
def group_messages_fragment(request, slug):
    group = get_object_or_404(ChatGroup, slug=slug, members=request.user)
    chat_messages = (
        ChatMessage.objects.filter(group=group)
        .select_related('sender')
        .order_by('created_at')[:100]
    )
    return render(request, 'partials/chat_messages.html', {'chat_messages': chat_messages})


@login_required
def group_blackboard_fragment(request, slug):
    group = get_object_or_404(ChatGroup, slug=slug, members=request.user)
    blackboard_notes = (
        BlackboardNote.objects.filter(group=group)
        .select_related('updater')
        .order_by('-pinned', '-updated_at')[:20]
    )
    return render(request, 'partials/blackboard_notes.html', {
        'blackboard_notes': blackboard_notes,
        'active_group': group,
    })


@login_required
def group_blackboard_note_edit(request, slug, note_id):
    group = get_object_or_404(ChatGroup, slug=slug, members=request.user)
    note = get_object_or_404(BlackboardNote, pk=note_id, group=group)
    return render(request, 'partials/blackboard_note_edit.html', {
        'note': note,
        'active_group': group,
    })


@login_required
def update_blackboard_note_view(request, slug, note_id):
    if request.method != 'POST':
        return JsonResponse({'ok': False, 'error': 'Method not allowed'}, status=405)

    group = get_object_or_404(ChatGroup, slug=slug, members=request.user)
    note = get_object_or_404(BlackboardNote, pk=note_id, group=group)

    content = (request.POST.get('content') or '').strip()
    if not content:
        return JsonResponse({'ok': False, 'error': 'Note cannot be empty'}, status=400)

    note.content = content
    note.updater = request.user
    note.save()

    blackboard_notes = (
        BlackboardNote.objects.filter(group=group)
        .select_related('updater')
        .order_by('-pinned', '-updated_at')[:20]
    )

    _broadcast_blackboard_update(group, blackboard_notes)

    return render(request, 'partials/blackboard_notes.html', {
        'blackboard_notes': blackboard_notes,
        'active_group': group,
    })


@login_required
def delete_blackboard_note_view(request, slug, note_id):
    if request.method != 'POST':
        return JsonResponse({'ok': False, 'error': 'Method not allowed'}, status=405)

    group = get_object_or_404(ChatGroup, slug=slug, members=request.user)
    note = get_object_or_404(BlackboardNote, pk=note_id, group=group)

    note.delete()
    blackboard_notes = (
        BlackboardNote.objects.filter(group=group)
        .select_related('updater')
        .order_by('-pinned', '-updated_at')[:20]
    )

    _broadcast_blackboard_update(group, blackboard_notes)

    return render(request, 'partials/blackboard_notes.html', {
        'blackboard_notes': blackboard_notes,
        'active_group': group,
    })


@login_required
def create_blackboard_note_view(request, slug):
    if request.method != 'POST':
        return JsonResponse({'ok': False, 'error': 'Method not allowed'}, status=405)

    group = get_object_or_404(ChatGroup, slug=slug, members=request.user)
    content = (request.POST.get('content') or '').strip()
    if not content:
        return JsonResponse({'ok': False, 'error': 'Note cannot be empty'}, status=400)

    BlackboardNote.objects.create(group=group, updater=request.user, content=content)
    blackboard_notes = (
        BlackboardNote.objects.filter(group=group)
        .select_related('updater')
        .order_by('-pinned', '-updated_at')[:20]
    )

    _broadcast_blackboard_update(group, blackboard_notes)

    return render(request, 'partials/blackboard_notes.html', {
        'blackboard_notes': blackboard_notes,
        'active_group': group,
    })


@login_required
def create_group_view(request):
    if request.method != 'POST':
        return redirect('room')

    form = ChatGroupCreateForm(request.POST)
    if not form.is_valid():
        messages.error(request, '請輸入有效的群組名稱。')
        return redirect('room')

    group = form.save(commit=False)
    group.owner = request.user
    group.save()
    group.members.add(request.user)
    request.session['active_group_slug'] = group.slug
    messages.success(request, f'已建立群組 {group.name}。')
    return redirect('room_group', slug=group.slug)


@login_required
def join_group_view(request):
    if request.method != 'POST':
        return redirect('room')

    form = ChatGroupJoinForm(request.POST)
    if not form.is_valid():
        messages.error(request, '請輸入有效的邀請碼。')
        return redirect('room')

    invite_code = form.cleaned_data['invite_code'].strip()
    group = ChatGroup.objects.filter(invite_code__iexact=invite_code).first()
    if group is None:
        group = ChatGroup.objects.filter(slug__iexact=invite_code).first()

    if group is None:
        messages.error(request, '找不到這個群組。')
        return redirect('room')

    group.members.add(request.user)
    request.session['active_group_slug'] = group.slug
    messages.success(request, f'已加入群組 {group.name}。')
    return redirect('room_group', slug=group.slug)


@login_required
def send_message_view(request, slug):
    if request.method != 'POST':
        return JsonResponse({'ok': False, 'error': 'Method not allowed'}, status=405)

    group = get_object_or_404(ChatGroup, slug=slug, members=request.user)
    content = (request.POST.get('content') or '').strip()
    if not content:
        return JsonResponse({'ok': False, 'error': 'Message cannot be empty'}, status=400)

    message = ChatMessage.objects.create(group=group, sender=request.user, content=content)
    channel_layer = get_channel_layer()
    payload = {
        'id': message.id,
        'content': message.content,
        'sender': message.sender.username,
        'sender_id': message.sender_id,
        'created_at': message.created_at.isoformat(),
        'is_me': True,
    }

    async_to_sync(channel_layer.group_send)(
        f'chat_{group.slug}',
        {
            'type': 'chat.message',
            'message': payload,
        },
    )

    async_to_sync(channel_layer.group_send)(
        f'chat_{group.slug}',
        {
            'type': 'presence.update',
            'online_member_ids': list(get_online_member_ids(group.slug)),
        },
    )

    if group.is_dm:
        other_member = group.members.exclude(id=request.user.id).first()
        if other_member:
            dm_payload = payload.copy()
            dm_payload['is_me'] = False
            async_to_sync(channel_layer.group_send)(
                f'user_{other_member.id}',
                {
                    'type': 'dm.received',
                    'message': dm_payload,
                    'dm_slug': group.slug,
                    'partner_id': request.user.id,
                    'partner_username': request.user.username,
                },
            )

    return JsonResponse({'ok': True, 'message': payload})


@login_required
def move_member_view(request, slug):
    if request.method != 'POST':
        return JsonResponse({'ok': False, 'error': 'Method not allowed'}, status=405)

    group = get_object_or_404(ChatGroup, slug=slug, members=request.user)

    try:
        delta_x = float(request.POST.get('dx', 0.0))
        delta_y = float(request.POST.get('dy', 0.0))
    except (TypeError, ValueError):
        return JsonResponse({'ok': False, 'error': 'Invalid movement payload'}, status=400)

    touch_member_online(group.slug, request.user)
    member_state = update_member_motion(group.slug, request.user, delta_x, delta_y)
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'chat_{group.slug}',
        {
            'type': 'motion.update',
            'member': member_state,
        },
    )
    return JsonResponse({'ok': True, 'member': member_state})


@login_required
def room_state_view(request, slug):
    if request.method != 'GET':
        return JsonResponse({'ok': False, 'error': 'Method not allowed'}, status=405)

    group = get_object_or_404(ChatGroup, slug=slug, members=request.user)
    touch_member_online(group.slug, request.user)
    return JsonResponse(
        {
            'ok': True,
            'online_member_ids': list(get_online_member_ids(group.slug)),
            'member_states': get_online_member_states(group.slug),
        },
    )


def register_view(request):
    if request.method == 'POST':
        form = RegistrationForm(request.POST)
        if form.is_valid():
            user = form.save()
            login(request, user)
            return redirect('room')
    else:
        form = RegistrationForm()

    return render(request, 'registration/register.html', {'form': form})


@login_required
def group_member_profile_view(request, slug, user_id):
    group = get_object_or_404(ChatGroup, slug=slug, members=request.user)
    if not group.members.filter(pk=user_id).exists():
        return JsonResponse({'ok': False, 'error': 'Member not found'}, status=404)

    target_user = group.members.filter(pk=user_id).only('id', 'username').first()
    profile = _get_or_create_profile(target_user)

    if request.method == 'GET':
        return JsonResponse(
            {
                'ok': True,
                'profile': {
                    'user_id': target_user.id,
                    'username': target_user.username,
                    'display_name': profile.display_name,
                    'pronouns': profile.pronouns,
                    'bio': profile.bio,
                    'status_text': profile.status_text,
                    'status_mode': profile.status_mode,
                    'is_self': target_user.id == request.user.id,
                    'skin': profile.skin,
                    'avatar_url': profile.avatar_image.url if profile.avatar_image else None,
                },
            }
        )

    if request.method != 'POST':
        return JsonResponse({'ok': False, 'error': 'Method not allowed'}, status=405)

    if target_user.id != request.user.id:
        return JsonResponse({'ok': False, 'error': 'Permission denied'}, status=403)

    def _clean_field(value, limit):
        return (value or '').strip()[:limit]

    allowed_modes = {choice[0] for choice in UserProfile.STATUS_CHOICES}
    status_mode = _clean_field(request.POST.get('status_mode'), 12)
    if status_mode not in allowed_modes:
        status_mode = profile.status_mode

    profile.display_name = _clean_field(request.POST.get('display_name'), 80)
    profile.pronouns = _clean_field(request.POST.get('pronouns'), 40)
    profile.bio = _clean_field(request.POST.get('bio'), 240)
    profile.status_text = _clean_field(request.POST.get('status_text'), 120)
    profile.status_mode = status_mode
    # accept skin hex (basic validation)
    skin_val = (request.POST.get('skin') or '').strip()
    if skin_val and skin_val.startswith('#') and len(skin_val) in (4, 7):
        profile.skin = skin_val

    if request.POST.get('remove_avatar') == 'true':
        profile.avatar_image.delete(save=False)
        profile.avatar_image = None
    elif 'avatar_image' in request.FILES:
        profile.avatar_image.delete(save=False)
        profile.avatar_image = request.FILES['avatar_image']

    profile.save()

    # broadcast presence/state to group so other clients receive updated skin
    try:
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f'chat_{group.slug}',
            {
                'type': 'presence.update',
                'online_member_ids': list(get_online_member_ids(group.slug)),
                'member_states': get_online_member_states(group.slug),
            },
        )
    except Exception:
        pass

    return JsonResponse(
        {
            'ok': True,
            'profile': {
                'user_id': target_user.id,
                'username': target_user.username,
                'display_name': profile.display_name,
                'pronouns': profile.pronouns,
                'bio': profile.bio,
                'status_text': profile.status_text,
                'status_mode': profile.status_mode,
                'is_self': True,
                'skin': profile.skin,
                'avatar_url': profile.avatar_image.url if profile.avatar_image else None,
            },
        }
    )

@login_required
def start_dm_view(request, user_id):
    if request.method != 'POST':
        return redirect('room')

    if user_id == request.user.id:
        return redirect('room')

    from django.contrib.auth import get_user_model
    User = get_user_model()
    target_user = get_object_or_404(User, pk=user_id)

    existing_dm = ChatGroup.objects.filter(is_dm=True, members=request.user).filter(members=target_user).first()
    if existing_dm:
        request.session['active_group_slug'] = existing_dm.slug
        return redirect('room_group', slug=existing_dm.slug)

    dm = ChatGroup.objects.create(name=f"DM", is_dm=True, owner=request.user)
    dm.members.add(request.user, target_user)
    request.session['active_group_slug'] = dm.slug
    return redirect('room_group', slug=dm.slug)


@login_required
def get_or_create_dm_api(request, user_id):
    if request.method != 'POST':
        return JsonResponse({'ok': False}, status=405)
    if user_id == request.user.id:
        return JsonResponse({'ok': False, 'error': 'Cannot DM yourself'}, status=400)

    from django.contrib.auth import get_user_model
    User = get_user_model()
    target_user = get_object_or_404(User, pk=user_id)

    existing_dm = ChatGroup.objects.filter(is_dm=True, members=request.user).filter(members=target_user).first()
    if existing_dm:
        dm = existing_dm
    else:
        dm = ChatGroup.objects.create(name='DM', is_dm=True, owner=request.user)
        dm.members.add(request.user, target_user)

    raw_messages = (
        ChatMessage.objects.filter(group=dm)
        .select_related('sender')
        .order_by('created_at')[:50]
    )
    messages_data = [
        {
            'id': m.id,
            'sender': m.sender.username,
            'sender_id': m.sender_id,
            'content': m.content,
            'created_at': m.created_at.isoformat(),
        }
        for m in raw_messages
    ]

    return JsonResponse({
        'ok': True,
        'dm_slug': dm.slug,
        'target_username': target_user.username,
        'messages': messages_data,
    })

@login_required
def group_drops_api(request, slug):
    if request.method == 'GET':
        group = get_object_or_404(ChatGroup, slug=slug, members=request.user)
        drops = UserDrop.objects.filter(group=group)
        data = {}
        for drop in drops:
            data[drop.user_id] = {
                'message': drop.message,
                'file_url': drop.file.url if drop.file else None,
                'file_name': drop.file.name.split('/')[-1] if drop.file else None,
            }
        return JsonResponse({'ok': True, 'drops': data})
    elif request.method == 'POST':
        group = get_object_or_404(ChatGroup, slug=slug, members=request.user)
        drop, created = UserDrop.objects.get_or_create(user=request.user, group=group)
        if 'message' in request.POST:
            drop.message = request.POST['message']
        if 'file' in request.FILES:
            drop.file = request.FILES['file']
        elif request.POST.get('remove_file') == 'true':
            drop.file = None
        drop.save()
        return JsonResponse({'ok': True})
    return JsonResponse({'ok': False}, status=405)

@login_required
def user_drop_api(request, slug, user_id):
    if request.method == 'GET':
        group = get_object_or_404(ChatGroup, slug=slug, members=request.user)
        drop = UserDrop.objects.filter(user_id=user_id, group=group).first()
        if drop:
            return JsonResponse({
                'ok': True,
                'drop': {
                    'message': drop.message,
                    'file_url': drop.file.url if drop.file else None,
                    'file_name': drop.file.name.split('/')[-1] if drop.file else None,
                }
            })
        return JsonResponse({'ok': True, 'drop': None})
    return JsonResponse({'ok': False}, status=405)
