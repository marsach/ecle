// ==UserScript==
// @name         Eclesiar Memory Tracker v3
// @namespace    http://tampermonkey.net/
// @version      3.17
// @description  Eclesiar Memory Tracker with cross-device cloud sync (Supabase). Auto-detects user ID from page, syncs local memory cache to a shared cloud DB protected by a user-chosen PIN. Supports weekly event rotation. Cloud data is append/update-only — cannot be deleted. v3.13: highlights matchable pairs among known cards so you do not miss claiming them. v3.16: Panic Mode button wipes all local cache + config so you can start over after forgetting your PIN/event. v3.17: "Sync Setup" and "Nowy Event" merged into one "Sync" button — the cache wipe now triggers on an actual event-name change, so old cards can no longer leak into a new event's cloud row.
// @author       morswin28, kmi3c
// @match        https://eclesiar.com/*
// @homepageURL  https://scripts.ecle.fun/
// @downloadURL  https://raw.githubusercontent.com/marsach/ecle/main/eclesiar-memory-tracker-v3-sync.user.js
// @updateURL    https://raw.githubusercontent.com/marsach/ecle/main/eclesiar-memory-tracker-v3-sync.user.js
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      gubzrhwnfoispspollhp.supabase.co
// @connect      *.supabase.co
// @connect      supabase.co
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ============================================================
    // CONFIG — set these before using
    // ============================================================
    const SUPABASE_URL = 'https://gubzrhwnfoispspollhp.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd1YnpyaHduZm9pc3BzcG9sbGhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNjM0ODAsImV4cCI6MjEwMDgzOTQ4MH0.HJbdnfDGEN1uuwyTSjBoCjthgm3xecqbTUyqmHbdMzo';
    const SALT = 'eclesiar-memory-v1-salt-kSW1fZH8NBMXUBZDNzacUW3ft28jv1y6Hw4Q2QYyrR4Xpz65SNMX7TiKiWy7gLkxv6bXjD';        // any fixed string; changing invalidates all PIN hashes
    const SYNC_DEBOUNCE_MS = 5000;

    // ============================================================
    // STORAGE KEYS
    // ============================================================
    const STORAGE_KEY = 'eclesiar_memory_cache';
    const CONFIG_KEY = 'eclesiar_memory_config'; // { userID, pinHash }

    // ============================================================
    // LOCAL CACHE
    // ============================================================
    const getCache = () => {
        try {
            const data = localStorage.getItem(STORAGE_KEY);
            return data ? JSON.parse(data) : [];
        } catch (e) { return []; }
    };

    const saveCache = (cache) => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)); }
        catch (e) { console.error("Cache save error", e); }
    };

    const getConfig = () => {
        try {
            const data = localStorage.getItem(CONFIG_KEY);
            return data ? JSON.parse(data) : null;
        } catch (e) { return null; }
    };

    const saveConfig = (cfg) => {
        try {
            localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
            const label = document.getElementById('tm-event-label');
            if (label && cfg && cfg.event) label.innerText = `📅 ${cfg.event}`;
        }
        catch (e) { console.error("Config save error", e); }
    };

    // ============================================================
    // CRYPTO — SHA-256 via Web Crypto
    // ============================================================
    async function sha256(text) {
        const buf = new TextEncoder().encode(text);
        const hashBuf = await crypto.subtle.digest('SHA-256', buf);
        return Array.from(new Uint8Array(hashBuf))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    // Compute the pinHash for a given userID + PIN + event.
    // Event is part of the hash so switching event = new row_key = new row in cloud.
    async function computePinHash(userID, pin, event) {
        return await sha256(SALT + '|' + userID + '|' + pin + '|' + (event || 'default'));
    }

    function buildRowKey(userID, pinHash) {
        const safeUserID = String(userID).replace(/[^a-zA-Z0-9]/g, '');
        return `${safeUserID}_${pinHash.substring(0, 32)}`;
    }

    // ============================================================
    // SUPABASE REST CLIENT (via GM_xmlhttpRequest to bypass CORS/CSP)
    // ============================================================
    function supabaseRequest(method, path, body, extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            const url = `${SUPABASE_URL}/rest/v1/${path}`;
            const headers = {
                'apikey': SUPABASE_ANON_KEY,
                'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
                ...extraHeaders
            };
            GM_xmlhttpRequest({
                method,
                url,
                data: body ? JSON.stringify(body) : undefined,
                headers,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        try {
                            resolve(res.responseText ? JSON.parse(res.responseText) : null);
                        } catch (e) { resolve(null); }
                    } else {
                        reject(new Error(`Supabase ${method} ${path} failed: ${res.status} ${res.responseText}`));
                    }
                },
                onerror: (e) => reject(new Error(`Supabase network error`))
            });
        });
    }

    async function cloudPull(rowKey) {
        try {
            // GET /rest/v1/memories?row_key=eq.<key>&select=data
            const rows = await supabaseRequest('GET', `memories?row_key=eq.${encodeURIComponent(rowKey)}&select=data`);
            if (rows && rows.length > 0 && rows[0].data) {
                return JSON.parse(rows[0].data);
            }
        } catch (e) {
            console.warn('[Memory Tracker] Pull failed:', e.message);
        }
        return null;
    }

    async function cloudPush(rowKey, userID, cache) {
        try {
            const payload = {
                row_key: rowKey,
                user_id: String(userID),
                data: JSON.stringify(cache),
                updated_at: new Date().toISOString()
            };
            // Upsert via Prefer: resolution=merge-duplicates on the PK
            await supabaseRequest('POST', 'memories', payload, {
                'Prefer': 'resolution=merge-duplicates,return=minimal'
            });
            return true;
        } catch (e) {
            console.warn('[Memory Tracker] Push failed:', e.message);
            return false;
        }
    }

    // ============================================================
    // MERGE — combine two caches by card index
    // ============================================================
    function mergeCaches(a, b) {
        const map = new Map();
        const consider = (card) => {
            if (!card || card.index === undefined) return;
            const existing = map.get(card.index);
            if (!existing) {
                map.set(card.index, card);
            } else {
                const existingScore = (existing.avatar_url ? 2 : 0) + (existing.badge_text ? 1 : 0);
                const newScore = (card.avatar_url ? 2 : 0) + (card.badge_text ? 1 : 0);
                if (newScore > existingScore) map.set(card.index, card);
            }
        };
        (a || []).forEach(consider);
        (b || []).forEach(consider);
        return Array.from(map.values());
    }

    // ============================================================
    // SYNC ORCHESTRATION
    // ============================================================
    let syncTimeout = null;
    let syncInFlight = false;

    async function fullSync() {
        const cfg = getConfig();
        if (!cfg || !cfg.userID || !cfg.pinHash) return;
        if (syncInFlight) return;
        syncInFlight = true;

        try {
            const rowKey = buildRowKey(cfg.userID, cfg.pinHash);
            const cloudCache = await cloudPull(rowKey);
            const localCache = getCache();
            const merged = mergeCaches(localCache, cloudCache);

            const cloudCount = cloudCache ? cloudCache.length : 0;
            const localCount = localCache.length;
            const mergedCount = merged.length;

            if (mergedCount !== localCount) {
                saveCache(merged);
                renderHints();
            }
            if (mergedCount !== cloudCount) {
                await cloudPush(rowKey, cfg.userID, merged);
            }
            updateStatus(`✅ Synced (${mergedCount})`);
        } catch (e) {
            console.error('[Memory Tracker] Sync error:', e);
            updateStatus('⚠️ Sync failed');
        } finally {
            syncInFlight = false;
        }
    }

    function scheduleSync() {
        const cfg = getConfig();
        if (!cfg || !cfg.userID || !cfg.pinHash) return;
        clearTimeout(syncTimeout);
        syncTimeout = setTimeout(fullSync, SYNC_DEBOUNCE_MS);
    }

    // ============================================================
    // CACHE UPDATE FROM API RESPONSES
    // ============================================================
    function updateCacheFromResponse(json) {
        if (!json || json.code !== 200 || !json.data) return;
        const data = json.data;
        let currentCache = getCache();
        let hasChanges = false;

        const fromBoard = (data.board || []).filter(c => c.state === 'revealed' && c.avatar_url);
        const fromTemp = data.temporaryRevealedCards || [];
        const allRevealed = [...fromBoard, ...fromTemp];

        allRevealed.forEach(card => {
            const existingIndex = currentCache.findIndex(item => item.index === card.index);
            const cardData = {
                index: card.index,
                avatar_url: card.avatar_url,
                quality: card.quality,
                badge_text: card.badge_text
            };

            if (existingIndex === -1 && cardData.avatar_url) {
                currentCache.push(cardData);
                hasChanges = true;
            } else if (existingIndex > -1) {
                const existing = currentCache[existingIndex];
                if (existing.avatar_url !== cardData.avatar_url || existing.badge_text !== cardData.badge_text) {
                    currentCache[existingIndex] = cardData;
                    hasChanges = true;
                }
            }
        });

        if (hasChanges) {
            saveCache(currentCache);
            renderHints();
            scheduleSync();
        }
    }

    // ============================================================
    // UI
    // ============================================================
    let statusEl = null;
    function updateStatus(text) {
        if (statusEl) {
            statusEl.innerText = text;
            setTimeout(() => { if (statusEl) statusEl.innerText = ''; }, 4000);
        }
    }

    function styledButton(text) {
        const btn = document.createElement('button');
        btn.innerText = text;
        Object.assign(btn.style, {
            display: 'inline-block',
            margin: '4px',
            padding: '6px 12px',
            background: 'rgba(34, 34, 34, 0.9)',
            color: '#FF8000',
            border: '1px solid #FF8000',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '11px',
            fontWeight: 'bold',
            textTransform: 'uppercase'
        });
        return btn;
    }

    // Single entry point for: first-time setup, adding another device, and rotating to a new event.
    // Which of the three it is gets DERIVED from the answers (is there a config? did the event name
    // change?), not from which button was clicked — so the cache wipe can never be skipped by
    // picking the "wrong" button.
    async function promptSync() {
        const cfg = getConfig();
        const userID = (cfg && cfg.userID) || autoDetectUserID();
        if (!userID) {
            alert('Nie udało się wykryć user ID ze strony. Upewnij się że jesteś zalogowany i spróbuj ponownie.');
            return;
        }

        const pin = window.prompt(
            `Wykryto user ID: ${userID}\n\n` +
            `Podaj PIN synchronizacji (4-32 znaki — TAKI SAM na wszystkich urządzeniach, nie da się odzyskać):`,
            ''
        );
        if (!pin || pin.length < 4) {
            alert('PIN musi mieć co najmniej 4 znaki.');
            return;
        }

        const currentEvent = (cfg && cfg.event) || '';
        const event = window.prompt(
            'Podaj nazwę eventu (np. "event-2026-01").\n' +
            'Ten sam event = te same karty. Na kolejnych urządzeniach wpisz TAK SAMO.\n' +
            'Nowa nazwa = nowy event: lokalne karty zostaną wyczyszczone.',
            currentEvent || 'event-1'
        );
        if (!event || !event.trim()) return;
        const eventClean = event.trim();

        // Wipe when starting a different event, and also on a fresh install where a stale cache
        // could otherwise leak into the new cloud row (cloud is append/update-only).
        const isEventChange = eventClean !== currentEvent;
        const cacheCount = getCache().length;
        const mustWipe = isEventChange && cacheCount > 0;

        if (mustWipe) {
            const confirmed = window.confirm(
                `Przełączam na event: "${eventClean}"` +
                (currentEvent ? ` (z "${currentEvent}")` : '') + `\n\n` +
                `Lokalne dane (${cacheCount} kart) zostaną wyczyszczone.\n` +
                `Dane w chmurze pozostaną (stare eventy są zachowane, ale niedostępne z tego skryptu).\n\n` +
                `Kontynuować?`
            );
            if (!confirmed) return;
        }

        const pinHash = await computePinHash(userID, pin, eventClean);
        saveConfig({ userID: String(userID).trim(), pinHash, event: eventClean });

        if (mustWipe) {
            localStorage.setItem(STORAGE_KEY, '[]');
            document.querySelectorAll('.tm-helper-hint').forEach(el => el.remove());
            document.querySelectorAll('[data-tm-rendered]').forEach(el => el.removeAttribute('data-tm-rendered'));
            document.querySelectorAll('.tm-pair-card').forEach(el => el.classList.remove('tm-pair-card'));
        }

        updateStatus(isEventChange ? `🆕 Event: ${eventClean}` : '🔗 Zapisano, synchronizuję...');
        fullSync();
    }

    // PANIC MODE — full local reset. Wipes cache + config from this browser so the user can start
    // over when they have forgotten their PIN / event name. Cloud rows are NOT touched (they are
    // append/update-only by design) — they simply become unreachable without the old PIN+event.
    function panicReset() {
        const cfg = getConfig();
        const cacheCount = getCache().length;
        const confirmed = window.confirm(
            '🚨 PANIC MODE — pełny reset lokalny\n\n' +
            `Usunę z tej przeglądarki:\n` +
            `  • cache kart (${cacheCount} zapisanych)\n` +
            `  • konfigurację (user ID, PIN, event${cfg && cfg.event ? `: "${cfg.event}"` : ''})\n\n` +
            'Dane w chmurze NIE zostaną usunięte, ale bez starego PIN-u i nazwy eventu\n' +
            'nie da się do nich wrócić.\n\n' +
            'Po resecie skonfiguruj wszystko od nowa przez "Sync".\n\n' +
            'Na pewno kontynuować?'
        );
        if (!confirmed) return;

        const doubleCheck = window.prompt(
            'Ostatnie potwierdzenie.\n\nWpisz RESET (wielkimi literami), aby wyczyścić wszystko:',
            ''
        );
        if (doubleCheck !== 'RESET') {
            updateStatus('❌ Anulowano reset');
            return;
        }

        // Stop any pending sync so it cannot re-save the old config after the wipe.
        clearTimeout(syncTimeout);
        syncTimeout = null;

        try {
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(CONFIG_KEY);
            // Sweep any legacy/leftover keys this script family may have written.
            Object.keys(localStorage)
                .filter(k => k.indexOf('eclesiar_memory') === 0)
                .forEach(k => localStorage.removeItem(k));
        } catch (e) {
            console.error('[Memory Tracker] Panic reset error', e);
            alert('Nie udało się wyczyścić localStorage: ' + e.message);
            return;
        }

        // Clear rendered hints + pair markers so the board looks like a fresh install.
        document.querySelectorAll('.tm-helper-hint').forEach(el => el.remove());
        document.querySelectorAll('[data-tm-rendered]').forEach(el => el.removeAttribute('data-tm-rendered'));
        document.querySelectorAll('.tm-pair-card').forEach(el => el.classList.remove('tm-pair-card'));
        const label = document.getElementById('tm-event-label');
        if (label) label.innerText = '';

        updateStatus('🧹 Reset zakończony');
        alert('✅ Wyczyszczono wszystkie dane lokalne.\n\nKliknij "Sync", aby skonfigurować od nowa.');
    }

    // Helper: is this element actually visible (rendered)? Returns false for display:none.
    function isVisible(el) {
        return !!el && el.offsetParent !== null;
    }

    function createUI() {
        // If a previous #tm-controls exists but its parent is no longer visible
        // (e.g. layout switched between desktop and mobile modal), remove it so
        // we can create a fresh one in the currently visible container.
        const existing = document.getElementById('tm-controls');
        if (existing) {
            if (isVisible(existing)) return;
            existing.remove();
        }

        // Both desktop and mobile modals may exist in the DOM at the same time — only one
        // is actually displayed. We must check visibility, not just presence.
        const desktopGrid = document.querySelector('#memoryGridDesktop');
        const mobileGrid  = document.querySelector('#memoryGridMobile');
        const isDesktop = isVisible(desktopGrid);
        const isMobile  = isVisible(mobileGrid);

        let container, insertMode;
        if (isDesktop) {
            // Desktop: put controls in the left panel, above the rules list.
            // Must scope to the visible desktop modal's left panel.
            const panels = document.querySelectorAll('.memory-left-panel');
            for (const p of panels) {
                if (isVisible(p)) { container = p; break; }
            }
            insertMode = 'prepend';
        } else if (isMobile) {
            // Mobile: put controls right after .memory-deck-header, in the outer flex-column.
            const headers = document.querySelectorAll('.memory-deck-header');
            for (const h of headers) {
                if (isVisible(h)) { container = h; break; }
            }
            insertMode = 'sibling';
        }

        // Fallback: neither known grid is visible — pick the first visible candidate
        if (!container) {
            const fallbacks = ['.memory-left-panel', '.memory-deck-header', '.memory-right-panel', '.memory-board'];
            for (const sel of fallbacks) {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    if (isVisible(el)) { container = el; break; }
                }
                if (container) break;
            }
            insertMode = 'prepend';
        }
        if (!container) return;

        const wrap = document.createElement('div');
        wrap.id = 'tm-controls';
        Object.assign(wrap.style, {
            display: 'flex',
            // Desktop = narrow left column → stack vertically. Mobile = horizontal row.
            flexDirection: isDesktop ? 'column' : 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            margin: '10px 0',
            gap: '4px',
            width: '100%',
            justifyContent: 'center'
        });

        const setupBtn = styledButton('🔗 Sync');
        setupBtn.title = 'Konfiguracja synchronizacji: PIN + event (nowa nazwa eventu = start od zera)';
        setupBtn.onclick = (e) => { e.preventDefault(); promptSync(); };
        wrap.appendChild(setupBtn);

        const syncBtn = styledButton('🔄 Sync Now');
        syncBtn.onclick = (e) => {
            e.preventDefault();
            const cfg = getConfig();
            if (!cfg) { alert('Najpierw skonfiguruj synchronizację.'); return; }
            updateStatus('🔄 Synchronizuję...');
            fullSync();
        };
        wrap.appendChild(syncBtn);

        // Destructive — styled red so it is not confused with the normal actions.
        const panicBtn = styledButton('🚨 Panic Mode');
        panicBtn.title = 'Wyczyść cache i konfigurację z tej przeglądarki (zapomniany PIN / event)';
        panicBtn.style.color = '#E63946';
        panicBtn.style.borderColor = '#E63946';
        panicBtn.onclick = (e) => { e.preventDefault(); panicReset(); };
        wrap.appendChild(panicBtn);

        statusEl = document.createElement('span');
        Object.assign(statusEl.style, {
            marginLeft: '8px',
            color: '#FF8000',
            fontSize: '10px',
            fontWeight: 'bold'
        });
        wrap.appendChild(statusEl);

        // Persistent label showing active event
        const eventLabel = document.createElement('span');
        eventLabel.id = 'tm-event-label';
        Object.assign(eventLabel.style, {
            marginLeft: '8px',
            color: '#E63946',           // red — visible on both dark and light (wood) backgrounds
            fontSize: '11px',
            fontWeight: 'bold',
            textShadow: '1px 1px 2px rgba(0,0,0,0.7)'
        });
        const cfg = getConfig();
        if (cfg && cfg.event) {
            eventLabel.innerText = `📅 ${cfg.event}`;
        }
        wrap.appendChild(eventLabel);

        // Mobile: sibling-insert to preserve the inline-flex row of Zasady + attempts.
        // Desktop: prepend into the left panel above the rules list.
        if (insertMode === 'sibling' && container.parentNode) {
            container.parentNode.insertBefore(wrap, container.nextSibling);
        } else {
            container.prepend(wrap);
        }

        if (!getConfig()) {
            updateStatus('ℹ️ Kliknij "Sync"');
        }
    }

    // ============================================================
    // AUTO-DETECT USER ID — from <a href="/user/{numeric_id}"> in the page
    // ============================================================
    function autoDetectUserID() {
        try {
            // Look at ALL /user/... links and take the first one whose ID is numeric.
            // This skips things like /user/settings, /user/profile, etc.
            const links = document.querySelectorAll('a[href*="/user/"]');
            for (const link of links) {
                const href = link.getAttribute('href') || '';
                const m = href.match(/\/user\/(\d+)(?:[\/?#]|$)/);
                if (m) return m[1];
            }
        } catch (e) {}
        return null;
    }

    // ============================================================
    // HOOKS (fetch + XHR)
    // ============================================================
    const originalFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const url = typeof args[0] === 'string' ? args[0] : args[0].url;
        if (url && url.includes('/events/memory/flip')) {
            const clone = response.clone();
            clone.json().then(updateCacheFromResponse).catch(() => {});
        }
        return response;
    };

    const open = unsafeWindow.XMLHttpRequest.prototype.open;
    unsafeWindow.XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url;
        return open.apply(this, arguments);
    };

    const send = unsafeWindow.XMLHttpRequest.prototype.send;
    unsafeWindow.XMLHttpRequest.prototype.send = function() {
        this.addEventListener('load', function() {
            if (this._url && this._url.includes('/events/memory/flip')) {
                try {
                    const json = JSON.parse(this.responseText);
                    updateCacheFromResponse(json);
                } catch (e) {}
            }
        });
        return send.apply(this, arguments);
    };

    // ============================================================
    // RENDER HINTS
    // ============================================================
    function renderHints() {
        const cache = getCache();
        if (!cache.length) return;
        document.querySelectorAll('.memory-card:not([data-tm-rendered])').forEach(cardEl => {
            const dataIndex = parseInt(cardEl.getAttribute('data-index'));
            const savedData = cache.find(item => item.index === dataIndex);
            if (savedData) applyVisualHint(cardEl, savedData);
        });
        markPairs(cache);
    }

    // Highlight matchable pairs: two or more known cards currently on the board that share the same
    // avatar_url|badge_text|quality are a claimable pair. Re-run every render (the pair only becomes
    // available once the SECOND card is known), toggling a pulsing marker so you notice it and do not miss it.
    function injectPairStyle() {
        if (document.getElementById('tm-pair-style')) return;
        const st = document.createElement('style');
        st.id = 'tm-pair-style';
        st.textContent =
            '@keyframes tm-pair-pulse{0%,100%{box-shadow:0 0 0 3px rgba(255,215,0,.9),0 0 10px 3px rgba(255,215,0,.6)}50%{box-shadow:0 0 0 3px rgba(255,215,0,1),0 0 22px 7px rgba(255,215,0,.9)}}' +
            // Glow the whole card element so it shows whichever way the card is facing (a just-flipped card
            // still marks its face-down partner). Applied to every duplicate DOM block of the same index.
            '.memory-card.tm-pair-card{animation:tm-pair-pulse 1.1s ease-in-out infinite;border-radius:8px;position:relative;z-index:5}' +
            '.tm-helper-hint.tm-pair{border-style:solid!important;border-color:gold!important;border-width:3px!important}' +
            ".tm-helper-hint.tm-pair::after{content:'\\2691 PAIR';position:absolute;bottom:4px;right:4px;font-size:9px;font-weight:bold;color:#111;background:gold;padding:1px 4px;border-radius:4px;letter-spacing:.3px}";
        document.head.appendChild(st);
    }

    function markPairs(cache) {
        injectPairStyle();
        // The board renders each card as MORE THAN ONE .memory-card element (e.g. desktop + mobile blocks),
        // so collect ALL elements per data-index. An index is CLAIMED (already matched -> not a live pair)
        // if any of its elements carries `is-claimed`.
        const byIdx = new Map();
        document.querySelectorAll('.memory-card[data-index]').forEach(el => {
            const idx = parseInt(el.getAttribute('data-index'));
            if (isNaN(idx)) return;
            if (!byIdx.has(idx)) byIdx.set(idx, { els: [], claimed: false });
            const rec = byIdx.get(idx);
            rec.els.push(el);
            if (el.classList.contains('is-claimed')) rec.claimed = true;
        });
        // Group known, present, NOT-claimed cards by their pair key. Normalize the avatar URL (identical
        // rewards can carry a different ?v=<hash>); badge_text + quality complete the pair identity.
        const groups = new Map();
        (cache || []).forEach(item => {
            const rec = byIdx.get(item.index);
            if (!rec || rec.claimed || !item.avatar_url) return;
            const av = String(item.avatar_url).split('?')[0];
            const key = av + '|' + (item.badge_text || '') + '|' + (item.quality != null ? item.quality : '');
            if (!groups.has(key)) groups.set(key, new Set());
            groups.get(key).add(item.index);
        });
        // Indices with >= 2 distinct still-in-play cards sharing a face = a claimable pair.
        const paired = new Set();
        groups.forEach(idxSet => { if (idxSet.size >= 2) idxSet.forEach(i => paired.add(i)); });
        // Mark every DOM element of each index (so the visible block gets it): glow the card + flag the
        // face-down hint overlay with the PAIR badge.
        byIdx.forEach((rec, idx) => {
            const on = paired.has(idx);
            rec.els.forEach(el => {
                el.classList.toggle('tm-pair-card', on);
                const hint = el.querySelector('.card-back .tm-helper-hint');
                if (hint) hint.classList.toggle('tm-pair', on);
            });
        });
    }

    function applyVisualHint(cardEl, data) {
        const backFace = cardEl.querySelector('.card-back');
        if (!backFace) return;

        cardEl.setAttribute('data-tm-rendered', 'true');
        const qualityColors = { 0: '#B2B2B2', 1: '#1EFF00', 2: '#0070DD', 3: '#A335EE', 4: '#FF8000', 5: '#E6CC80' };
        const q = parseInt(data.quality) || 0;
        const borderColor = qualityColors[q] || '#ffffff';
        const starUrl = "https://eclesiar.com/assets/icons/star.png";

        // SECURITY: card fields (avatar_url, badge_text) can arrive from the SHARED Supabase cloud cache,
        // not just the live game — treat them as untrusted. Build the overlay with the DOM API (no
        // innerHTML), set badge via textContent, and only accept an avatar image served over https from
        // eclesiar.com. Otherwise a poisoned cloud row could inject script into the eclesiar.com origin.
        const safeAvatar = (typeof data.avatar_url === 'string'
            && /^https:\/\/([a-z0-9-]+\.)*eclesiar\.com\//i.test(data.avatar_url)) ? data.avatar_url : '';

        const hint = document.createElement('div');
        hint.className = 'tm-helper-hint';
        Object.assign(hint.style, {
            position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.6)', borderRadius: '8px', border: `2px dashed ${borderColor}`,
            pointerEvents: 'none', zIndex: '10'
        });

        const badge = document.createElement('div');
        Object.assign(badge.style, {
            position: 'absolute', top: '4px', right: '6px', fontSize: '11px',
            fontWeight: 'bold', color: 'white', textShadow: '1px 1px 2px black'
        });
        badge.textContent = data.badge_text || '';
        hint.appendChild(badge);

        if (safeAvatar) {
            const img = document.createElement('img');
            img.src = safeAvatar;
            Object.assign(img.style, { width: '70%', height: '70%', objectFit: 'contain', opacity: '0.8' });
            hint.appendChild(img);
        }

        const stars = document.createElement('div');
        Object.assign(stars.style, { position: 'absolute', bottom: '4px', left: '4px', display: 'flex', alignItems: 'center' });
        for (let i = 0; i < q; i++) {
            const s = document.createElement('img');
            s.src = starUrl;
            Object.assign(s.style, { width: '10px', height: '10px', marginRight: '1px', filter: 'drop-shadow(1px 1px 1px black)' });
            stars.appendChild(s);
        }
        hint.appendChild(stars);

        backFace.appendChild(hint);
    }

    // ============================================================
    // INIT
    // ============================================================
    let renderTimeout;
    const debouncedRender = () => {
        clearTimeout(renderTimeout);
        renderTimeout = setTimeout(() => {
            createUI();
            renderHints();
        }, 50);
    };

    const init = () => {
        debouncedRender();
        if (getConfig()) {
            setTimeout(fullSync, 1000);
        }
        new MutationObserver(mutations => {
            const isOurChange = mutations.some(m =>
                Array.from(m.addedNodes).some(n =>
                    n.id === 'tm-controls' || (n.classList && n.classList.contains('tm-helper-hint'))
                )
            );
            if (!isOurChange) debouncedRender();
        }).observe(document.body, { childList: true, subtree: true });
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
