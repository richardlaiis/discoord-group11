import math

from django.core.cache import cache
from django.utils import timezone

from .models import ChatGroupMembership


PRESENCE_TIMEOUT = 120
POSITION_MIN = 6.0
POSITION_MAX = 94.0
MOVE_STEP_LIMIT = 3.0
POSITION_PERSIST_INTERVAL = 0.8


def _presence_key(group_slug):
    return f'chat:presence:{group_slug}'


def _clamp(value, minimum, maximum):
    return max(minimum, min(maximum, value))


def _to_float(value, fallback):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _spawn_position_for_user(presence, user_id):
    numeric = int(user_id)
    x = 15.0 + ((numeric * 37) % 70)
    y = 15.0 + ((numeric * 53) % 70)
    x = _clamp(x, POSITION_MIN, POSITION_MAX)
    y = _clamp(y, POSITION_MIN, POSITION_MAX)

    return x, y


def _cleanup_presence(presence):
    cutoff = timezone.now().timestamp() - PRESENCE_TIMEOUT
    cleaned = {}
    for user_id, record in presence.items():
        if record.get('count', 0) > 0 and record.get('last_seen', 0.0) >= cutoff:
            cleaned[user_id] = record
    return cleaned


def _load_presence(group_slug):
    return cache.get(_presence_key(group_slug), {})


def _store_presence(group_slug, presence):
    cache.set(_presence_key(group_slug), presence, timeout=PRESENCE_TIMEOUT)


def _load_member_position(group_slug, user_id):
    membership = (
        ChatGroupMembership.objects
        .filter(group__slug=group_slug, user_id=user_id)
        .only('position_x', 'position_y')
        .first()
    )
    if not membership:
        return None
    return (
        _clamp(_to_float(membership.position_x, 50.0), POSITION_MIN, POSITION_MAX),
        _clamp(_to_float(membership.position_y, 50.0), POSITION_MIN, POSITION_MAX),
    )


def _save_member_position(group_slug, user_id, x, y):
    ChatGroupMembership.objects.filter(group__slug=group_slug, user_id=user_id).update(
        position_x=_clamp(_to_float(x, 50.0), POSITION_MIN, POSITION_MAX),
        position_y=_clamp(_to_float(y, 50.0), POSITION_MIN, POSITION_MAX),
    )


def mark_member_online(group_slug, user):
    presence = _load_presence(group_slug)
    user_id = str(user.id)
    record = presence.get(user_id, {'username': user.username, 'count': 0, 'last_seen': 0.0})

    if 'x' not in record or 'y' not in record:
        saved_position = _load_member_position(group_slug, user.id)
        if saved_position:
            x, y = saved_position
            if _is_overlapping(x, y, presence, ignore_user_id=user_id):
                x, y = _spawn_position_for_user(presence, user.id)
        else:
            x, y = _spawn_position_for_user(presence, user.id)
        _save_member_position(group_slug, user.id, x, y)
        record['x'] = x
        record['y'] = y

    record['vx'] = _to_float(record.get('vx'), 0.0)
    record['vy'] = _to_float(record.get('vy'), 0.0)
    record['username'] = user.username
    record['count'] = record.get('count', 0) + 1
    record['last_seen'] = timezone.now().timestamp()
    record['position_saved_at'] = _to_float(record.get('position_saved_at'), 0.0)
    presence[user_id] = record
    _store_presence(group_slug, presence)
    return presence


def touch_member_online(group_slug, user):
    presence = _load_presence(group_slug)
    user_id = str(user.id)
    now = timezone.now().timestamp()

    record = presence.get(user_id, {'username': user.username, 'count': 1, 'last_seen': now})
    if 'x' not in record or 'y' not in record:
        saved_position = _load_member_position(group_slug, user.id)
        if saved_position:
            x, y = saved_position
        else:
            x, y = _spawn_position_for_user(presence, user.id)
            _save_member_position(group_slug, user.id, x, y)
        record['x'] = x
        record['y'] = y

    record['vx'] = _to_float(record.get('vx'), 0.0)
    record['vy'] = _to_float(record.get('vy'), 0.0)
    record['username'] = user.username
    record['count'] = max(1, int(record.get('count', 1)))
    record['last_seen'] = now
    record['position_saved_at'] = _to_float(record.get('position_saved_at'), 0.0)
    presence[user_id] = record
    _store_presence(group_slug, presence)
    return presence


def mark_member_offline(group_slug, user):
    presence = _load_presence(group_slug)
    user_id = str(user.id)
    record = presence.get(user_id)
    if not record:
        return presence

    if 'x' in record and 'y' in record:
        _save_member_position(group_slug, user.id, record['x'], record['y'])

    remaining = record.get('count', 0) - 1
    if remaining <= 0:
        presence.pop(user_id, None)
    else:
        record['count'] = remaining
        record['last_seen'] = timezone.now().timestamp()
        presence[user_id] = record

    _store_presence(group_slug, presence)
    return presence


def get_online_member_ids(group_slug):
    presence = _load_presence(group_slug)
    cleaned = _cleanup_presence(presence)
    online_ids = set()

    for user_id in cleaned.keys():
        online_ids.add(int(user_id))

    if cleaned != presence:
        _store_presence(group_slug, cleaned)

    return online_ids


def get_online_count(group_slug):
    return len(get_online_member_ids(group_slug))


def get_online_member_states(group_slug):
    presence = _load_presence(group_slug)
    cleaned = _cleanup_presence(presence)

    if cleaned != presence:
        _store_presence(group_slug, cleaned)

    states = {}
    for user_id, record in cleaned.items():
        states[int(user_id)] = {
            'user_id': int(user_id),
            'username': record.get('username', ''),
            'x': _clamp(_to_float(record.get('x'), 50.0), POSITION_MIN, POSITION_MAX),
            'y': _clamp(_to_float(record.get('y'), 50.0), POSITION_MIN, POSITION_MAX),
            'vx': _to_float(record.get('vx'), 0.0),
            'vy': _to_float(record.get('vy'), 0.0),
        }
    return states


def update_member_motion(group_slug, user, delta_x, delta_y):
    presence = _cleanup_presence(_load_presence(group_slug))
    user_id = str(user.id)
    now = timezone.now().timestamp()

    record = presence.get(user_id, {'username': user.username, 'count': 1, 'last_seen': now})
    if 'x' not in record or 'y' not in record:
        saved_position = _load_member_position(group_slug, user.id)
        if saved_position:
            x, y = saved_position
        else:
            x, y = _spawn_position_for_user(presence, user.id)
        record['x'] = x
        record['y'] = y

    dx = _clamp(_to_float(delta_x, 0.0), -MOVE_STEP_LIMIT, MOVE_STEP_LIMIT)
    dy = _clamp(_to_float(delta_y, 0.0), -MOVE_STEP_LIMIT, MOVE_STEP_LIMIT)

    next_x = _clamp(_to_float(record.get('x'), 50.0) + dx, POSITION_MIN, POSITION_MAX)
    next_y = _clamp(_to_float(record.get('y'), 50.0) + dy, POSITION_MIN, POSITION_MAX)

    record['x'] = next_x
    record['y'] = next_y
    record['vx'] = dx
    record['vy'] = dy
    record['username'] = user.username
    record['count'] = max(1, int(record.get('count', 1)))
    record['last_seen'] = now
    last_saved_at = _to_float(record.get('position_saved_at'), 0.0)
    should_persist = (now - last_saved_at) >= POSITION_PERSIST_INTERVAL
    if should_persist:
        record['position_saved_at'] = now
    presence[user_id] = record

    _store_presence(group_slug, presence)
    if should_persist:
        _save_member_position(group_slug, user.id, next_x, next_y)

    return {
        'user_id': user.id,
        'username': user.username,
        'x': next_x,
        'y': next_y,
        'vx': dx,
        'vy': dy,
    }