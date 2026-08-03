// ==UserScript==
// @name         Eclesiar - Terrain Preset Reminder
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Automated terrain preset validation.
// @author       morswin28
// @match        https://eclesiar.com/war/*
// @homepageURL  https://scripts.ecle.fun/
// @downloadURL  https://raw.githubusercontent.com/marsach/ecle/main/eclesiar-terrain-preset-reminder.user.js
// @updateURL    https://raw.githubusercontent.com/marsach/ecle/main/eclesiar-terrain-preset-reminder.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const STORAGE_KEY = 'ec_allow_presets_cache';
    const CACHE_KEY = 'ec_terrain_fetch_cache';
    const CACHE_TTL = 60000;

    let detectedTerrainName = null;
    let fetchError = false;

    const terrainTypes = [
        { name: 'Plains', asset: '0.png', display: 'Plains/Równiny' },
        { name: 'Mountains', asset: '1.png', display: 'Mountains/Góry' },
        { name: 'Forest', asset: '2.png', display: 'Forest/Las' },
        { name: 'Desert', asset: '3.png', display: 'Desert/Pustynia' }
    ];

    async function fetchBattleData() {
        const cached = sessionStorage.getItem(CACHE_KEY);
        if (cached) {
            const { timestamp, data } = JSON.parse(cached);
            if (Date.now() - timestamp < CACHE_TTL) {
                const currentUrl = window.location.href;
                const match = data.find(item => currentUrl.includes(item.href));
                if (match) {
                    detectedTerrainName = match.terrain;
                    return;
                }
            }
        }

        try {
            const response = await fetch('https://eclesiar.com/battles');
            if (!response.ok) throw new Error();

            const htmlText = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlText, 'text/html');
            const rows = doc.querySelectorAll('.page-content table tr');
            const battlesData = [];

            rows.forEach(row => {
                const link = row.querySelector('a[href*="/war/"]');
                const img = row.querySelector('img.terrain-type-img');
                if (link && img) {
                    const assetName = img.getAttribute('src').split('/').pop();
                    const match = terrainTypes.find(t => t.asset === assetName);
                    if (match) {
                        battlesData.push({ href: link.getAttribute('href'), terrain: match.name });
                    }
                }
            });

            sessionStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), data: battlesData }));

            const currentUrl = window.location.href;
            const currentMatch = battlesData.find(item => currentUrl.includes(item.href));
            if (currentMatch) detectedTerrainName = currentMatch.terrain;
            else fetchError = true;

        } catch (e) {
            fetchError = true;
        }
    }

    function getStoredData() {
        const data = localStorage.getItem(STORAGE_KEY);
        try { return data ? JSON.parse(data) : {}; } catch (e) { return {}; }
    }

    function saveToStorage() {
        const data = {};
        document.querySelectorAll('.select-terrain-config').forEach(select => {
            const terrainName = select.getAttribute('data-terrain');
            data[terrainName] = Array.from(select.selectedOptions).map(opt => opt.value);
        });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        updateValidationStatus();
    }

    function updateValidationStatus() {
        const fightBtn = document.querySelector('.fight-button p');
        if (!fightBtn) return;

        let statusSpan = document.getElementById('preset-validation-inline');
        if (!statusSpan) {
            statusSpan = document.createElement('span');
            statusSpan.id = 'preset-validation-inline';
            statusSpan.style.cssText = 'margin-left: 10px; font-size: 0.85em; display: inline-block;';
            fightBtn.appendChild(statusSpan);
        }

        if (fetchError) {
            statusSpan.innerHTML = `<span style="color: #e67e22;">[Błąd terenu]</span>`;
            return;
        }

        if (!detectedTerrainName) {
            statusSpan.innerHTML = '<i class="fas fa-spinner fa-spin" style="color: #bdc3c7;"></i>';
            return;
        }

        const activeSlot = document.querySelector('.preset-slot.active span');
        const activePresetId = activeSlot ? activeSlot.innerText.trim() : null;
        const allowedPresets = getStoredData()[detectedTerrainName] || [];

        if (allowedPresets.length === 0) {
            statusSpan.innerHTML = `<span style="color: #95a5a6;">[?]</span>`;
        } else if (activePresetId && allowedPresets.includes(activePresetId)) {
            statusSpan.innerHTML = `<span style="color: #2ecc71;">[OK]</span>`;
        } else {
            statusSpan.innerHTML = `<span style="color: #ff4d4d; text-shadow: 0 0 5px rgba(0,0,0,0.3);">[ZŁY PRESET!]</span>`;
        }
    }

    async function initUI() {
        if (document.querySelector('.tier-settings')) return;

        await fetchBattleData();
        const presetArea = document.querySelector('.preset-slot-area');
        if (!presetArea) return;

        const settingsBtn = document.createElement('div');
        settingsBtn.className = 'preset-slot c-tooltip right equipment-item tier-settings';
        settingsBtn.style.cssText = 'cursor: pointer; display: flex; align-items: center; justify-content: center; background: #2c3e50;';

        const isReady = !fetchError && detectedTerrainName;
        settingsBtn.innerHTML = isReady
            ? `<i class="fas fa-cog" style="font-size: 20px; color: #f1c40f;"></i><div class="tooltip-content">Ustawienia Allow-listy presetów</div>`
            : `<i class="fas fa-exclamation-triangle" style="font-size: 20px; color: #e67e22;"></i><div class="tooltip-content">Błąd danych terenu!</div>`;

        presetArea.appendChild(settingsBtn);

        const modalHtml = `
        <div class="modal fade" id="terrainSettingsModal" tabindex="-1" role="dialog" aria-hidden="true">
            <div class="modal-dialog modal-lg modal-dialog-centered" role="document">
                <div class="modal-content" style="background: #14212d; color: white; border: 2px solid #34495e; border-radius: 12px;">
                    <div class="modal-header" style="border-bottom: 1px solid #2c3e50;">
                        <h5 class="modal-title">Konfiguracja Allow-listy</h5>
                        <button type="button" class="close text-white" data-dismiss="modal">&times;</button>
                    </div>
                    <div class="modal-body"><div class="row" id="terrainSelectorsRow"></div></div>
                    <div class="modal-footer" style="border-top: 1px solid #2c3e50;">
                        <button type="button" class="btn btn-outline-light" data-dismiss="modal">Zamknij</button>
                    </div>
                </div>
            </div>
        </div>`;
        document.body.insertAdjacentHTML('beforeend', modalHtml);

        settingsBtn.addEventListener('click', () => {
            if (!isReady) {
                alert("⚠️ Dane terenu nie są dostępne. Odśwież stronę.");
                return;
            }

            const storedData = getStoredData();
            const container = document.getElementById('terrainSelectorsRow');
            container.innerHTML = '';

            const presets = Array.from(document.querySelectorAll('.preset-slot-area .preset-slot:not(.tier-settings)')).map(slot => ({
                id: slot.querySelector('span')?.innerText.trim(),
                name: slot.querySelector('.tooltip-content')?.innerText.trim()
            }));

            terrainTypes.forEach(terrain => {
                const isCurrent = terrain.name === detectedTerrainName;
                const selected = storedData[terrain.name] || [];
                const col = document.createElement('div');
                col.className = 'col-md-6 mb-3';
                col.innerHTML = `
                    <div style="background: #1c2d3d; padding: 12px; border-radius: 8px; border: 1px solid ${isCurrent ? '#f1c40f' : '#2c3e50'};">
                        <label style="font-weight: bold; color: ${isCurrent ? '#f1c40f' : '#3498db'}; display: flex; justify-content: space-between; width: 100%;">
                            <span>${terrain.display}</span>
                            ${isCurrent ? '<span class="badge badge-warning" style="color:#000;">AKTYWNY</span>' : ''}
                        </label>
                        <select class="form-control select-terrain-config" data-terrain="${terrain.name}" multiple style="background: #0b141a; color: #ecf0f1; border: 1px solid #34495e; height: 100px;">
                            ${presets.map(p => `<option value="${p.id}" ${selected.includes(p.id) ? 'selected' : ''}>Slot ${p.id}: ${p.name}</option>`).join('')}
                        </select>
                    </div>`;
                container.appendChild(col);
            });

            document.querySelectorAll('.select-terrain-config').forEach(sel => sel.addEventListener('change', saveToStorage));
            $('#terrainSettingsModal').modal('show');
        });

        presetArea.addEventListener('click', (e) => {
            if (e.target.closest('.preset-slot:not(.tier-settings)')) setTimeout(updateValidationStatus, 50);
        });

        updateValidationStatus();
    }

    const observer = new MutationObserver((mutations, obs) => {
        const target = document.querySelector('.preset-slot-area');
        if (target) {
            initUI();
            obs.disconnect();
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

})();
