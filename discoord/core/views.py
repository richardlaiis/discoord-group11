from django.contrib import messages
from django.contrib.auth import login
from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer

from .forms import ChatGroupCreateForm, ChatGroupJoinForm, RegistrationForm
from .models import ChatGroup, ChatMessage
from .presence import get_online_member_ids


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


@login_required
def room_view(request, slug=None):
    groups = (
        ChatGroup.objects.filter(members=request.user)
        .prefetch_related('members')
        .select_related('owner')
    )
    active_group = _resolve_active_group(request, groups, slug=slug)
    chat_messages = []
    members = []
    online_member_ids = set()

    if active_group is not None:
        chat_messages = (
            ChatMessage.objects.filter(group=active_group)
            .select_related('sender')
            .order_by('created_at')[:100]
        )
        members = active_group.members.all().order_by('username')
        online_member_ids = get_online_member_ids(active_group.slug)

    context = {
        'groups': groups,
        'active_group': active_group,
        'chat_messages': chat_messages,
        'members': members,
        'online_member_ids': online_member_ids,
        'create_group_form': ChatGroupCreateForm(),
        'join_group_form': ChatGroupJoinForm(),
    }
    return render(request, 'room.html', context)


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

    return JsonResponse({'ok': True, 'message': payload})


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
