const PROXIMITY_THRESHOLD = 150; // pixels
let nearbyUsers = new Set();
let proximityLoopHandle = null;

function calculateDistance(x1, y1, x2, y2) {
    return Math.hypot(x1 - x2, y1 - y2);
}

function proximityTick() {
    if (!activeGroupSlug) return;
    
    const selfAvatar = avatarByUserId.get(currentUserId);
    if (!selfAvatar) {
        proximityLoopHandle = window.setTimeout(proximityTick, 500);
        return;
    }
    
    const selfRect = selfAvatar.getBoundingClientRect();
    const selfX = selfRect.left + selfRect.width / 2;
    const selfY = selfRect.top + selfRect.height / 2;
    
    avatarByUserId.forEach((avatar, userId) => {
        if (userId === currentUserId) return;
        
        // Only check online members
        if (!avatar.classList.contains('is-online')) {
            if (nearbyUsers.has(userId)) {
                nearbyUsers.delete(userId);
            }
            return;
        }
        
        const rect = avatar.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const distance = calculateDistance(selfX, selfY, x, y);
        
        const wasNearby = nearbyUsers.has(userId);
        
        if (!wasNearby && distance < PROXIMITY_THRESHOLD) {
            nearbyUsers.add(userId);
            handleUserEnteredProximity(userId, avatar.dataset.username || `User ${userId}`);
        } else if (wasNearby && distance > PROXIMITY_THRESHOLD + 30) {
            nearbyUsers.delete(userId);
            handleUserLeftProximity(userId);
        }
    });
    
    proximityLoopHandle = window.setTimeout(proximityTick, 500);
}

function handleUserEnteredProximity(userId, username) {
    // 1. Fetch DM data
    fetch(`/api/dm/${userId}/`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-CSRFToken': getCsrfToken(),
        },
    }).then(r => r.json()).then(payload => {
        if (!payload.ok) return;
        
        // 2. Fetch drop data
        fetch(`/api/groups/${activeGroupSlug}/drops/${userId}/`)
            .then(r => r.json())
            .then(dropPayload => {
                let dropHtml = '';
                if (dropPayload.ok && dropPayload.drop) {
                    const drop = dropPayload.drop;
                    dropHtml = `<div class="proximity-drop-info" style="padding: 10px; background: var(--surface-2); border-radius: 8px; margin-bottom: 10px; font-size: 0.9em;">
                        <strong>${username} is dropping:</strong><br/>
                        ${drop.message ? `<p style="margin: 4px 0;">${drop.message}</p>` : ''}
                        ${drop.file_url ? `<a href="${drop.file_url}" target="_blank" style="color: var(--accent-primary); text-decoration: underline;">${drop.file_name}</a>` : ''}
                    </div>`;
                }
                
                // 3. Open DM overlay
                openDmOverlay(userId, payload.target_username || username, payload.dm_slug, payload.messages || []);
                
                // Inject drop html
                const dmOverlayMessages = document.getElementById('dm-overlay-messages');
                if (dmOverlayMessages && dropHtml) {
                    const dropContainer = document.createElement('div');
                    dropContainer.innerHTML = dropHtml;
                    dmOverlayMessages.prepend(dropContainer);
                }
            });
    });
}

function handleUserLeftProximity(userId) {
    // Optionally close DM if they walk away?
    // User might be typing, so let's not close it aggressively.
    // Or we could close it if no interaction happened.
}

window.setTimeout(proximityTick, 1000);

const profileDropBtn = document.getElementById('profile-drop-btn');
const profileDropForm = document.getElementById('profile-drop-form');

if (profileDropBtn && profileDropForm) {
    profileDropBtn.addEventListener('click', () => {
        profileDropForm.style.display = 'grid';
        profileFields.style.display = 'none';
        profileEditForm.style.display = 'none';
        
        // Fetch current drop info
        fetch(`/api/groups/${activeGroupSlug}/drops/${currentUserId}/`)
            .then(r => r.json())
            .then(payload => {
                const infoDiv = document.getElementById('current-drop-info');
                if (payload.ok && payload.drop) {
                    const drop = payload.drop;
                    document.getElementById('drop-message-input').value = drop.message || '';
                    if (drop.file_url) {
                        infoDiv.innerHTML = `Current file: <a href="${drop.file_url}" target="_blank" style="color: var(--accent-primary);">${drop.file_name}</a>`;
                    } else {
                        infoDiv.innerHTML = 'No file attached.';
                    }
                } else {
                    document.getElementById('drop-message-input').value = '';
                    infoDiv.innerHTML = 'No file attached.';
                }
            });
    });

    profileDropForm.addEventListener('submit', (e) => {
        e.preventDefault();
        
        const formData = new FormData(profileDropForm);
        formData.append('csrfmiddlewaretoken', getCsrfToken());
        
        fetch(`/api/groups/${activeGroupSlug}/drops/`, {
            method: 'POST',
            body: formData,
        }).then(r => r.json()).then(payload => {
            if (payload.ok) {
                profileDropForm.style.display = 'none';
                profileFields.style.display = 'grid';
                profileDropForm.reset();
            } else {
                alert('Failed to save drop.');
            }
        });
    });
}
