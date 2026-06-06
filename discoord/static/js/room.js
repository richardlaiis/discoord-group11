/* jshint esversion: 6 */
/* globals activeGroupSlug, moveFallbackUrl, roomStateUrl, currentUserId */

const MOVE_STEP = 1.5;
const KEY_TO_VECTOR = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    w: [0, -1],
    a: [-1, 0],
    s: [0, 1],
    d: [1, 0],
};

const activeKeys = new Set();
const avatarByUserId = new Map();
const avatarCanvasByUserId = new Map();
let moveRequestInFlight = false;
let lastFallbackMoveAt = 0;
let statePollHandle = null;
const profilePopover = document.getElementById('profile-popover');
const profileAvatar = document.getElementById('profile-avatar');
const profileDisplayName = document.getElementById('profile-display-name');
const profileUsername = document.getElementById('profile-username');
const profileStatusMode = document.getElementById('profile-status-mode');
const profileStatusText = document.getElementById('profile-status-text');
const profileFields = document.getElementById('profile-fields');
const profileEditForm = document.getElementById('profile-edit-form');
const profileEditBtn = document.getElementById('profile-edit-btn');
const profileActions = document.getElementById('profile-actions');
const profileActionsOther = document.getElementById('profile-actions-other');
const profileCloseBtn = document.getElementById('profile-close-btn');
let activeProfileUserId = null;
let activeProfileAnchor = null;
let activeProfileData = null;
let profileEditMode = false;

const dmOverlay = document.getElementById('dm-overlay');
const dmOverlayAvatar = document.getElementById('dm-overlay-avatar');
const dmOverlayTitle = document.getElementById('dm-overlay-title');
const dmOverlayMessages = document.getElementById('dm-overlay-messages');
const dmOverlayInput = document.getElementById('dm-overlay-input');
const dmOverlaySend = document.getElementById('dm-overlay-send');
const dmOverlayClose = document.getElementById('dm-overlay-close');
let dmSocket = null;
let currentDmSlug = null;

function ensureAvatarElement(userId, username) {
    let avatar = avatarByUserId.get(userId);
    if (avatar) {
        return avatar;
    }

    avatar = document.querySelector(`.space-avatar[data-user-id="${userId}"]`);
    if (!avatar) {
        const mainArea = document.querySelector('.main-area');
        if (!mainArea) {
            return null;
        }

        avatar = document.createElement('div');
        avatar.className = 'space-avatar member-avatar';
        avatar.dataset.userId = String(userId);
        avatar.style.left = '50%';
        avatar.style.top = '50%';
        mainArea.prepend(avatar);
    }

    avatar.dataset.username = avatar.dataset.username || username || `User ${userId}`;
    avatar.title = avatar.dataset.username;
    avatar.textContent = avatar.dataset.username.charAt(0).toUpperCase();
    if (Number(userId) === currentUserId) {
        avatar.classList.add('is-self');
    }

    avatarByUserId.set(Number(userId), avatar);
    // ensure canvas is created for the avatar
    ensureAvatarCanvas(avatar);
    return avatar;
}

function ensureAvatarCanvas(avatar) {
    try {
        const userId = Number(avatar.dataset.userId || -1);
        if (avatarCanvasByUserId.has(userId)) return avatarCanvasByUserId.get(userId);

        // create canvas that fills the avatar element
        const canvas = document.createElement('canvas');
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        canvas.style.pointerEvents = 'none';
        canvas.className = 'avatar-canvas';

        // set default size via CSS-ish fallback

        // canvas size (smaller overall avatar requested)
        const size = 84;
        const dpr = devicePixelRatio || 1;
        canvas.width = size * dpr;
        canvas.height = size * dpr;
        canvas.style.width = `${size}px`;
        canvas.style.height = `${size}px`;
        canvas.style.border = 'none';

        avatar.style.width = `${size}px`;
        avatar.style.height = `${size}px`;
        avatar.style.display = 'flex';
        avatar.style.flexDirection = 'column';
        avatar.style.alignItems = 'center';
        avatar.style.justifyContent = 'center';
        avatar.style.borderRadius = '50%';
        avatar.style.overflow = 'visible';

        // preserve title attribute for external name display (via CSS ::after)
        const titleText = avatar.dataset.username || avatar.getAttribute('title') || '';
        // remove child nodes but keep attributes
        while (avatar.firstChild) avatar.removeChild(avatar.firstChild);
        avatar.title = titleText;
        // append only the canvas; external name shown by CSS ::after
        avatar.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        avatarCanvasByUserId.set(userId, { canvas, ctx, size });
        // initial draw
        drawAvatarForElement(avatar);
        return { canvas, ctx, size };
    } catch (e) {
        return null;
    }
}

let lastMousePos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
let pendingFrame = false;

function onGlobalMouseMove(e) {
    lastMousePos = { x: e.clientX, y: e.clientY };
    requestAvatarFrame();
}

function requestAvatarFrame() {
    if (pendingFrame) return;
    pendingFrame = true;
    window.requestAnimationFrame(() => {
        pendingFrame = false;
        // only redraw the current user's avatar on mouse move
        const selfAvatar = avatarByUserId.get(Number(currentUserId));
        if (selfAvatar) drawAvatarForElement(selfAvatar);
    });
}

function redrawAllAvatars() {
    avatarByUserId.forEach((avatar, userId) => {
        drawAvatarForElement(avatar);
    });
}

function drawAvatarForElement(avatar) {
    const userId = Number(avatar.dataset.userId || -1);
    const info = avatarCanvasByUserId.get(userId);
    if (!info) return;
    const { canvas, ctx, size } = info;
    // handle DPR
    const dpr = devicePixelRatio || 1;
    if (canvas.width !== size * dpr || canvas.height !== size * dpr) {
        canvas.width = size * dpr;
        canvas.height = size * dpr;
    }
    ctx.setTransform(1,0,0,1,0,0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size, size);

    const rect = avatar.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // determine angle: self uses mouse, others use remote angle from dataset or vx/vy
    let ang = 0;
    const uid = Number(avatar.dataset.userId || -1);
    if (uid === Number(currentUserId)) {
        ang = Math.atan2(lastMousePos.y - centerY, lastMousePos.x - centerX);
    } else if (typeof avatar.dataset.remoteAngle !== 'undefined' && avatar.dataset.remoteAngle !== '') {
        ang = Number(avatar.dataset.remoteAngle) || 0;
    } else if (typeof avatar.dataset.remoteVx !== 'undefined' && typeof avatar.dataset.remoteVy !== 'undefined') {
        const rvx = Number(avatar.dataset.remoteVx) || 0;
        const rvy = Number(avatar.dataset.remoteVy) || 0;
        if (rvx !== 0 || rvy !== 0) {
            ang = Math.atan2(rvy, rvx);
        }
    } else {
        ang = 0;
    }

    // draw body and hands oriented towards ang (hands placed in front)
    const cx = size / 2;
    const cy = size / 2;
    const bodyR = Math.min(size, size) * 0.34;
    // skin and stroke
    const skin = getComputedStyle(document.documentElement).getPropertyValue('--avatar-skin') || '#f1c27d';
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);


    // draw smaller hands and place them forward (positive X after rotation)
    // hands closer to the body and slightly smaller
    const handR = bodyR * 0.22;
    const handOffsetX = bodyR * 0.95; // near the body
    const handOffsetY = bodyR * 0.42;

    // left hand (slightly up)
    ctx.beginPath();
    ctx.fillStyle = skin.trim();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.arc(handOffsetX, -handOffsetY, handR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // right hand (slightly down)
    ctx.beginPath();
    ctx.arc(handOffsetX, handOffsetY, handR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // draw body (center)
    ctx.beginPath();
    ctx.arc(0, 0, bodyR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.restore();
}

// attach global mouse move
document.addEventListener('mousemove', onGlobalMouseMove);

function profileUrl(userId) {
    if (!activeGroupSlug) {
        return null;
    }
    return `/groups/${activeGroupSlug}/members/${userId}/profile/`;
}

function setPopoverOpen(open) {
    if (!profilePopover) {
        return;
    }
    profilePopover.classList.toggle('is-open', open);
    profilePopover.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (!open) {
        activeProfileUserId = null;
        activeProfileAnchor = null;
        activeProfileData = null;
        profileEditMode = false;
    }
}

function setStatusModeClass(mode) {
    if (!profileStatusMode) {
        return;
    }
    const normalized = mode || 'online';
    profileStatusMode.classList.remove('status-mode-online', 'status-mode-idle', 'status-mode-dnd', 'status-mode-invisible');
    profileStatusMode.classList.add(`status-mode-${normalized}`);
    profileStatusMode.textContent = normalized.replace(/^(.)/, (m) => m.toUpperCase());
}

function updateDisplayNameForUser(userId, displayName, username) {
    const safeName = displayName || username || 'User';
    document.querySelectorAll(`.member-row[data-user-id="${userId}"]`).forEach((row) => {
        row.dataset.username = safeName;
        const nameNode = row.querySelector('.user-name');
        if (nameNode) {
            nameNode.textContent = safeName;
        }
        const avatar = row.querySelector('.avatar');
        if (avatar) {
            while (avatar.firstChild) {
                avatar.removeChild(avatar.firstChild);
            }
            avatar.textContent = safeName.charAt(0).toUpperCase();
        }
    });

    const spaceAvatar = document.querySelector(`.space-avatar[data-user-id="${userId}"]`);
    if (spaceAvatar) {
        spaceAvatar.dataset.username = safeName;
        spaceAvatar.title = safeName;
        // if avatar uses canvas, don't set inner text (avoid duplicate names)
        const hasCanvas = Boolean(spaceAvatar.querySelector('canvas'));
        if (!hasCanvas) {
            spaceAvatar.textContent = safeName.charAt(0).toUpperCase();
        }
    }

    if (Number(userId) === currentUserId) {
        const profileBar = document.querySelector('.user-profile-bar .user-name');
        if (profileBar) {
            profileBar.textContent = safeName;
        }
    }
}

function renderProfile(profile) {
    if (!profile) {
        return;
    }
    const displayName = profile.display_name || profile.username || 'User';
    if (profileDisplayName) {
        profileDisplayName.textContent = displayName;
    }
    if (profileUsername) {
        profileUsername.textContent = profile.username ? `@${profile.username}` : '';
    }
    if (profileAvatar) {
        profileAvatar.textContent = displayName.charAt(0).toUpperCase();
    }
    if (profileStatusText) {
        profileStatusText.textContent = profile.status_text || 'No status set';
    }
    setStatusModeClass(profile.status_mode || 'online');

    if (profileFields) {
        profileFields.querySelectorAll('[data-field]').forEach((node) => {
            const field = node.dataset.field;
            node.textContent = profile[field] ? profile[field] : '—';
        });
    }

    if (profileEditForm) {
        profileEditForm.display_name.value = profile.display_name || '';
        profileEditForm.pronouns.value = profile.pronouns || '';
        profileEditForm.status_text.value = profile.status_text || '';
        profileEditForm.status_mode.value = profile.status_mode || 'online';
        profileEditForm.bio.value = profile.bio || '';
    }

    const isSelf = Boolean(profile.is_self);
    if (profileActions) {
        profileActions.style.display = isSelf ? 'flex' : 'none';
    }
    if (profileActionsOther) {
        profileActionsOther.style.display = isSelf ? 'none' : 'flex';
    }
    if (profileEditForm) {
        profileEditForm.style.display = isSelf && profileEditMode ? 'grid' : 'none';
    }
    if (profileFields) {
        profileFields.style.display = isSelf && profileEditMode ? 'none' : 'grid';
    }
    updateDisplayNameForUser(profile.user_id, profile.display_name, profile.username);
}

function positionPopover(anchorRect) {
    if (!profilePopover || !anchorRect) {
        return;
    }
    const margin = 12;
    const popoverWidth = profilePopover.offsetWidth;
    const popoverHeight = profilePopover.offsetHeight;
    let left = anchorRect.right + 12;
    if (left + popoverWidth + margin > window.innerWidth) {
        left = anchorRect.left - popoverWidth - 12;
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - popoverWidth - margin));
    let top = anchorRect.top + (anchorRect.height / 2) - (popoverHeight / 2);
    top = Math.max(margin, Math.min(top, window.innerHeight - popoverHeight - margin));
    profilePopover.style.left = `${left}px`;
    profilePopover.style.top = `${top}px`;
}

function showProfilePopover(anchor, userId, usernameFallback) {
    const url = profileUrl(userId);
    if (!url || !profilePopover) {
        return;
    }
    activeProfileUserId = userId;
    activeProfileAnchor = anchor;
    activeProfileData = {
        username: usernameFallback || 'User',
        display_name: '',
        pronouns: '',
        bio: '',
        status_text: '',
        status_mode: 'online',
        is_self: userId === currentUserId,
    };
    renderProfile(activeProfileData);
    setPopoverOpen(true);
    positionPopover(anchor.getBoundingClientRect());

    fetch(url, {
        method: 'GET',
        headers: {
            'X-Requested-With': 'XMLHttpRequest',
        },
    }).then(async (response) => {
        if (!response.ok) {
            throw new Error('profile-load-failed');
        }
        return response.json();
    }).then((payload) => {
        if (!payload || !payload.ok || !payload.profile) {
            return;
        }
        if (activeProfileUserId !== userId) {
            return;
        }
        activeProfileData = payload.profile;
        renderProfile(activeProfileData);
        positionPopover(anchor.getBoundingClientRect());
    }).catch(() => {
        // Keep the placeholder profile visible if load fails.
    });
}

function applyMemberState(memberState) {
    if (!memberState || typeof memberState.user_id === 'undefined') {
        return;
    }

    const userId = Number(memberState.user_id);
    const avatar = ensureAvatarElement(userId, memberState.username || '');
    if (!avatar) {
        return;
    }

    if (typeof memberState.x === 'number') {
        avatar.style.left = `${memberState.x}%`;
    }
    if (typeof memberState.y === 'number') {
        avatar.style.top = `${memberState.y}%`;
    }

    const speed = Math.hypot(Number(memberState.vx || 0), Number(memberState.vy || 0));
    avatar.classList.toggle('is-moving', speed > 0.04);
    // redraw avatar canvas to keep orientation consistent after movement
    // store remote motion/angle for non-self avatars so draw uses WebSocket data
    if (Number(userId) !== Number(currentUserId)) {
        if (typeof memberState.angle !== 'undefined') {
            avatar.dataset.remoteAngle = String(Number(memberState.angle));
        } else {
            avatar.dataset.remoteVx = String(Number(memberState.vx || 0));
            avatar.dataset.remoteVy = String(Number(memberState.vy || 0));
        }
    }
    drawAvatarForElement(avatar);
}

function syncMemberStates(memberStates) {
    Object.values(memberStates || {}).forEach((state) => {
        applyMemberState(state);
    });
}

function initializeAvatars() {
    document.querySelectorAll('.space-avatar[data-user-id]').forEach((avatar) => {
        const userId = Number(avatar.dataset.userId);
        avatarByUserId.set(userId, avatar);
        if (userId === currentUserId) {
            avatar.classList.add('is-self');
        }
        // ensure canvas exists for avatars present on load
        ensureAvatarCanvas(avatar);
    });
}

function switchTab(event, tabName) {
    document.querySelectorAll('.tab-btn').forEach((btn) => btn.classList.remove('active'));
    event.currentTarget.classList.add('active');

    const chatTab = document.getElementById('chat-tab');
    const blackboardTab = document.getElementById('blackboard-tab');
    if (tabName === 'chat') {
        chatTab.style.display = 'flex';
        blackboardTab.style.display = 'none';
        return;
    }

    chatTab.style.display = 'none';
    blackboardTab.style.display = 'block';
}

function formatTime(isoString) {
    return new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Asia/Taipei',
    }).format(new Date(isoString));
}

function appendMessage(message) {
    const messageList = document.getElementById('message-list');
    const emptyState = document.getElementById('message-empty');
    if (emptyState) {
        emptyState.remove();
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'message';
    wrapper.dataset.messageId = message.id;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = message.sender.charAt(0).toUpperCase();

    const messageContent = document.createElement('div');
    messageContent.className = 'message-content';

    const header = document.createElement('div');
    header.className = 'message-header';

    const author = document.createElement('span');
    author.className = 'message-author';
    if (message.is_me || message.sender_id === currentUserId) {
        author.style.color = 'var(--accent-primary)';
    }
    author.textContent = message.sender;

    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = formatTime(message.created_at);

    const text = document.createElement('div');
    text.className = 'message-text';
    text.textContent = message.content;

    header.appendChild(author);
    header.appendChild(time);
    messageContent.appendChild(header);
    messageContent.appendChild(text);
    wrapper.appendChild(avatar);
    wrapper.appendChild(messageContent);
    messageList.appendChild(wrapper);
    messageList.closest('.chat-messages').scrollTop = messageList.closest('.chat-messages').scrollHeight;
}

function updatePresence(onlineMemberIds) {
    const onlineIds = new Set(onlineMemberIds);
    document.querySelectorAll('.member-row').forEach((row) => {
        const userId = Number(row.dataset.userId);
        const isOnline = onlineIds.has(userId);
        row.dataset.online = String(isOnline);
        const pill = row.querySelector('.presence-pill');
        if (pill) {
            pill.textContent = isOnline ? 'Online' : 'Offline';
            pill.classList.toggle('online', isOnline);
        }
    });

    const roomOnlineCount = document.getElementById('room-online-count');
    if (roomOnlineCount) {
        const total = Number(roomOnlineCount.dataset.total) || document.querySelectorAll('.member-row').length || 0;
        roomOnlineCount.textContent = `${onlineIds.size}/${total} online`;
    }

    avatarByUserId.forEach((avatar, userId) => {
        avatar.classList.toggle('is-online', onlineIds.has(userId));
    });
}

const socket = activeGroupSlug ? new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws/chat/${activeGroupSlug}/`) : null;

function getCsrfToken() {
    const field = document.querySelector('input[name="csrfmiddlewaretoken"]');
    return field ? field.value : '';
}

if (profileCloseBtn) {
    profileCloseBtn.addEventListener('click', () => setPopoverOpen(false));
}

function appendDmMessage(message) {
    if (!dmOverlayMessages) {
        return;
    }
    if (message.id && dmOverlayMessages.querySelector(`[data-message-id="${message.id}"]`)) {
        return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'message';
    if (message.id) {
        wrapper.dataset.messageId = message.id;
    }
    const avatarEl = document.createElement('div');
    avatarEl.className = 'avatar';
    avatarEl.textContent = message.sender.charAt(0).toUpperCase();
    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';
    const header = document.createElement('div');
    header.className = 'message-header';
    const author = document.createElement('span');
    author.className = 'message-author';
    if (message.sender_id === currentUserId) {
        author.style.color = 'var(--accent-primary)';
    }
    author.textContent = message.sender;
    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = formatTime(message.created_at);
    const text = document.createElement('div');
    text.className = 'message-text';
    text.textContent = message.content;
    header.appendChild(author);
    header.appendChild(time);
    contentEl.appendChild(header);
    contentEl.appendChild(text);
    wrapper.appendChild(avatarEl);
    wrapper.appendChild(contentEl);
    dmOverlayMessages.appendChild(wrapper);
    dmOverlayMessages.scrollTop = dmOverlayMessages.scrollHeight;
}

function openDmOverlay(userId, username, dmSlug, initialMessages) {
    if (!dmOverlay) {
        return;
    }
    if (dmSocket && currentDmSlug !== dmSlug) {
        dmSocket.close();
        dmSocket = null;
    }
    currentDmSlug = dmSlug;
    if (dmOverlayAvatar) {
        dmOverlayAvatar.textContent = username.charAt(0).toUpperCase();
    }
    if (dmOverlayTitle) {
        dmOverlayTitle.textContent = username;
    }
    if (dmOverlayMessages) {
        dmOverlayMessages.innerHTML = '';
        initialMessages.forEach(appendDmMessage);
    }
    dmOverlay.classList.add('is-open');
    dmOverlay.setAttribute('aria-hidden', 'false');
    if (!dmSocket || dmSocket.readyState === WebSocket.CLOSED) {
        const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        dmSocket = new WebSocket(`${wsProto}://${window.location.host}/ws/chat/${dmSlug}/`);
        dmSocket.addEventListener('message', (event) => {
            const payload = JSON.parse(event.data);
            if (payload.type === 'message') {
                appendDmMessage(payload.message);
            }
        });
    }
    if (dmOverlayInput) {
        dmOverlayInput.focus();
    }
}

function closeDmOverlay() {
    if (dmOverlay) {
        dmOverlay.classList.remove('is-open');
        dmOverlay.setAttribute('aria-hidden', 'true');
    }
    if (dmSocket) {
        dmSocket.close();
        dmSocket = null;
    }
    currentDmSlug = null;
}

function sendDmMessage() {
    if (!currentDmSlug || !dmOverlayInput) {
        return;
    }
    const content = dmOverlayInput.value.trim();
    if (!content) {
        return;
    }
    fetch(`/groups/${currentDmSlug}/messages/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-CSRFToken': getCsrfToken(),
        },
        body: new URLSearchParams({ content }),
    }).then(async (response) => {
        if (!response.ok) {
            throw new Error('dm-send-failed');
        }
        dmOverlayInput.value = '';
        dmOverlayInput.focus();
    }).catch(() => {
        if (dmSocket && dmSocket.readyState === WebSocket.OPEN) {
            dmSocket.send(JSON.stringify({ type: 'message', content }));
            dmOverlayInput.value = '';
            dmOverlayInput.focus();
        }
    });
}

const profileDmBtn = document.getElementById('profile-dm-btn');
if (profileDmBtn) {
    profileDmBtn.addEventListener('click', () => {
        if (!activeProfileUserId) {
            return;
        }
        const userId = activeProfileUserId;
        const username = (activeProfileData && (activeProfileData.display_name || activeProfileData.username)) || 'User';
        fetch(`/api/dm/${userId}/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRFToken': getCsrfToken(),
            },
        }).then((r) => r.json()).then((payload) => {
            if (!payload.ok) {
                return;
            }
            setPopoverOpen(false);
            openDmOverlay(userId, payload.target_username || username, payload.dm_slug, payload.messages || []);
        }).catch(() => {});
    });
}

if (dmOverlayClose) {
    dmOverlayClose.addEventListener('click', closeDmOverlay);
}

if (dmOverlaySend) {
    dmOverlaySend.addEventListener('click', sendDmMessage);
}

if (dmOverlayInput) {
    dmOverlayInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendDmMessage();
        }
    });
}

if (profileEditBtn && profileEditForm) {
    profileEditBtn.addEventListener('click', () => {
        profileEditMode = true;
        renderProfile(activeProfileData);
        if (activeProfileAnchor) {
            setTimeout(() => {
                positionPopover(activeProfileAnchor.getBoundingClientRect());
            }, 50);
        }
    });

    profileEditForm.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!activeProfileUserId) {
            return;
        }
        const url = profileUrl(activeProfileUserId);
        if (!url) {
            return;
        }
        const formData = new FormData(profileEditForm);
        fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRFToken': getCsrfToken(),
            },
            body: new URLSearchParams(formData),
        }).then(async (response) => {
            if (!response.ok) {
                throw new Error('profile-save-failed');
            }
            return response.json();
        }).then((payload) => {
            if (!payload || !payload.ok || !payload.profile) {
                return;
            }
            activeProfileData = payload.profile;
            profileEditMode = false;
            renderProfile(activeProfileData);
            if (activeProfileAnchor) {
                setTimeout(() => {
                    positionPopover(activeProfileAnchor.getBoundingClientRect());
                }, 50);
            }
        }).catch(() => {
            // Keep edit mode if save fails.
        });
    });
}

if (socket) {
    socket.addEventListener('open', () => {
        stopStatePolling();
    });

    socket.addEventListener('message', (event) => {
        const payload = JSON.parse(event.data);
        if (payload.type === 'message') {
            appendMessage(payload.message);
        } else if (payload.type === 'presence') {
            updatePresence(payload.online_member_ids);
            syncMemberStates(payload.member_states || {});
        } else if (payload.type === 'state') {
            updatePresence(payload.online_member_ids || []);
            syncMemberStates(payload.member_states || {});
        } else if (payload.type === 'motion') {
            applyMemberState(payload.member);
        } else if (payload.type === 'blackboard_update') {
            const container = document.getElementById('blackboard-notes');
            if (container && payload.html) {
                container.innerHTML = payload.html;
            } else if (activeGroupSlug) {
                fetch(`/groups/${activeGroupSlug}/notes/fragment/`)
                    .then(r => r.text())
                    .then(html => {
                        if (container) {
                            container.innerHTML = html;
                        }
                    })
                    .catch(err => console.error('Blackboard reload failed:', err));
            }
        }
    });

    socket.addEventListener('close', () => {
        const status = document.querySelector('.sidebar-header .presence-pill');
        if (status) {
            status.textContent = 'Offline';
            status.classList.remove('online');
        }
        startStatePolling();
    });

    const form = document.getElementById('chat-form');
    const input = document.getElementById('chat-input');
    if (form && input) {
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            const content = input.value.trim();
            if (!content) {
                return;
            }

            fetch(form.action, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-CSRFToken': getCsrfToken(),
                },
                body: new URLSearchParams({ content }),
            }).then(async (response) => {
                if (!response.ok) {
                    throw new Error('message-send-failed');
                }
                const payload = await response.json();
                input.value = '';
                input.focus();
                if (!socket || socket.readyState !== WebSocket.OPEN) {
                    appendMessage(payload.message);
                }
            }).catch(() => {
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'message', content }));
                    input.value = '';
                    input.focus();
                }
            });
        });
    }

} else {
    startStatePolling();
}

function stopStatePolling() {
    if (statePollHandle) {
        window.clearTimeout(statePollHandle);
        statePollHandle = null;
    }
}

function scheduleStatePolling(delayMs = 700) {
    stopStatePolling();
    statePollHandle = window.setTimeout(pollRoomState, delayMs);
}

function pollRoomState() {
    if (!roomStateUrl) {
        return;
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
        return;
    }

    fetch(roomStateUrl, {
        method: 'GET',
        headers: {
            'X-Requested-With': 'XMLHttpRequest',
        },
    }).then(async (response) => {
        if (!response.ok) {
            throw new Error('room-state-poll-failed');
        }
        const payload = await response.json();
        if (!payload || !payload.ok) {
            return;
        }
        updatePresence(payload.online_member_ids || []);
        syncMemberStates(payload.member_states || {});
    }).catch(() => {
        // Keep polling even when request fails.
    }).finally(() => {
        scheduleStatePolling(700);
    });
}

function startStatePolling() {
    if (statePollHandle) {
        return;
    }
    scheduleStatePolling(120);
}

function isTypingTarget(target) {
    if (!target) {
        return false;
    }
    const tagName = (target.tagName || '').toLowerCase();
    return tagName === 'input' || tagName === 'textarea' || target.isContentEditable;
}

function calculateMovementVector() {
    let totalX = 0;
    let totalY = 0;
    activeKeys.forEach((key) => {
        const vector = KEY_TO_VECTOR[key];
        if (!vector) {
            return;
        }
        totalX += vector[0];
        totalY += vector[1];
    });

    if (totalX === 0 && totalY === 0) {
        return null;
    }

    const magnitude = Math.hypot(totalX, totalY);
    return {
        dx: Number(((totalX / magnitude) * MOVE_STEP).toFixed(3)),
        dy: Number(((totalY / magnitude) * MOVE_STEP).toFixed(3)),
    };
}

let movementLoopHandle = null;

function movementTick() {
    const vector = calculateMovementVector();
    if (vector) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'move',
                dx: vector.dx,
                dy: vector.dy,
            }));
        } else if (moveFallbackUrl && !moveRequestInFlight && (Date.now() - lastFallbackMoveAt) >= 140) {
            moveRequestInFlight = true;
            lastFallbackMoveAt = Date.now();
            fetch(moveFallbackUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-CSRFToken': getCsrfToken(),
                },
                body: new URLSearchParams({ dx: String(vector.dx), dy: String(vector.dy) }),
            }).then(async (response) => {
                if (!response.ok) {
                    throw new Error('move-fallback-failed');
                }
                const payload = await response.json();
                if (payload && payload.member) {
                    applyMemberState(payload.member);
                }
            }).catch(() => {
                // Keep movement loop running even if fallback request fails.
            }).finally(() => {
                moveRequestInFlight = false;
            });
        }
    }

    movementLoopHandle = window.setTimeout(movementTick, 80);
}

function normalizeKey(eventKey) {
    if (!eventKey) {
        return '';
    }
    if (eventKey.startsWith('Arrow')) {
        return eventKey;
    }
    return eventKey.toLowerCase();
}

document.addEventListener('keydown', (event) => {
    if (isTypingTarget(event.target)) {
        return;
    }

    const key = normalizeKey(event.key);
    if (!(key in KEY_TO_VECTOR)) {
        return;
    }

    event.preventDefault();
    activeKeys.add(key);
});

document.addEventListener('keyup', (event) => {
    if (isTypingTarget(event.target)) {
        return;
    }

    const key = normalizeKey(event.key);
    if (!(key in KEY_TO_VECTOR)) {
        return;
    }

    event.preventDefault();
    activeKeys.delete(key);
});

window.addEventListener('blur', () => {
    activeKeys.clear();
});

document.addEventListener('click', (event) => {
    const avatar = event.target.closest('.space-avatar[data-user-id], .member-row[data-user-id]');
    if (avatar) {
        const userId = Number(avatar.dataset.userId);
        const username = avatar.dataset.username || avatar.getAttribute('title') || '';
        showProfilePopover(avatar, userId, username);
        return;
    }

    if (profilePopover && profilePopover.contains(event.target)) {
        return;
    }

    if (profilePopover && profilePopover.classList.contains('is-open')) {
        setPopoverOpen(false);
    }
});

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && profilePopover && profilePopover.classList.contains('is-open')) {
        setPopoverOpen(false);
    }
});

window.addEventListener('resize', () => {
    if (profilePopover && profilePopover.classList.contains('is-open') && activeProfileAnchor) {
        positionPopover(activeProfileAnchor.getBoundingClientRect());
    }
});

document.getElementById('blackboard-tab').style.display = 'none';
initializeAvatars();
movementTick();
document.querySelectorAll('.member-row').forEach((row) => {
    row.dataset.online = row.dataset.online || 'false';
});

document.body.addEventListener('htmx:afterSwap', (event) => {
    if (event.target && event.target.id === 'message-list') {
        const container = event.target.closest('.chat-messages');
        if (container) {
            container.scrollTop = container.scrollHeight;
        }
    }
});

// Sidebar collapse / expand and tab switching
(function() {
    const app = document.querySelector('.app-container');
    const sidebar = document.querySelector('.sidebar');
    const collapseBtn = document.getElementById('sidebar-collapse-btn');
    const expandBtn = document.getElementById('sidebar-expand-btn');
    if (!app || !sidebar || !collapseBtn || !expandBtn) return;

    function setCollapsed(collapsed) {
        sidebar.classList.toggle('collapsed', collapsed);
        app.classList.toggle('sidebar-collapsed', collapsed);
        expandBtn.style.display = collapsed ? 'inline-flex' : 'none';
        try { localStorage.setItem('sidebar-collapsed', collapsed ? '1' : '0'); } catch (e) {}
    }

    collapseBtn.addEventListener('click', () => setCollapsed(true));
    expandBtn.addEventListener('click', () => setCollapsed(false));

    try {
        const saved = localStorage.getItem('sidebar-collapsed');
        if (saved === '1') {
            setCollapsed(true);
        }
    } catch (e) {}

    // Sidebar tabs
    const tabs = Array.from(document.querySelectorAll('.sidebar-tab'));
    const panels = Array.from(document.querySelectorAll('.sidebar-tab-panel'));
    function showSidebarTab(name) {
        tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === name));
        panels.forEach(p => { p.style.display = (p.id === `sidebar-${name}`) ? 'block' : 'none'; });
        try { localStorage.setItem('sidebar-active-tab', name); } catch (e) {}
    }

    tabs.forEach(t => t.addEventListener('click', () => showSidebarTab(t.dataset.tab)));
    try {
        const savedTab = localStorage.getItem('sidebar-active-tab');
        if (savedTab) showSidebarTab(savedTab);
    } catch (e) {}
})();
