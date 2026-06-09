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
const loadedAvatarImages = new Map();
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
const profileSkinBtn = document.getElementById('profile-skin-btn');
const profileSkinEditor = document.getElementById('profile-skin-editor');
const skinPalette = document.getElementById('skin-palette');
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
const dmSockets = new Map();    // slug → WebSocket
const dmPartnerIds = new Map(); // slug → partnerId
const unreadCounts = new Map(); // partnerId → count
const processedDmMessageIds = new Set(); // message ID → true
let currentDmSlug = null;       // slug of the currently-open overlay (null = closed)

function ensureAvatarElement(userId, username) {
    let avatar = avatarByUserId.get(userId);
    if (avatar && document.contains(avatar)) {
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
        // default to viewport center (will be adjusted to percent positions when available)
        avatar.style.left = `${Math.floor(window.innerWidth/2)}px`;
        avatar.style.top = `${Math.floor(window.innerHeight/2)}px`;
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
    // if element has percent-based inline style from server, convert to viewport pixels
    const leftStyle = avatar.getAttribute('style') || '';
    const mLeft = leftStyle.match(/left:\s*([0-9\.]+)%/);
    const mTop = leftStyle.match(/top:\s*([0-9\.]+)%/);
    if (mLeft && mTop) {
        setAvatarPosFromPercent(avatar, Number(mLeft[1]), Number(mTop[1]));
    }
    return avatar;
}

function setAvatarPosFromPercent(avatar, pctX, pctY) {
    avatar.style.left = `${pctX}%`;
    avatar.style.top = `${pctY}%`;
    
    // persist percent for future layout changes
    avatar.dataset.percentLeft = String(Number(pctX));
    avatar.dataset.percentTop = String(Number(pctY));
    
    // update z-index relative to sidebar overlap
    const rect = avatar.getBoundingClientRect();
    updateAvatarZIndex(avatar, rect.left + rect.width / 2);
}

function updateAvatarZIndex(avatar, px) {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    const sbRect = sidebar.getBoundingClientRect();
    // if avatar lies under the sidebar area, place it below sidebar
    if (px < Math.ceil(sbRect.right)) {
        avatar.style.zIndex = '4';
    } else {
        const userId = Number(avatar.dataset.userId || -1);
        if (userId === Number(currentUserId)) {
            avatar.style.zIndex = '21';
        } else {
            avatar.style.zIndex = '20';
        }
    }
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
// background canvas anchor left (captured at first layout) so sidebar changes won't move it
let bgInitialLeft = null;

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

    avatar.style.backgroundImage = 'none';
    avatar.style.backgroundColor = 'rgba(255, 255, 255, 0.07)';
    canvas.style.display = 'block';

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
    // shrink body by additional 10%
    const bodyR = Math.min(size, size) * 0.34 * 0.9;
    // skin and stroke - prefer per-avatar dataset.skin, fallback to yellow
    const skin = (avatar.dataset.skin || '').trim() || '#facc15';
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);


    // draw smaller hands and place them forward (positive X after rotation)
    // hands closer to the body and slightly smaller
    const handR = bodyR * 0.22;
    const handOffsetX = bodyR * 0.95; // near the body
    const handOffsetY = bodyR * 0.42;
    const sepDeg = 10; // separation angle increase in degrees
    const sep = (sepDeg * Math.PI) / 180;
    function rotatePoint(x, y, theta) {
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        return { x: x * c - y * s, y: x * s + y * c };
    }

    // left hand (upper) rotated outward by -sep
    const p1 = rotatePoint(handOffsetX, -handOffsetY, -sep);
    ctx.beginPath();
    ctx.fillStyle = skin.trim();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.arc(p1.x, p1.y, handR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // right hand (lower) rotated outward by +sep
    const p2 = rotatePoint(handOffsetX, handOffsetY, sep);
    ctx.beginPath();
    ctx.arc(p2.x, p2.y, handR, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // draw body (center)
    ctx.beginPath();
    ctx.arc(0, 0, bodyR, 0, Math.PI * 2);
    
    const avatarUrl = avatar.dataset.avatarUrl;
    let avatarImg = null;
    if (avatarUrl) {
        if (!loadedAvatarImages.has(avatarUrl)) {
            const img = new Image();
            img.src = avatarUrl;
            img.onload = () => {
                loadedAvatarImages.set(avatarUrl, img);
                drawAvatarForElement(avatar);
            };
            loadedAvatarImages.set(avatarUrl, 'loading');
        } else {
            const cached = loadedAvatarImages.get(avatarUrl);
            if (cached !== 'loading') {
                avatarImg = cached;
            }
        }
    }
    
    if (avatarImg) {
        ctx.save();
        ctx.clip();
        ctx.rotate(-ang); // Undo rotation so the image stays upright
        ctx.drawImage(avatarImg, -bodyR, -bodyR, bodyR * 2, bodyR * 2);
        ctx.restore();
        ctx.stroke();
    } else {
        ctx.fill();
        ctx.stroke();
    }

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
        if (profile.avatar_url) {
            profileAvatar.textContent = '';
            profileAvatar.style.backgroundImage = `url(${profile.avatar_url})`;
            profileAvatar.style.backgroundSize = 'cover';
            profileAvatar.style.backgroundPosition = 'center';
            profileAvatar.style.backgroundColor = 'transparent';
        } else {
            profileAvatar.textContent = displayName.charAt(0).toUpperCase();
            // set profile avatar background to skin if provided, otherwise default yellow
            profileAvatar.style.background = profile.skin || '#facc15';
            profileAvatar.style.backgroundImage = 'none';
        }
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
        // hide actions while in edit mode
        profileActions.style.display = (isSelf && !profileEditMode) ? 'flex' : 'none';
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
    
    // Update status mode in member row
    const memberRow = document.querySelector(`.member-row[data-user-id="${profile.user_id}"]`);
    if (memberRow) {
        memberRow.dataset.statusMode = profile.status_mode || 'online';
        const presencePill = memberRow.querySelector('.presence-pill');
        if (presencePill) {
            presencePill.classList.remove('status-mode-online', 'status-mode-idle', 'status-mode-dnd', 'status-mode-invisible', 'status-mode-offline');
            const statusMode = profile.status_mode || 'online';
            presencePill.classList.add(`status-mode-${statusMode}`);
            const titleText = statusMode.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
            presencePill.textContent = titleText;
        }
    }
    
    if (isSelf) {
        const sidebarAvatar = document.getElementById('sidebar-user-avatar');
        if (sidebarAvatar) {
            if (profile.avatar_url) {
                sidebarAvatar.style.backgroundImage = `url(${profile.avatar_url})`;
                sidebarAvatar.style.backgroundSize = 'cover';
                sidebarAvatar.style.backgroundPosition = 'center';
                sidebarAvatar.style.color = 'transparent';
            } else {
                sidebarAvatar.style.backgroundImage = 'none';
                sidebarAvatar.style.color = '';
            }
            
            // Update avatar initial letter
            const avatarInitial = document.getElementById('sidebar-user-avatar-initial');
            if (avatarInitial) {
                const displayName = profile.display_name || profile.username || '';
                avatarInitial.textContent = displayName.charAt(0).toUpperCase();
            }


        }

        // Update display name in profile bar
        const sidebarUserName = document.getElementById('sidebar-user-name');
        if (sidebarUserName) {
            sidebarUserName.textContent = profile.display_name || profile.username || '';
        }

        // Update status mode in profile bar
        const sidebarUserStatus = document.getElementById('sidebar-user-status');
        if (sidebarUserStatus) {
            const mode = profile.status_mode || 'online';
            sidebarUserStatus.classList.remove('status-mode-online', 'status-mode-idle', 'status-mode-dnd', 'status-mode-invisible', 'status-mode-offline');
            sidebarUserStatus.classList.add(`status-mode-${mode}`);
            sidebarUserStatus.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
        }
    }
    
    // apply skin and avatar_url to space avatar if provided
    try {
        const spaceAvatar = document.querySelector(`.space-avatar[data-user-id="${profile.user_id}"]`);
        if (spaceAvatar) {
            if (profile.skin) {
                spaceAvatar.dataset.skin = profile.skin;
            }
            if (profile.avatar_url) {
                spaceAvatar.dataset.avatarUrl = profile.avatar_url;
            } else {
                delete spaceAvatar.dataset.avatarUrl;
            }
            // redraw if canvas exists
            const info = avatarCanvasByUserId.get(Number(spaceAvatar.dataset.userId));
            if (info) drawAvatarForElement(spaceAvatar);
        }
    } catch (e) {}
}

// Among Us palette
const AMONG_US_COLORS = [
    '#ff4b4b', // red
    '#3b82f6', // blue
    '#10b981', // green
    '#ff6bcb', // pink
    '#fb923c', // orange
    '#facc15', // yellow
    '#111827', // black
    '#f3f4f6', // white
    '#8b5cf6', // purple
    '#7c2d12', // brown
    '#06b6d4', // cyan
    '#84cc16', // lime
    '#7f1d1d', // maroon
    '#fb7185', // rose
];

function renderSkinPalette() {
    if (!skinPalette) return;
    skinPalette.innerHTML = '';
    AMONG_US_COLORS.forEach((col) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'skin-swatch';
        btn.style.width = '28px';
        btn.style.height = '18px';
        btn.style.margin = '4px';
        btn.style.borderRadius = '6px';
        btn.style.border = '1px solid rgba(0,0,0,0.2)';
        btn.style.background = col;
        btn.dataset.color = col;
        btn.addEventListener('click', () => selectSkinColor(col));
        skinPalette.appendChild(btn);
    });
}

function selectSkinColor(color) {
    if (!activeProfileUserId) return;
    // optimistic local update
    const myAvatar = document.querySelector(`.space-avatar[data-user-id="${currentUserId}"]`);
    if (myAvatar) {
        myAvatar.dataset.skin = color;
        drawAvatarForElement(myAvatar);
    }
    if (profileAvatar) {
        profileAvatar.style.background = color;
    }

    // persist to server if possible
    const url = profileUrl(activeProfileUserId);
    if (!url) return;
    fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-CSRFToken': getCsrfToken(),
        },
        body: new URLSearchParams({ skin: color }),
    }).then(async (r) => {
        if (!r.ok) throw new Error('skin-save-failed');
        const payload = await r.json();
        if (payload && payload.profile) {
            // update display with server value if returned
            renderProfile(payload.profile);
        }
    }).catch(() => {
        // ignore errors — local update remains
    }).finally(() => {
        // close editor after selection
        if (profileSkinEditor) profileSkinEditor.style.display = 'none';
    });
}

if (profileSkinBtn) {
    profileSkinBtn.addEventListener('click', () => {
        if (!profileSkinEditor) return;
        const showing = profileSkinEditor.style.display === 'block';
        if (!showing) {
            renderSkinPalette();
            profileSkinEditor.style.display = 'block';
        } else {
            profileSkinEditor.style.display = 'none';
        }
    });
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

    if (typeof memberState.x === 'number' && typeof memberState.y === 'number') {
        setAvatarPosFromPercent(avatar, Number(memberState.x), Number(memberState.y));
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
        if (typeof memberState.skin !== 'undefined') {
            avatar.dataset.skin = String(memberState.skin || '');
        }
        if (typeof memberState.avatar_url !== 'undefined') {
            if (memberState.avatar_url) {
                avatar.dataset.avatarUrl = memberState.avatar_url;
            } else {
                delete avatar.dataset.avatarUrl;
            }
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

function addMemberToSidebar(userId, username) {
    const groupList = document.querySelector('#sidebar-room .group-list');
    if (!groupList) {
        return;
    }
    if (groupList.querySelector(`.member-row[data-user-id="${userId}"]`)) {
        return;
    }

    const row = document.createElement('div');
    row.className = 'user-item member-row';
    row.dataset.userId = String(userId);
    row.dataset.username = username;
    row.dataset.online = 'true';

    const avatarEl = document.createElement('div');
    avatarEl.className = 'avatar';
    avatarEl.textContent = username.charAt(0).toUpperCase();

    const userInfo = document.createElement('div');
    userInfo.className = 'user-info';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'user-name';
    nameSpan.textContent = username;

    const pill = document.createElement('span');
    pill.className = 'presence-pill status-mode-online';
    pill.textContent = 'Online';

    userInfo.appendChild(nameSpan);
    userInfo.appendChild(pill);
    row.appendChild(avatarEl);
    row.appendChild(userInfo);
    groupList.appendChild(row);

    const roomOnlineCount = document.getElementById('room-online-count');
    if (roomOnlineCount) {
        const prev = Number(roomOnlineCount.dataset.total) || 0;
        roomOnlineCount.dataset.total = String(prev + 1);
    }
}

function updatePresence(onlineMemberIds, memberStates) {
    const onlineIds = new Set(onlineMemberIds);

    if (memberStates && Object.keys(memberStates).length > 0) {
        const knownIds = new Set(
            Array.from(document.querySelectorAll('#sidebar-room .member-row[data-user-id]'))
                .map((r) => Number(r.dataset.userId))
        );
        onlineIds.forEach((id) => {
            if (!knownIds.has(id)) {
                const state = memberStates[id] || memberStates[String(id)] ||
                    Object.values(memberStates).find((s) => Number(s.user_id) === id);
                const username = (state && state.username) || `User ${id}`;
                addMemberToSidebar(id, username);
            }
        });
    }

    document.querySelectorAll('.member-row').forEach((row) => {
        const userId = Number(row.dataset.userId);
        const isOnline = onlineIds.has(userId);
        row.dataset.online = String(isOnline);
        // pill reflects profile status_mode, not raw presence
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
const voiceAudioContainer = document.getElementById('voice-audio-container');
const voiceCallBtn = document.getElementById('voice-call-btn');
const muteBtn = document.getElementById('mute-btn');
const voiceStatusText = document.getElementById('voice-status');
let localVoiceStream = null;
let voiceCallActive = false;
let microphoneEnabled = true;
const voicePeerConnections = new Map();
const pendingIceCandidates = new Map();
const remoteAudioElements = new Map();

function isVoiceControlAvailable() {
    return Boolean(voiceCallBtn && muteBtn && voiceStatusText && socket);
}

function updateVoiceUi() {
    if (!isVoiceControlAvailable()) {
        return;
    }

    if (voiceCallActive) {
        voiceCallBtn.title = 'Stop voice call';
        voiceCallBtn.querySelector('span').textContent = 'call_end';
        muteBtn.style.display = '';
        muteBtn.title = microphoneEnabled ? 'Mute microphone' : 'Unmute microphone';
        muteBtn.querySelector('span').textContent = microphoneEnabled ? 'mic' : 'mic_off';
        voiceStatusText.textContent = `Voice: ${microphoneEnabled ? 'On' : 'Muted'}`;
    } else {
        voiceCallBtn.title = 'Start voice call';
        voiceCallBtn.querySelector('span').textContent = 'call';
        muteBtn.style.display = 'none';
        voiceStatusText.textContent = 'Voice: Off';
    }
}

function cleanupVoiceElement(remoteUserId) {
    const audioEl = remoteAudioElements.get(remoteUserId);
    if (audioEl && audioEl.parentNode) {
        audioEl.parentNode.removeChild(audioEl);
    }
    remoteAudioElements.delete(remoteUserId);
}

function removeVoiceConnection(remoteUserId) {
    const pc = voicePeerConnections.get(remoteUserId);
    if (pc) {
        pc.close();
        voicePeerConnections.delete(remoteUserId);
    }
    pendingIceCandidates.delete(remoteUserId);
    cleanupVoiceElement(remoteUserId);
}

function clearVoiceConnections() {
    voicePeerConnections.forEach((_, remoteUserId) => removeVoiceConnection(remoteUserId));
}

async function getLocalAudioStream() {
    if (localVoiceStream) {
        return localVoiceStream;
    }
    try {
        localVoiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localVoiceStream.getAudioTracks().forEach((track) => {
            track.enabled = microphoneEnabled;
        });
        return localVoiceStream;
    } catch (error) {
        console.error('Failed to access microphone:', error);
        throw error;
    }
}

function createRemoteAudioElement(remoteUserId) {
    if (!voiceAudioContainer) {
        return null;
    }
    cleanupVoiceElement(remoteUserId);
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.dataset.userId = String(remoteUserId);
    voiceAudioContainer.appendChild(audio);
    remoteAudioElements.set(remoteUserId, audio);
    return audio;
}

function queueIceCandidate(remoteUserId, candidate) {
    if (!pendingIceCandidates.has(remoteUserId)) {
        pendingIceCandidates.set(remoteUserId, []);
    }
    pendingIceCandidates.get(remoteUserId).push(candidate);
}

async function flushIceCandidates(remoteUserId) {
    const pc = voicePeerConnections.get(remoteUserId);
    if (!pc) {
        return;
    }
    const candidates = pendingIceCandidates.get(remoteUserId) || [];
    if (!candidates.length) {
        return;
    }
    for (const candidate of candidates) {
        try {
            await pc.addIceCandidate(candidate);
        } catch (error) {
            console.warn('Failed to add queued ICE candidate:', error);
        }
    }
    pendingIceCandidates.delete(remoteUserId);
}

function sendVoiceSignal(targetUserId, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
    }
    socket.send(JSON.stringify({
        type: 'voice_signal',
        to_user_id: targetUserId,
        signal: payload,
    }));
}

async function createVoicePeerConnection(remoteUserId) {
    if (voicePeerConnections.has(remoteUserId)) {
        return voicePeerConnections.get(remoteUserId);
    }
    const pc = new RTCPeerConnection();
    const localStream = await getLocalAudioStream();
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    pc.ontrack = (event) => {
        const remoteStream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
        const audioEl = createRemoteAudioElement(remoteUserId);
        if (audioEl) {
            audioEl.srcObject = remoteStream;
            audioEl.play().catch(() => {
                // Autoplay may require a user gesture; voice call initiation is user triggered.
            });
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendVoiceSignal(remoteUserId, {
                signal_type: 'ice',
                candidate: event.candidate,
            });
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
            removeVoiceConnection(remoteUserId);
        }
    };

    voicePeerConnections.set(remoteUserId, pc);
    return pc;
}

async function maybeCreateOffer(remoteUserId) {
    if (!voiceCallActive) {
        return;
    }
    if (remoteUserId === Number(currentUserId)) {
        return;
    }
    if (voicePeerConnections.has(remoteUserId)) {
        return;
    }
    const pc = await createVoicePeerConnection(remoteUserId);
    if (Number(currentUserId) < Number(remoteUserId)) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendVoiceSignal(remoteUserId, {
            signal_type: 'offer',
            sdp: offer.sdp,
            sdp_type: offer.type,
        });
    }
}

async function handleVoiceSignalEvent(fromUserId, signal) {
    if (!voiceCallActive) {
        return;
    }
    const remoteUserId = Number(fromUserId);
    if (remoteUserId === Number(currentUserId)) {
        return;
    }

    const pc = await createVoicePeerConnection(remoteUserId);
    const signalType = signal.signal_type;

    if (signalType === 'offer') {
        const description = {
            type: 'offer',
            sdp: signal.sdp,
        };
        await pc.setRemoteDescription(description);
        await flushIceCandidates(remoteUserId);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendVoiceSignal(remoteUserId, {
            signal_type: 'answer',
            sdp: answer.sdp,
            sdp_type: answer.type,
        });
        return;
    }

    if (signalType === 'answer') {
        const description = {
            type: 'answer',
            sdp: signal.sdp,
        };
        await pc.setRemoteDescription(description);
        await flushIceCandidates(remoteUserId);
        return;
    }

    if (signalType === 'ice' && signal.candidate) {
        const candidate = signal.candidate;
        if (pc.remoteDescription && pc.remoteDescription.type) {
            try {
                await pc.addIceCandidate(candidate);
            } catch (error) {
                console.warn('Failed to add ICE candidate:', error);
            }
        } else {
            queueIceCandidate(remoteUserId, candidate);
        }
    }
}

function setMicrophoneEnabled(enabled) {
    microphoneEnabled = Boolean(enabled);
    if (localVoiceStream) {
        localVoiceStream.getAudioTracks().forEach((track) => {
            track.enabled = microphoneEnabled;
        });
    }
    updateVoiceUi();
}

async function startVoiceCall() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert('Your browser does not support voice chat.');
        return;
    }
    try {
        await getLocalAudioStream();
    } catch (error) {
        return;
    }
    voiceCallActive = true;
    setMicrophoneEnabled(true);
    updateVoiceUi();
    const onlineRows = Array.from(document.querySelectorAll('.member-row[data-user-id][data-online="true"]'));
    for (const row of onlineRows) {
        const remoteId = Number(row.dataset.userId);
        if (remoteId !== Number(currentUserId)) {
            await maybeCreateOffer(remoteId);
        }
    }
}

function stopVoiceCall() {
    voiceCallActive = false;
    updateVoiceUi();
    clearVoiceConnections();
    if (localVoiceStream) {
        localVoiceStream.getAudioTracks().forEach((track) => {
            track.enabled = false;
        });
    }
}

function syncVoicePeersFromPresence(onlineMemberIds) {
    if (!voiceCallActive) {
        return;
    }
    const onlineSet = new Set((onlineMemberIds || []).map((id) => Number(id))); 
    onlineSet.delete(Number(currentUserId));
    onlineSet.forEach((remoteId) => {
        if (!voicePeerConnections.has(remoteId)) {
            maybeCreateOffer(remoteId).catch((err) => console.warn('Voice peer creation failed:', err));
        }
    });
    Array.from(voicePeerConnections.keys()).forEach((remoteId) => {
        if (!onlineSet.has(remoteId)) {
            removeVoiceConnection(remoteId);
        }
    });
}

if (voiceCallBtn) {
    voiceCallBtn.addEventListener('click', () => {
        if (voiceCallActive) {
            stopVoiceCall();
        } else {
            startVoiceCall();
        }
    });
}

if (muteBtn) {
    muteBtn.addEventListener('click', () => {
        setMicrophoneEnabled(!microphoneEnabled);
    });
}

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

function showUnreadBadge(partnerId, count) {
    const label = count > 9 ? '9+' : String(count);

    function upsertBadge(parent) {
        if (!parent) return;
        let badge = parent.querySelector(':scope > .dm-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'dm-badge';
            parent.appendChild(badge);
        }
        badge.textContent = label;
    }

    // Place badge on the DM sidebar link itself (avoids overflow clipping from .group-list)
    document.querySelectorAll(`a.group-link[data-partner-id="${partnerId}"]`).forEach(upsertBadge);

    // Also badge the space-avatar if the partner happens to be in the same room
    const spaceAvatar = document.querySelector(`.space-avatar[data-user-id="${partnerId}"]`);
    upsertBadge(spaceAvatar);
}

function clearUnreadBadge(partnerId) {
    unreadCounts.delete(partnerId);
    document.querySelectorAll(
        `a.group-link[data-partner-id="${partnerId}"] > .dm-badge,` +
        `.space-avatar[data-user-id="${partnerId}"] > .dm-badge`
    ).forEach((b) => b.remove());
}

function connectDmBackground(dmSlug, partnerId, partnerUsername) {
    const existing = dmSockets.get(dmSlug);
    if (existing && existing.readyState !== WebSocket.CLOSED && existing.readyState !== WebSocket.CLOSING) {
        return;
    }
    const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${wsProto}://${window.location.host}/ws/chat/${dmSlug}/`);
    dmSockets.set(dmSlug, ws);
    dmPartnerIds.set(dmSlug, partnerId);

    ws.addEventListener('message', (event) => {
        let payload;
        try { payload = JSON.parse(event.data); } catch { return; }
        if (payload.type !== 'message') return;
        const msg = payload.message;

        if (currentDmSlug === dmSlug && dmOverlay && dmOverlay.classList.contains('is-open')) {
            appendDmMessage(msg);
            return;
        }

        if (msg.sender_id === currentUserId) return;

        if (msg.id) {
            if (processedDmMessageIds.has(msg.id)) return;
            processedDmMessageIds.add(msg.id);
        }

        const count = (unreadCounts.get(partnerId) || 0) + 1;
        unreadCounts.set(partnerId, count);
        showUnreadBadge(partnerId, count);
        showToastNotification(msg.sender);
    });
}

function showToastNotification(username) {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    
    const toast = document.createElement('div');
    toast.className = 'toast-message';
    
    const text = document.createElement('span');
    text.textContent = `${username} poked you`;
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.innerHTML = '&times;';
    
    toast.appendChild(text);
    toast.appendChild(closeBtn);
    container.appendChild(toast);
    
    const timeoutId = setTimeout(() => {
        if (toast.parentElement) {
            toast.classList.add('closing');
            setTimeout(() => toast.remove(), 300);
        }
    }, 5000);
    
    closeBtn.addEventListener('click', () => {
        clearTimeout(timeoutId);
        toast.classList.add('closing');
        setTimeout(() => toast.remove(), 300);
    });
}

function openDmOverlay(userId, username, dmSlug, initialMessages) {
    if (!dmOverlay) {
        return;
    }
    currentDmSlug = dmSlug;
    clearUnreadBadge(userId);
    
    // Clear any active movement keys so the avatar stops moving when DM opens
    if (typeof activeKeys !== 'undefined') {
        activeKeys.clear();
    }

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

    connectDmBackground(dmSlug, userId, username);
}

function closeDmOverlay() {
    if (dmOverlay) {
        dmOverlay.classList.remove('is-open');
        dmOverlay.setAttribute('aria-hidden', 'true');
    }
    currentDmSlug = null;
    // Keep dmSockets alive for background notifications
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
        const data = await response.json();
        dmOverlayInput.value = '';
        dmOverlayInput.focus();
        if (data && data.message) {
            appendDmMessage(data.message);
        }
    }).catch(() => {
        const ws = dmSockets.get(currentDmSlug);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'message', content }));
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
                'X-CSRFToken': getCsrfToken(),
            },
            body: formData,
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
            profileEditForm.reset();
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

// Logout confirmation modal logic
const logoutForm = document.getElementById('logout-form');
const logoutModal = document.getElementById('logout-confirm-modal');
const logoutCancel = document.getElementById('logout-cancel');
const logoutConfirm = document.getElementById('logout-confirm');
if (logoutForm && logoutModal && logoutCancel && logoutConfirm) {
    logoutForm.addEventListener('submit', (e) => {
        e.preventDefault();
        logoutModal.style.display = 'flex';
        logoutModal.setAttribute('aria-hidden', 'false');
        // focus cancel for safety
        logoutCancel.focus();
    });

    logoutCancel.addEventListener('click', () => {
        logoutModal.style.display = 'none';
        logoutModal.setAttribute('aria-hidden', 'true');
    });

    logoutConfirm.addEventListener('click', () => {
        // submit the form programmatically
        logoutModal.style.display = 'none';
        logoutModal.setAttribute('aria-hidden', 'true');
        logoutForm.submit();
    });

    // close on escape
    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && logoutModal.style.display === 'flex') {
            logoutModal.style.display = 'none';
            logoutModal.setAttribute('aria-hidden', 'true');
        }
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
            updatePresence(payload.online_member_ids, payload.member_states || {});
            syncMemberStates(payload.member_states || {});
            syncVoicePeersFromPresence(payload.online_member_ids);
        } else if (payload.type === 'state') {
            updatePresence(payload.online_member_ids || [], payload.member_states || {});
            syncMemberStates(payload.member_states || {});
            syncVoicePeersFromPresence(payload.online_member_ids || []);
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
        } else if (payload.type === 'voice_signal') {
            if (payload.to_user_id !== Number(currentUserId)) {
                return;
            }
            handleVoiceSignalEvent(payload.from_user_id, payload.signal).catch((err) => {
                console.warn('Voice signal handling error:', err);
            });
        } else if (payload.type === 'dm_received') {
            const msg = payload.message;
            const dmSlug = payload.dm_slug;
            const partnerId = payload.partner_id;
            const partnerUsername = payload.partner_username;

            if (currentDmSlug === dmSlug && dmOverlay && dmOverlay.classList.contains('is-open')) {
                appendDmMessage(msg);
                return;
            }

            if (msg.id) {
                if (processedDmMessageIds.has(msg.id)) return;
                processedDmMessageIds.add(msg.id);
            }

            const count = (unreadCounts.get(partnerId) || 0) + 1;
            unreadCounts.set(partnerId, count);
            showUnreadBadge(partnerId, count);
            showToastNotification(msg.sender);

            if (!document.querySelector(`a.group-link[data-dm-slug="${dmSlug}"]`)) {
                connectDmBackground(dmSlug, partnerId, partnerUsername);
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
        updatePresence(payload.online_member_ids || [], payload.member_states || {});
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
    if (dmOverlay && dmOverlay.classList.contains('is-open')) {
        return;
    }
    
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
    const key = normalizeKey(event.key);
    if (!(key in KEY_TO_VECTOR)) {
        return;
    }

    if (!isTypingTarget(event.target)) {
        event.preventDefault();
    }
    activeKeys.delete(key);
});

window.addEventListener('blur', () => {
    activeKeys.clear();
});

document.addEventListener('click', (event) => {
    // Intercept DM sidebar link clicks — open overlay instead of navigating
    const dmLink = event.target.closest('a.group-link[data-dm-slug]');
    if (dmLink) {
        event.preventDefault();
        const dmSlug = dmLink.dataset.dmSlug;
        const partnerId = Number(dmLink.dataset.partnerId);
        const partnerUsername = dmLink.dataset.partnerUsername || `User ${partnerId}`;
        fetch(`/api/dm/${partnerId}/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-CSRFToken': getCsrfToken(),
            },
        }).then((r) => r.json()).then((payload) => {
            if (!payload.ok) return;
            openDmOverlay(
                partnerId,
                payload.target_username || partnerUsername,
                payload.dm_slug || dmSlug,
                payload.messages || []
            );
        }).catch(() => {});
        return;
    }

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

// Connect background WebSocket for every existing DM so we can receive
// messages and show notification badges even before the overlay is opened.
document.querySelectorAll('a.group-link[data-dm-slug]').forEach((link) => {
    const dmSlug = link.dataset.dmSlug;
    const partnerId = Number(link.dataset.partnerId);
    const partnerUsername = link.dataset.partnerUsername || `User ${partnerId}`;
    if (dmSlug && partnerId) {
        connectDmBackground(dmSlug, partnerId, partnerUsername);
    }
});
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

// Background canvas: draw cafe-office 2D scene (white wooden floor, long table, sofa, tea area)
function ensureBackgroundCanvas() {
    const main = document.querySelector('.main-area');
    if (!main) return null;
    const canvas = document.getElementById('background-canvas');
    if (!canvas) return null;
    const dpr = devicePixelRatio || 1;

    // capture initial left offset of main area on first run so sidebar toggles won't affect it
    const mainRect = main.getBoundingClientRect();
    if (bgInitialLeft === null) {
        bgInitialLeft = Math.max(0, Math.floor(mainRect.left));
    }

    // compute right-panel width to exclude chat column
    const rightPanel = document.querySelector('.right-panel');
    const rightWidth = rightPanel ? Math.floor(rightPanel.getBoundingClientRect().width) : 0;

    // keep canvas anchored to the initial main-area left so furniture never moves
    const canvasLeft = (bgInitialLeft || 0);
    const canvasTop = 0;
    const canvasWidth = Math.max(300, Math.floor(window.innerWidth - rightWidth - canvasLeft));
    const canvasHeight = Math.max(300, Math.floor(window.innerHeight));

    canvas.style.left = `${canvasLeft}px`;
    canvas.style.top = `${canvasTop}px`;
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    canvas.width = Math.floor(canvasWidth * dpr);
    canvas.height = Math.floor(canvasHeight * dpr);

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    // compute scene left padding: use the initial main-area left captured on first run
    // this keeps furniture fixed relative to the initial layout so it won't move when sidebar toggles
    const sceneLeftPadding = bgInitialLeft || 0;
    drawCafeOfficeBackground(ctx, canvasWidth, canvasHeight, sceneLeftPadding);
    return canvas;
}

function drawCafeOfficeBackground(ctx, width, height, offsetX = 0) {
    // clear
    ctx.clearRect(0, 0, width, height);

    // white wooden floor base
    ctx.fillStyle = '#fbfbfa';
    ctx.fillRect(0, 0, width, height);

    // draw subtle wood planks horizontally
    const plankH = 40;
    ctx.lineWidth = 1;
    for (let y = 0; y < height; y += plankH) {
        // stagger slightly to look natural
        const offset = (y / plankH) % 2 === 0 ? 0 : 8;
        ctx.fillStyle = 'rgba(0,0,0,0.02)';
        ctx.fillRect(0, y + plankH - 2, width, 2);
        // occasional knots
        for (let k = 0; k < Math.floor(width / 300); k++) {
            const kx = ((k * 137) % width) + offset;
            const ky = y + Math.random() * (plankH - 20) + 10;
            ctx.fillStyle = 'rgba(0,0,0,0.03)';
            ctx.fillRect(kx, ky, 6, 2);
        }
    }

    // central long table (draw within interior area that excludes left offset)
    const interiorX = offsetX;
    const interiorW = Math.max(100, width - offsetX);
    const tableW = Math.min(interiorW * 0.8, interiorW - 80);
    const tableH = Math.max(60, height * 0.12);
    const tableX = interiorX + (interiorW - tableW) / 2;
    const tableY = (height - tableH) / 2 - 20;
    roundRect(ctx, tableX, tableY, tableW, tableH, 12, '#d6b089', '#9b6f4d');
    // table legs (simple shadows)
    const legW = 12;
    const legH = 34;
    const legOffsetX = 24;
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(tableX + legOffsetX, tableY + tableH - 4, legW, legH);
    ctx.fillRect(tableX + tableW - legOffsetX - legW, tableY + tableH - 4, legW, legH);

    // gray sofa near bottom
    const sofaW = Math.min(interiorW * 0.6, interiorW - 120);
    const sofaH = Math.max(48, height * 0.10);
    const sofaX = interiorX + (interiorW - sofaW) / 2;
    const sofaY = height - sofaH - 30;
    roundRect(ctx, sofaX, sofaY, sofaW, sofaH, 14, '#9aa0a6', '#6f757a');
    // cushions
    const cushionCount = 3;
    const cushionW = (sofaW - (cushionCount + 1) * 12) / cushionCount;
    for (let i = 0; i < cushionCount; i++) {
        const cx = sofaX + 12 + i * (cushionW + 12);
        const cy = sofaY + 8;
        roundRect(ctx, cx, cy, cushionW, sofaH - 16, 8, '#a7adb1', '#7f8589');
    }

    // tea/water area at north (top)
    const counterW = Math.min(interiorW * 0.5, interiorW - 200);
    const counterH = Math.max(40, height * 0.08);
    const counterX = interiorX + (interiorW - counterW) / 2;
    const counterY = 24;
    roundRect(ctx, counterX, counterY, counterW, counterH, 8, '#ececec', '#cfcfcf');
    // coffee machine
    const machineW = 34;
    const machineH = counterH - 12;
    const machineX = counterX + 12;
    const machineY = counterY + 6;
    roundRect(ctx, machineX, machineY, machineW, machineH, 6, '#2b2b2b', '#111');
    // kettle / cups
    ctx.fillStyle = '#d1b48b';
    ctx.beginPath();
    ctx.arc(counterX + counterW - 48, counterY + counterH / 2, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(counterX + counterW - 24, counterY + counterH / 2, 6, 0, Math.PI * 2);
    ctx.fill();

    // subtle vignette to frame the scene
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, 'rgba(0,0,0,0.02)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.03)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
}

function roundRect(ctx, x, y, w, h, r, fill, stroke) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
    if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
    }
    if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
}

// initialize background canvas on load and resize
window.addEventListener('load', () => ensureBackgroundCanvas());
window.addEventListener('resize', () => ensureBackgroundCanvas());

// observe sidebar collapse/expand so background and avatars update
(function watchSidebarChanges() {
    const app = document.querySelector('.app-container');
    if (!app) return;
    const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.attributeName === 'class') {
                // when sidebar toggles, keep the initial bgInitialLeft (furniture fixed)
                const main = document.querySelector('.main-area');
                if (!main) continue;
                const mainRect = main.getBoundingClientRect();
                // only set bgInitialLeft if it hasn't been captured yet
                if (bgInitialLeft === null) {
                    bgInitialLeft = Math.max(0, Math.floor(mainRect.left));
                }
                ensureBackgroundCanvas();
                // reposition all avatars according to new canvas extents
                avatarByUserId.forEach((av, uid) => {
                    const leftAttr = av.dataset.percentLeft;
                    const topAttr = av.dataset.percentTop;
                    if (typeof leftAttr !== 'undefined' && typeof topAttr !== 'undefined') {
                        const pLeft = Number(leftAttr);
                        const pTop = Number(topAttr);
                        if (!Number.isNaN(pLeft) && !Number.isNaN(pTop)) {
                            setAvatarPosFromPercent(av, pLeft, pTop);
                        }
                    }
                });
            }
        }
    });
    obs.observe(app, { attributes: true, attributeFilter: ['class'] });
})();

// Sidebar collapse / expand and tab switching
(function() {
    const app = document.querySelector('.app-container');
    const sidebar = document.querySelector('.sidebar');
    const collapseBtn = document.getElementById('sidebar-collapse-btn');
    const expandBtn = document.getElementById('sidebar-expand-btn');
    if (!app || !sidebar || !collapseBtn || !expandBtn) return;

    function setCollapsed(collapsed) {
            // while sidebar is sliding, keep avatars below sidebar so the sidebar covers them
            avatarByUserId.forEach((av) => { av.style.zIndex = '4'; });
        sidebar.classList.toggle('collapsed', collapsed);
        app.classList.toggle('sidebar-collapsed', collapsed);
        expandBtn.style.display = collapsed ? 'inline-flex' : 'none';
        try { localStorage.setItem('sidebar-collapsed', collapsed ? '1' : '0'); } catch (e) {}
        // wait for sidebar transition to finish then restore avatar z-indexes and redraw
        const handleTransitionEnd = (ev) => {
            if (ev.target !== sidebar) return;
            sidebar.removeEventListener('transitionend', handleTransitionEnd);
            ensureBackgroundCanvas();
            // recompute avatar z-index according to their position
            avatarByUserId.forEach((av) => {
                const pctL = av.dataset.percentLeft;
                const pctT = av.dataset.percentTop;
                if (typeof pctL !== 'undefined' && typeof pctT !== 'undefined') {
                    setAvatarPosFromPercent(av, Number(pctL), Number(pctT));
                }
            });
        };
        sidebar.addEventListener('transitionend', handleTransitionEnd);
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
