// PeerTube Enhanced Multi-Instance Plugin - v29
// - Robust parseSettings: accepts string/array/object for instancesList
// - Normalizes instance URLs (adds https:// if missing)
// - Keeps dedupe, per-channel limits, language filtering
// - Safe enabling that respects host-provided settings

// Simple JSON.parse shim (keeps behavior but logs failures)
(function() {
    try {
        if (typeof JSON !== 'undefined' && typeof JSON.parse === 'function') {
            const _orig = JSON.parse;
            JSON.parse = function(input) {
                try { return _orig.call(JSON, input); }
                catch (err) {
                    try { if (typeof bridge !== 'undefined' && bridge.log) bridge.log('[JSON.parse SHIM] parse failed: ' + err); } catch (_) {}
                    throw err;
                }
            };
        }
    } catch (e) { /* ignore */ }
})();

/* Utilities */
function normalizeInstanceUrlCandidate(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    // if host passed an object with url property
    try {
        if (typeof raw === 'object' && raw !== null) {
            if (raw.url) s = String(raw.url).trim();
            else if (raw.value) s = String(raw.value).trim();
        }
    } catch (e) {}
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    s = s.replace(/\/+$/,''); // remove trailing slash(es)
    return s;
}

/* Defensive parseSettings: handles many shapes */
function parseSettings(settingsCandidate) {
    const s = settingsCandidate || plugin?.settings || {};
    const parsed = {};

    // --- instancesList (supports array, comma-separated string, object) ---
    let rawInstances = s.instancesList;
    const instances = [];

    // If the host already provided an array
    if (Array.isArray(rawInstances)) {
        rawInstances.forEach(item => {
            const n = normalizeInstanceUrlCandidate(item);
            if (n) instances.push(n);
        });
    } else if (typeof rawInstances === 'string') {
        rawInstances.split(',').map(x=>x.trim()).forEach(item => {
            if (!item) return;
            const n = normalizeInstanceUrlCandidate(item);
            if (n) instances.push(n);
        });
    } else if (rawInstances && typeof rawInstances === 'object') {
        // some hosts wrap settings fields in objects -> try common properties
        if (Array.isArray(rawInstances.value)) {
            rawInstances.value.forEach(item => {
                const n = normalizeInstanceUrlCandidate(item);
                if (n) instances.push(n);
            });
        } else if (typeof rawInstances.value === 'string') {
            rawInstances.value.split(',').map(x=>x.trim()).forEach(item => {
                const n = normalizeInstanceUrlCandidate(item);
                if (n) instances.push(n);
            });
        } else {
            // last resort: try to extract any string-like props
            Object.keys(rawInstances).forEach(k => {
                const v = rawInstances[k];
                if (typeof v === 'string' && v.length < 200) {
                    const candidateParts = v.split(',').map(p => p.trim()).filter(Boolean);
                    candidateParts.forEach(cp => {
                        const n = normalizeInstanceUrlCandidate(cp);
                        if (n) instances.push(n);
                    });
                }
            });
        }
    }

    // If nothing found, use a sensible default
    if (!instances.length) instances.push('https://peertube.futo.org');

    parsed.instancesList = [...new Set(instances)]; // unique

    // --- booleans and numbers (accept stringified too) ---
    const boolFrom = (val, fallback) => {
        if (typeof val === 'boolean') return val;
        if (typeof val === 'string') {
            const t = val.trim().toLowerCase();
            if (t === 'true') return true;
            if (t === 'false') return false;
        }
        return fallback;
    };
    const intFrom = (val, fallback) => {
        if (typeof val === 'number' && Number.isFinite(val)) return Math.floor(val);
        if (typeof val === 'string') {
            const n = parseInt(val.trim(), 10);
            if (!isNaN(n)) return n;
        }
        return fallback;
    };

    parsed.randomizeInstances = boolFrom(s.randomizeInstances, false);
    parsed.instanceSampleSize = Math.max(1, intFrom(s.instanceSampleSize, 3));
    parsed.maxPerChannel = Math.max(1, intFrom(s.maxPerChannel, 2));
    parsed.preferredLanguages = [];

    // languages: accept array or comma-separated string
    if (Array.isArray(s.preferredLanguages)) {
        parsed.preferredLanguages = s.preferredLanguages.map(x => String(x).trim().toLowerCase()).filter(Boolean);
    } else if (typeof s.preferredLanguages === 'string') {
        parsed.preferredLanguages = s.preferredLanguages.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    } else if (s.preferredLanguages && typeof s.preferredLanguages === 'object') {
        // attempt to extract a value property
        if (typeof s.preferredLanguages.value === 'string') {
            parsed.preferredLanguages = s.preferredLanguages.value.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
        }
    }

    parsed.seenMax = Math.max(0, intFrom(s.seenMax, 500));
    parsed.submitActivity = boolFrom(s.submitActivity, true);

    return parsed;
}

/* Minimal safe logging helper */
function logSafe(msg) {
    try { if (bridge && bridge.log) bridge.log(String(msg)); else console.log(msg); } catch (e) {}
}

/* add video to seen list safely */
let seenList = [];
function pushSeen(id, settings) {
    if (!id) return;
    seenList = Array.isArray(seenList) ? seenList : [];
    if (seenList.indexOf(id) === -1) seenList.unshift(id);
    const limit = (settings && settings.seenMax) ? settings.seenMax : 500;
    if (seenList.length > limit) seenList = seenList.slice(0, limit);
}

/* getHome: aggregated feed across instances */
source.getHome = function (continuationToken) {
    // Allow host to pass settings into this call; fallback to plugin.settings
    const rawSettings = (typeof arguments !== 'undefined' && arguments.length && arguments[0] && arguments[0].__internalSettings) ? arguments[0].__internalSettings : plugin?.settings;
    const settings = parseSettings(rawSettings || plugin?.settings || {});

    // sample instances
    let instances = settings.instancesList || ['https://peertube.futo.org'];
    if (settings.randomizeInstances) {
        // simple Fisher-Yates shuffle
        const arr = instances.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        instances = arr.slice(0, Math.min(settings.instanceSampleSize, arr.length));
    }

    const allResults = [];
    for (const baseUrl of instances) {
        try {
            const url = `${baseUrl}/api/v1/videos?sort=-publishedAt&start=0&count=20`;
            const resp = (typeof Http !== 'undefined' ? Http.GET(url, {}) : http.GET(url, {}));
            if (!resp || !resp.isOk) {
                logSafe(`[getHome] ${baseUrl} returned non-ok`);
                continue;
            }
            let body;
            try { body = JSON.parse(resp.body); } catch (e) { logSafe(`[getHome] JSON parse failed for ${baseUrl}: ${e}`); continue; }
            for (const v of (body.data || [])) {
                if (!v || !v.uuid) continue;
                if (seenList.includes(v.uuid)) continue; // global dedupe
                const channelKey = v.account?.url || v.account?.name || 'unknown';
                // enforce per-channel cap later when merging
                allResults.push({ instance: baseUrl, video: v, channelKey });
            }
        } catch (e) {
            logSafe(`[getHome] fetch error for ${baseUrl}: ${e}`);
        }
    }

    // Merge results, enforce per-channel cap and language filter
    const final = [];
    const perChannelCount = {};
    for (const entry of allResults) {
        const v = entry.video;
        const vid = v.uuid;
        if (!vid) continue;
        if (seenList.includes(vid)) continue;
        // language filtering
        if (settings.preferredLanguages && settings.preferredLanguages.length) {
            const vlang = (v.language || v.languageId || '').toString().toLowerCase();
            if (vlang && settings.preferredLanguages.indexOf(vlang) === -1) continue;
        }
        const channelKey = entry.channelKey || 'unknown';
        perChannelCount[channelKey] = perChannelCount[channelKey] || 0;
        if (perChannelCount[channelKey] >= settings.maxPerChannel) continue;
        perChannelCount[channelKey]++;
        final.push({
            id: vid,
            name: v.name,
            author: { name: v.account?.displayName || v.account?.name || 'unknown', url: v.account?.url },
            datetime: Math.round((new Date(v.publishedAt)).getTime() / 1000),
            duration: v.duration,
            viewCount: v.views || 0,
            url: `${entry.instance}/w/${v.uuid}`,
            thumbnails: v.thumbnailPath ? [{ url: entry.instance + v.thumbnailPath }] : [],
            description: v.description || '',
            isLive: v.isLive || false
        });
        pushSeen(vid, settings);
        if (final.length >= 20) break;
    }

    // Return a simple VideoPager wrapper
    return new VideoPager(final, false, {});
};

/* search implementation (robust) */
source.search = function (query, type, order, filters) {
    const settings = parseSettings(plugin?.settings || {});
    const results = [];
    for (const baseUrl of settings.instancesList) {
        try {
            const url = `${baseUrl}/api/v1/search/videos?search=${encodeURIComponent(query)}&count=20`;
            const resp = (typeof Http !== 'undefined' ? Http.GET(url, {}) : http.GET(url, {}));
            if (!resp || !resp.isOk) continue;
            let body;
            try { body = JSON.parse(resp.body); } catch (e) { continue; }
            for (const v of (body.data || [])) {
                results.push({
                    id: v.uuid,
                    name: v.name,
                    author: { name: v.account?.displayName || v.account?.name || 'unknown', url: v.account?.url },
                    datetime: Math.round((new Date(v.publishedAt)).getTime() / 1000),
                    duration: v.duration,
                    viewCount: v.views || 0,
                    url: `${baseUrl}/w/${v.uuid}`,
                    thumbnails: v.thumbnailPath ? [{ url: baseUrl + v.thumbnailPath }] : [],
                    description: v.description || '',
                    isLive: v.isLive || false
                });
            }
        } catch (e) {
            logSafe(`[search] error for ${baseUrl}: ${e}`);
        }
    }
    return new VideoPager(results, false, {});
};

/* enable: host calls this with conf, settings, saveStateStr */
source.enable = function (conf, settings, saveStateStr) {
    try {
        // store the host-provided settings for later calls
        plugin.settings = settings || plugin.settings || {};
        logSafe('PeerTube Enhanced Multi-Instance plugin enabled (v29).');
    } catch (e) {
        logSafe('enable error: ' + e);
    }
};

/* save/load state (persist seen IDs) */
source.saveState = function () {
    try { return JSON.stringify({ seenList }); } catch (e) { return '{}'; }
};
