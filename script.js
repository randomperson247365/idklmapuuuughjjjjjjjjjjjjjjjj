// PeerTube Enhanced Multi-Instance Plugin - v30
// Fix: return properly-typed PlatformVideo objects so ContentItem.contentType is set.
// Includes: robust parseSettings, instance URL normalization, dedupe, per-channel cap, language filter.

// ---- Basic constants ----
const PLATFORM = "PeerTube";
const FALLBACK_CONFIG_ID = "enhanced-peertube-multi-instance";

// ---- Small safe logger ----
function logSafe(msg) {
    try { if (bridge && bridge.log) bridge.log(String(msg)); else console.log(msg); } catch (e) {}
}

// ---- JSON.parse shim (non-destructive) ----
(function() {
    try {
        if (typeof JSON !== 'undefined' && typeof JSON.parse === 'function') {
            const _orig = JSON.parse;
            JSON.parse = function (input) {
                try { return _orig.call(JSON, input); }
                catch (err) {
                    // keep original behavior: rethrow after logging (so existing try/catch still works)
                    try { logSafe("[JSON.parse shim] parse failed: " + err); } catch (_) {}
                    throw err;
                }
            };
        }
    } catch (e) {}
})();

// ---- Utilities: normalize instance URL candidate ----
function normalizeInstanceUrlCandidate(raw) {
    if (!raw && raw !== 0) return null;
    try {
        if (typeof raw === 'object' && raw !== null) {
            if (raw.url) raw = raw.url;
            else if (raw.value) raw = raw.value;
            else raw = JSON.stringify(raw);
        }
        let s = String(raw).trim();
        if (!s) return null;
        if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
        s = s.replace(/\/+$/,''); // remove trailing slash
        return s;
    } catch (e) { return null; }
}

// ---- Robust parseSettings (handles string/array/object shapes) ----
function parseSettings(settingsCandidate) {
    const s = settingsCandidate || plugin?.settings || {};
    const parsed = {};

    // instancesList: accept array, comma-separated string, or object
    let rawInstances = s.instancesList;
    const instances = [];

    if (Array.isArray(rawInstances)) {
        rawInstances.forEach(item => { const n = normalizeInstanceUrlCandidate(item); if (n) instances.push(n); });
    } else if (typeof rawInstances === 'string') {
        rawInstances.split(',').map(x => x.trim()).forEach(item => { if (item) { const n = normalizeInstanceUrlCandidate(item); if (n) instances.push(n); }});
    } else if (rawInstances && typeof rawInstances === 'object') {
        if (Array.isArray(rawInstances.value)) {
            rawInstances.value.forEach(item => { const n = normalizeInstanceUrlCandidate(item); if (n) instances.push(n); });
        } else if (typeof rawInstances.value === 'string') {
            rawInstances.value.split(',').map(x => x.trim()).forEach(item => { if (item) { const n = normalizeInstanceUrlCandidate(item); if (n) instances.push(n); }});
        } else {
            // try to pluck strings
            Object.keys(rawInstances).forEach(k => {
                const v = rawInstances[k];
                if (typeof v === 'string' && v.length < 500) {
                    v.split(',').map(x=>x.trim()).forEach(item => { const n = normalizeInstanceUrlCandidate(item); if (n) instances.push(n); });
                }
            });
        }
    }

    if (!instances.length) instances.push('https://peertube.futo.org');
    parsed.instancesList = [...new Set(instances)];

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

    // preferredLanguages accept array or CSV string
    parsed.preferredLanguages = [];
    if (Array.isArray(s.preferredLanguages)) parsed.preferredLanguages = s.preferredLanguages.map(x=>String(x).trim().toLowerCase()).filter(Boolean);
    else if (typeof s.preferredLanguages === 'string') parsed.preferredLanguages = s.preferredLanguages.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
    else if (s.preferredLanguages && typeof s.preferredLanguages === 'object' && typeof s.preferredLanguages.value === 'string') parsed.preferredLanguages = s.preferredLanguages.value.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);

    parsed.seenMax = Math.max(0, intFrom(s.seenMax, 500));
    parsed.submitActivity = boolFrom(s.submitActivity, true);

    return parsed;
}

// ---- seen IDs list and helper ----
let seenList = [];
function pushSeen(id, limit) {
    if (!id) return;
    if (!Array.isArray(seenList)) seenList = [];
    if (seenList.indexOf(id) === -1) seenList.unshift(id);
    if (limit && seenList.length > limit) seenList = seenList.slice(0, limit);
}

// ---- Helper to create PlatformVideo (defensive) ----
function buildPlatformVideoFromPeerTube(v, instanceBaseUrl) {
    // Prefer platform-specific constructors if available, fallback to minimal object with contentType set
    try {
        // prepare platform primitives if they exist
        const platformIdClass = typeof PlatformID !== 'undefined' ? PlatformID : null;
        const authorLinkClass = typeof PlatformAuthorLink !== 'undefined' ? PlatformAuthorLink : null;
        const thumbnailClass = typeof Thumbnail !== 'undefined' ? Thumbnail : null;
        const thumbnailsClass = typeof Thumbnails !== 'undefined' ? Thumbnails : null;
        const platformVideoClass = typeof PlatformVideo !== 'undefined' ? PlatformVideo : null;
        const configId = (typeof plugin !== 'undefined' && plugin.id) ? plugin.id : FALLBACK_CONFIG_ID;

        const idObj = platformIdClass ? new platformIdClass(PLATFORM, v.uuid, configId) : { platform: PLATFORM, value: v.uuid, owner: configId };

        const authorUrl = (v.account && v.account.url) ? v.account.url : (instanceBaseUrl || '');
        const author = authorLinkClass ? new authorLinkClass(new platformIdClass(PLATFORM, v.account?.name || (v.account?.url || 'unknown'), configId), v.account?.displayName || v.account?.name || 'Unknown', authorUrl, null, v.account?.followersCount || 0) : { id: { platform: PLATFORM, value: v.account?.name || '' }, name: v.account?.displayName || v.account?.name || 'Unknown', url: authorUrl };

        const thumbArr = [];
        if (v.thumbnailPath) {
            const thumbUrl = (instanceBaseUrl || '') + v.thumbnailPath;
            if (thumbnailClass) thumbArr.push(new thumbnailClass(thumbUrl, 0));
            else thumbArr.push({ url: thumbUrl, width: 0 });
        }

        let thumbnailsObj = thumbnailsClass ? new thumbnailsClass(thumbArr) : { items: thumbArr };

        if (platformVideoClass) {
            // construct PlatformVideo with the likely fields the host expects
            const pv = new platformVideoClass({
                id: idObj,
                name: v.name || '',
                thumbnails: thumbnailsObj,
                author: author,
                datetime: Math.round((new Date(v.publishedAt)).getTime() / 1000),
                duration: v.duration || 0,
                viewCount: v.views || 0,
                url: (instanceBaseUrl ? (instanceBaseUrl + '/w/' + v.uuid) : (v.url || '')),
                isLive: !!v.isLive,
                description: v.description || ''
            });
            return pv;
        } else {
            // fallback: minimal object but include contentType integer the host expects
            // Many hosts use numeric content types; use 1 for video if unknown.
            return {
                contentType: 1,
                id: { platform: PLATFORM, value: v.uuid, owner: configId },
                name: v.name || '',
                thumbnails: thumbArr,
                author: author,
                datetime: Math.round((new Date(v.publishedAt)).getTime() / 1000),
                duration: v.duration || 0,
                viewCount: v.views || 0,
                url: (instanceBaseUrl ? (instanceBaseUrl + '/w/' + v.uuid) : (v.url || '')),
                isLive: !!v.isLive,
                description: v.description || ''
            };
        }
    } catch (e) {
        // last-resort fallback object (ensures contentType present)
        return {
            contentType: 1,
            id: { platform: PLATFORM, value: v.uuid || (v.id || ''), owner: FALLBACK_CONFIG_ID },
            name: v.name || '',
            url: v.url || '',
            datetime: Math.round((new Date(v.publishedAt || Date.now())).getTime() / 1000),
            duration: v.duration || 0,
            description: v.description || '',
            thumbnails: [],
            author: { name: v.account?.displayName || v.account?.name || 'Unknown', url: v.account?.url || '' }
        };
    }
}

// ---- getHome: aggregate from instances, return VideoPager of PlatformVideo items ----
source.getHome = function (continuationToken) {
    const rawSettings = plugin?.settings || {};
    const settings = parseSettings(rawSettings);

    // choose instances (random vs ordered)
    let instances = settings.instancesList || ['https://peertube.futo.org'];
    if (settings.randomizeInstances) {
        const arr = instances.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        instances = arr.slice(0, Math.min(settings.instanceSampleSize, arr.length));
    }

    const fetchedEntries = [];

    for (const baseUrl of instances) {
        try {
            const apiUrl = `${baseUrl}/api/v1/videos?sort=-publishedAt&start=0&count=20`;
            const resp = (typeof Http !== 'undefined') ? Http.GET(apiUrl, {}) : http.GET(apiUrl, {});
            if (!resp || !resp.isOk) { logSafe(`[getHome] ${baseUrl} non-ok response`); continue; }
            let body;
            try { body = JSON.parse(resp.body); } catch (e) { logSafe(`[getHome] parse error for ${baseUrl}: ${e}`); continue; }
            const data = body && body.data ? body.data : [];
            for (const v of data) {
                if (!v || !v.uuid) continue;
                fetchedEntries.push({ instance: baseUrl, video: v });
            }
        } catch (e) {
            logSafe(`[getHome] fetch error for ${baseUrl}: ${e}`);
        }
    }

    // Deduplicate by id and apply per-channel cap + language filter
    const seen = new Set();
    const perChannelCount = {};
    const finalItems = [];

    for (const entry of fetchedEntries) {
        const v = entry.video;
        const vid = v.uuid;
        if (!vid) continue;
        if (seen.has(vid)) continue;
        if (seenList.includes(vid)) continue; // recent global seen
        // language filter
        if (settings.preferredLanguages && settings.preferredLanguages.length) {
            const vlang = (v.language || v.languageId || '').toString().toLowerCase();
            if (vlang && settings.preferredLanguages.indexOf(vlang) === -1) continue;
        }
        const channelKey = v.account?.url || v.account?.name || 'unknown';
        perChannelCount[channelKey] = perChannelCount[channelKey] || 0;
        if (perChannelCount[channelKey] >= settings.maxPerChannel) continue;
        perChannelCount[channelKey]++;

        // build PlatformVideo (or fallback object with contentType)
        const built = buildPlatformVideoFromPeerTube(v, entry.instance);
        finalItems.push(built);

        seen.add(vid);
        pushSeen(vid, settings.seenMax);
        if (finalItems.length >= 20) break;
    }

    // Return VideoPager containing typed items
    try {
        return new VideoPager(finalItems, false, {});
    } catch (e) {
        // If VideoPager constructor demands special types, attempt a very minimal wrapper:
        logSafe('[getHome] VideoPager constructor failed: ' + e);
        // Ensure each item has numeric contentType (1)
        const safeItems = finalItems.map(it => { if (typeof it.contentType === 'undefined') it.contentType = 1; return it; });
        // host might accept a plain object list via VideoPager
        return new VideoPager(safeItems, false, {});
    }
};

// ---- search (return properly-typed items similarly) ----
source.search = function (query, type, order, filters) {
    const settings = parseSettings(plugin?.settings || {});
    const results = [];
    for (const baseUrl of settings.instancesList) {
        try {
            const apiUrl = `${baseUrl}/api/v1/search/videos?search=${encodeURIComponent(query)}&count=20`;
            const resp = (typeof Http !== 'undefined') ? Http.GET(apiUrl, {}) : http.GET(apiUrl, {});
            if (!resp || !resp.isOk) continue;
            let body;
            try { body = JSON.parse(resp.body); } catch (e) { continue; }
            const data = body && body.data ? body.data : [];
            for (const v of data) {
                const built = buildPlatformVideoFromPeerTube(v, baseUrl);
                results.push(built);
            }
        } catch (e) {
            logSafe(`[search] error for ${baseUrl}: ${e}`);
        }
    }
    return new VideoPager(results, false, {});
};

// ---- enable / saveState ----
source.enable = function (conf, settings, saveStateStr) {
    try {
        // Save host-provided settings for later usage
        plugin.settings = settings || plugin.settings || {};
        logSafe('PeerTube Enhanced Multi-Instance plugin enabled (v30).');
    } catch (e) { logSafe('enable error: ' + e); }
};
source.saveState = function () {
    try { return JSON.stringify({ seenList }); } catch (e) { return '{}'; }
};
