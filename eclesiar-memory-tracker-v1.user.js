// ==UserScript==
// @name         Eclesiar Memory Tracker
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  Eclesiar Memory Tracker
// @author       morswin28
// @match        https://eclesiar.com/*
// @homepageURL  https://scripts.ecle.fun/
// @downloadURL  https://raw.githubusercontent.com/marsach/ecle/main/eclesiar-memory-tracker-v1.user.js
// @updateURL    https://raw.githubusercontent.com/marsach/ecle/main/eclesiar-memory-tracker-v1.user.js
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const STORAGE_KEY = 'eclesiar_memory_cache';

    const getCache = () => {
        try {
            const data = localStorage.getItem(STORAGE_KEY);
            return data ? JSON.parse(data) : [];
        } catch (e) { return []; }
    };

    const saveCache = (cache) => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)); }
        catch (e) { console.error("Błąd zapisu", e); }
    };

    // --- LOGIKA AKTUALIZACJI CACHE ---
    function updateCacheFromResponse(json) {
        if (!json || json.code !== 200 || !json.data) return;

        const data = json.data;
        let currentCache = getCache();
        let hasChanges = false;

        // Przetwarzanie danych z board oraz temporaryRevealedCards
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
        }
    }

    // --- PRZYCISK CZYSZCZENIA Z POTWIERDZENIEM ---
    function createUI() {
        const container = document.querySelector('.memory-right-panel');
        if (!container || document.getElementById('tm-clear-cache-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'tm-clear-cache-btn';
        btn.innerText = '🧹 Wyczyść Pamięć';

        Object.assign(btn.style, {
            display: 'inline-block',
            margin: '10px',
            padding: '6px 12px',
            background: 'rgba(34, 34, 34, 0.9)',
            color: '#FF8000',
            border: '1px solid #FF8000',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '11px',
            fontWeight: 'bold',
            textTransform: 'uppercase',
            zIndex: '1001'
        });

        btn.onclick = (e) => {
            e.preventDefault();

            // DODANO: Potwierdzenie akcji
            const confirmed = window.confirm("Czy na pewno chcesz wyczyścić zapamiętane karty? Tej operacji nie można cofnąć.");

            if (confirmed) {
                localStorage.setItem(STORAGE_KEY, '[]');
                document.querySelectorAll('.tm-helper-hint').forEach(el => el.remove());
                document.querySelectorAll('[data-tm-rendered]').forEach(el => el.removeAttribute('data-tm-rendered'));
                btn.innerText = '✅ Wyczyszczone!';
                setTimeout(() => btn.innerText = '🧹 Wyczyść Pamięć', 2000);
            }
        };

        container.prepend(btn);
    }

    // --- HOOKI (FETCH & XHR) ---
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

    // --- LOGIKA RENDEROWANIA ---
    function renderHints() {
        const cache = getCache();
        if (!cache.length) return;

        document.querySelectorAll('.memory-card:not([data-tm-rendered])').forEach(cardEl => {
            const dataIndex = parseInt(cardEl.getAttribute('data-index'));
            const savedData = cache.find(item => item.index === dataIndex);
            if (savedData) applyVisualHint(cardEl, savedData);
        });
    }

    function applyVisualHint(cardEl, data) {
        const backFace = cardEl.querySelector('.card-back');
        if (!backFace) return;

        cardEl.setAttribute('data-tm-rendered', 'true');
        const qualityColors = { 0: '#B2B2B2', 1: '#1EFF00', 2: '#0070DD', 3: '#A335EE', 4: '#FF8000', 5: '#E6CC80' };
        const borderColor = qualityColors[data.quality] || '#ffffff';
        const starUrl = "https://eclesiar.com/assets/icons/star.png";

        let starsHtml = "";
        for (let i = 0; i < (parseInt(data.quality) || 0); i++) {
            starsHtml += `<img src="${starUrl}" style="width:10px; height:10px; margin-right:1px; filter: drop-shadow(1px 1px 1px black);">`;
        }

        const hint = document.createElement('div');
        hint.className = 'tm-helper-hint';
        Object.assign(hint.style, {
            position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.6)', borderRadius: '8px', border: `2px dashed ${borderColor}`,
            pointerEvents: 'none', zIndex: '10'
        });

        hint.innerHTML = `
            <div style="position:absolute; top:4px; right:6px; font-size:11px; font-weight:bold; color:white; text-shadow:1px 1px 2px black;">
                ${data.badge_text || ''}
            </div>
            <img src="${data.avatar_url}" style="width:70%; height:70%; object-fit:contain; opacity:0.8;">
            <div style="position:absolute; bottom:4px; left:4px; display:flex; align-items:center;">
                ${starsHtml}
            </div>
        `;
        backFace.appendChild(hint);
    }

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
        new MutationObserver(mutations => {
            const isOurChange = mutations.some(m => Array.from(m.addedNodes).some(n => n.id === 'tm-clear-cache-btn' || (n.classList && n.classList.contains('tm-helper-hint'))));
            if (!isOurChange) debouncedRender();
        }).observe(document.body, { childList: true, subtree: true });
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
