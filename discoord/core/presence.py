from django.core.cache import cache
from django.utils import timezone


PRESENCE_TIMEOUT = 120


def _presence_key(group_slug):
    return f'chat:presence:{group_slug}'


def _load_presence(group_slug):
    return cache.get(_presence_key(group_slug), {})


def _store_presence(group_slug, presence):
    cache.set(_presence_key(group_slug), presence, timeout=PRESENCE_TIMEOUT)


def mark_member_online(group_slug, user):
    presence = _load_presence(group_slug)
    record = presence.get(str(user.id), {'username': user.username, 'count': 0, 'last_seen': 0.0})
    record['username'] = user.username
    record['count'] = record.get('count', 0) + 1
    record['last_seen'] = timezone.now().timestamp()
    presence[str(user.id)] = record
    _store_presence(group_slug, presence)
    return presence


def mark_member_offline(group_slug, user):
    presence = _load_presence(group_slug)
    record = presence.get(str(user.id))
    if not record:
        return presence

    remaining = record.get('count', 0) - 1
    if remaining <= 0:
        presence.pop(str(user.id), None)
    else:
        record['count'] = remaining
        record['last_seen'] = timezone.now().timestamp()
        presence[str(user.id)] = record

    _store_presence(group_slug, presence)
    return presence


def get_online_member_ids(group_slug):
    presence = _load_presence(group_slug)
    cutoff = timezone.now().timestamp() - PRESENCE_TIMEOUT
    cleaned = {}
    online_ids = set()

    for user_id, record in presence.items():
        if record.get('count', 0) > 0 and record.get('last_seen', 0.0) >= cutoff:
            cleaned[user_id] = record
            online_ids.add(int(user_id))

    if cleaned != presence:
        _store_presence(group_slug, cleaned)

    return online_ids


def get_online_count(group_slug):
    return len(get_online_member_ids(group_slug))