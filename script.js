// PeerTubeScript.js - v31
// Enhanced Multi-Instance PeerTube plugin
// - robust parseSettings (accepts string/array/object)
// - retry-with-exponential-backoff before parsing host settings/saveState
// - instance URL normalization (adds https:// if missing)
// - random sampling of instances, dedupe, per-channel cap, preferred-languages filter
// - persistent seen IDs via saveState
// - uses host PlatformVideo/etc when available; always guarantees numeric contentType
// - instrumentation/logging for parsing issues

const PLATFORM = "PeerTube";
const FALLBACK_CONFIG_ID = "enhanced-peertube-multi-instance-v31";

let pluginConfig = {};          // config from source
let _settings = {};             // merged settings after parse
let state = {                   // persisted runtime state
    serverVersion: '',
    seenIds: []
};

// ---------------------- Safe logging ----------------------
function logSafe(msg) {
    try {
        if (typeof bridge !== 'undefined' && bridge.log) bridge.log(String(msg));
        else if (typeof console !== 'undefined' && console.log) console.log(String(msg));
    } catch (e) { /* swallow */ }
}

// ---------------------- JSON.parse shim for diagnostics (non-destructive) ----------------------
(function installJsonShim() {
    try {
        if (typeof JSON !== 'undefined' && typeof JSON.parse === 'function') {
            const _orig = JSON.parse;
            JSON.parse = function (input) {
                try {
                    return _orig.call(JSON, input);
                } catch (err) {
                    try {
                        logSafe(`[JSON.parse SHIM] parse failed: ${err}`);
                        // log snippet safely
                        if (typeof input === 'string') {
                            const snippet = input.length > 512 ? input.slice(0,512) + '...' : input;
                            logSafe(`[JSON.parse SHIM] snippet(512): ${snippet}`);
                        } else {
                            logSafe(`[JSON.parse SHIM] arg type: ${typeof input}`);
                        }
                    } catch (e) {}
                    throw err; // keep original behavior
                }
            };
            logSafe('[JSON.parse SHIM] installed');
        }
    } catch (e) {}
})();

// ---------------------- small helpers ----------------------
function sleepMs(ms) {
    try {
        if (typeof Thread !== 'undefined' && typeof Thread.sleep === 'function') {
            Thread.sleep(ms);
            return;
        }
    } catch (e) {}
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy-wait fallback (short) */ }
}

function waitForReady(candidate, maxAttempts = 5, baseDelay = 150) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            if (candidate && typeof candidate === 'object') return true;
            if (typeof candidate === 'string' && candidate.trim().length) return true;
        } catch (e) { /* ignore */ }
        sleepMs(baseDelay * Math.pow(2, attempt));
    }
    return false;
}

function normalizeInstanceUrlCandidate(raw) {
    try {
        if (!raw && raw !== 0) return null;
        if (typeof raw === 'object' && raw !== null) {
            if (raw.url) raw = raw.url;
            else if (raw.value) raw = raw.value;
            else raw = JSON.stringify(raw);
        }
        let s = String(raw).trim();
        if (!s) return null;
        if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
        // remove trailing slash(es)
        s = s.replace(/\/+$/, '');
        return s;
    } catch (e) {
        return null;
    }
}

// ---------------------- defensive parseSettings ----------------------
function parseSettings(settingsCandidate) {
    if (!settingsCandidate) settingsCandidate = plugin?.settings ?? {};
    const summary = {};
    try {
        // we'll build parsed settings here
        const parsed = {};

        // INSTANCES: accept array, CSV string, or object wrapper
        const instances = [];
        const rawInstances = settingsCandidate.instancesList ?? settingsCandidate.instances ?? settingsCandidate.instances_list ?? settingsCandidate.instancesListValue;

        if (Array.isArray(rawInstances)) {
            for (const it of rawInstances) {
                const n = normalizeInstanceUrlCandidate(it);
                if (n) instances.push(n);
            }
        } else if (typeof rawInstances === 'string') {
            for (const part of rawInstances.split(',').map(s => s.trim()).filter(Boolean)) {
                const n = normalizeInstanceUrlCandidate(part);
                if (n) instances.push(n);
            }
        } else if (rawInstances && typeof rawInstances === 'object') {
            // some hosts wrap setting fields in objects with `.value`, `.default`, etc.
            if (Array.isArray(rawInstances.value)) {
                for (const it of rawInstances.value) {
                    const n = normalizeInstanceUrlCandidate(it);
                    if (n) instances.push(n);
                }
            } else if (typeof rawInstances.value === 'string') {
                for (const part of rawInstances.value.split(',').map(s => s.trim()).filter(Boolean)) {
                    const n = normalizeInstanceUrlCandidate(part);
                    if (n) instances.push(n);
                }
            } else {
                // fallback: search object for plausible string fields
                for (const k of Object.keys(rawInstances)) {
                    const v = rawInstances[k];
                    if (typeof v === 'string' && v.length < 500) {
                        for (const part of v.split(',').map(s => s.trim()).filter(Boolean)) {
                            const n = normalizeInstanceUrlCandidate(part);
                            if (n) instances.push(n);
                        }
                    }
                }
            }
        }

        if (!instances.length) instances.push('https://peertube.futo.org');
        parsed.instancesList = [...new Set(instances)];

        // Helper converters
        const boolFrom = (val, fallback) => {
            if (typeof val === 'boolean') return val;
            if (typeof val === 'number') return !!val;
            if (typeof val === 'string') {
                const t = val.trim().toLowerCase();
                if (t === 'true') return true;
                if (t === 'false') return false;
            }
            if (val && typeof val === 'object' && typeof val.value !== 'undefined') return boolFrom(val.value, fallback);
            return fallback;
        };
        const intFrom = (val, fallback) => {
            if (typeof val === 'number' && Number.isFinite(val)) return Math.floor(val);
            if (typeof val === 'string') {
                const n = parseInt(val.trim(), 10);
                if (!isNaN(n)) return n;
            }
            if (val && typeof val === 'object' && typeof val.value !== 'undefined') return intFrom(val.value, fallback);
            return fallback;
        };

        parsed.randomizeInstances = boolFrom(settingsCandidate.randomizeInstances, false);
        parsed.instanceSampleSize = Math.max(1, intFrom(settingsCandidate.instanceSampleSize, 3));
        parsed.maxPerChannel = Math.max(1, intFrom(settingsCandidate.maxPerChannel, 2));
        parsed.seenMax = Math.max(0, intFrom(settingsCandidate.seenMax, 500));
        parsed.submitActivity = boolFrom(settingsCandidate.submitActivity, true);

        // preferredLanguages: CSV string or array or object.value
        const langs = [];
        const rawLangs = settingsCandidate.preferredLanguages ?? settingsCandidate.preferred_languages ?? settingsCandidate.languages;
        if (Array.isArray(rawLangs)) {
            for (const l of rawLangs) { if (typeof l === 'string' && l.trim()) langs.push(l.trim().toLowerCase()); }
        } else if (typeof rawLangs === 'string') {
            for (const p of rawLangs.split(',').map(s => s.trim()).filter(Boolean)) langs.push(p.toLowerCase());
        } else if (rawLangs && typeof rawLangs === 'object') {
            if (typeof rawLangs.value === 'string') {
                for (const p of rawLangs.value.split(',').map(s => s.trim()).filter(Boolean)) langs.push(p.toLowerCase());
            }
        }
        parsed.preferredLanguages = [...new Set(langs)];

        // instrumentation summary
        for (const k of Object.keys(settingsCandidate || {})) {
            const v = settingsCandidate[k];
            summary[k] = { type: typeof v, length: (typeof v === 'string' ? v.length : (Array.isArray(v) ? v.length : undefined)) };
        }
        logSafe(`[parseSettings] parsed keys: ${Object.keys(parsed).join(', ')}; raw-summary: ${JSON.stringify(summary)}`);
        _settings = parsed;
        return parsed;
    } catch (err) {
        logSafe(`[parseSettings] unexpected error: ${err}`);
        _settings = {
            instancesList: ['https://peertube.futo.org'],
            randomizeInstances: false,
            instanceSampleSize: 3,
            maxPerChannel: 2,
            preferredLanguages: [],
            seenMax: 500,
            submitActivity: true
        };
        return _settings;
    }
}

// ---------------------- safe HTTP GET wrapper ----------------------
function safeHttpGet(url) {
    try {
        if (typeof Http !== 'undefined' && typeof Http.GET === 'function') return Http.GET(url, {});
        if (typeof http !== 'undefined' && typeof http.GET === 'function') return http.GET(url, {});
        // else attempt to use a lower-case http if present
        if (typeof fetch === 'function') {
            // not likely usable in the plugin host, but included as a last resort
            return fetch(url).then(r => r.text()).then(body => ({ isOk: true, body }));
        }
    } catch (e) {
        return { isOk: false, code: 0, body: null };
    }
    return { isOk: false, code: 0, body: null };
}

// ---------------------- ensure numeric contentType ----------------------
function ensureContentType(item) {
    try {
        if (!item || typeof item !== 'object') return item;
        if (typeof item.contentType === 'number' && Number.isInteger(item.contentType)) return item;
        // try to set host-known constant if available (if there was an enum) — default to 1 for video
        item.contentType = 1;
        return item;
    } catch (e) { return item; }
}

// ---------------------- build PlatformVideo or fallback object ----------------------
function buildPlatformVideoFromPeerTube(v, instanceBaseUrl) {
    try {
        const configId = (typeof plugin !== 'undefined' && plugin.id) ? plugin.id : FALLBACK_CONFIG_ID;

        // platform constructor availability
        const PlatformIDClass = (typeof PlatformID !== 'undefined') ? PlatformID : null;
        const PlatformAuthorLinkClass = (typeof PlatformAuthorLink !== 'undefined') ? PlatformAuthorLink : null;
        const ThumbnailClass = (typeof Thumbnail !== 'undefined') ? Thumbnail : null;
        const ThumbnailsClass = (typeof Thumbnails !== 'undefined') ? Thumbnails : null;
        const PlatformVideoClass = (typeof PlatformVideo !== 'undefined') ? PlatformVideo : null;

        // id
        const idObj = PlatformIDClass ? new PlatformIDClass(PLATFORM, v.uuid, configId) : { platform: PLATFORM, value: v.uuid, owner: configId };

        // author
        const authorUrl = (v.account && v.account.url) ? v.account.url : (instanceBaseUrl || '');
        let authorObj;
        if (PlatformAuthorLinkClass && PlatformIDClass) {
            const aId = new PlatformIDClass(PLATFORM, v.account?.name || (v.account?.url || 'unknown'), configId);
            authorObj = new PlatformAuthorLinkClass(aId, v.account?.displayName || v.account?.name || 'Unknown', authorUrl, null, v.account?.followersCount || 0);
        } else {
            authorObj = { id: { platform: PLATFORM, value: v.account?.name || '' }, name: v.account?.displayName || v.account?.name || 'Unknown', url: authorUrl };
        }

        // thumbnails
        const thumbs = [];
        if (v.thumbnailPath) {
            const turl = (instanceBaseUrl || '') + v.thumbnailPath;
            if (ThumbnailClass) thumbs.push(new ThumbnailClass(turl, 0));
            else thumbs.push({ url: turl, width: 0 });
        }
        const thumbnailsObj = (ThumbnailsClass ? new ThumbnailsClass(thumbs) : { items: thumbs });

        if (PlatformVideoClass) {
            try {
                const pv = new PlatformVideoClass({
                    id: idObj,
                    name: v.name || '',
                    thumbnails: thumbnailsObj,
                    author: authorObj,
                    datetime: Math.round((new Date(v.publishedAt || Date.now())).getTime() / 1000),
                    duration: v.duration || 0,
                    viewCount: v.views || 0,
                    url: (instanceBaseUrl ? (instanceBaseUrl + '/w/' + v.uuid) : (v.url || '')),
                    isLive: !!v.isLive,
                    description: v.description || ''
                });
                ensureContentType(pv);
                return pv;
            } catch (e) {
                logSafe(`[buildPlatformVideoFromPeerTube] PlatformVideo constructor threw: ${e}`);
            }
        }

        // fallback plain object but with numeric contentType
        const fallback = {
            contentType: 1,
            id: idObj,
            name: v.name || '',
            thumbnails: thumbs,
            author: authorObj,
            datetime: Math.round((new Date(v.publishedAt || Date.now())).getTime() / 1000),
            duration: v.duration || 0,
            viewCount: v.views || 0,
            url: (instanceBaseUrl ? (instanceBaseUrl + '/w/' + v.uuid) : (v.url || '')),
            isLive: !!v.isLive,
            description: v.description || ''
        };
        ensureContentType(fallback);
        return fallback;
    } catch (err) {
        logSafe(`[buildPlatformVideoFromPeerTube] fatal error: ${err}`);
        const lastResort = { contentType: 1, id: { platform: PLATFORM, value: v.uuid || '', owner: FALLBACK_CONFIG_ID }, name: v.name || '', url: v.url || '' };
        return lastResort;
    }
}

// ---------------------- seenIds management ----------------------
function pushSeenId(id) {
    if (!id) return;
    state.seenIds = state.seenIds || [];
    if (state.seenIds.indexOf(id) === -1) state.seenIds.unshift(id);
    const max = Math.max(0, parseInt(_settings.seenMax || 500, 10) || 500);
    if (state.seenIds.length > max) state.seenIds = state.seenIds.slice(0, max);
}

// ---------------------- instance health check (lightweight) ----------------------
function isInstanceHealthy(baseUrl) {
    try {
        if (!baseUrl) return false;
        const testUrl = baseUrl + '/api/v1/config';
        const res = safeHttpGet(testUrl);
        return !!(res && res.isOk);
    } catch (e) {
        logSafe(`isInstanceHealthy error for ${baseUrl}: ${e}`);
        return false;
    }
}

// ---------------------- getVideoPager-like aggregator (home feed) ----------------------
source.getHome = function (continuationToken) {
    // wait briefly if host might be late delivering settings
    try { waitForReady(plugin?.settings, 4, 150); } catch (e) {}

    parseSettings(plugin?.settings || {});

    const instances = (() => {
        const list = (_settings && _settings.instancesList) ? _settings.instancesList : ['https://peertube.futo.org'];
        if (!_settings.randomizeInstances) return [list[0]];
        // shuffle and sample
        const arr = list.slice();
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr.slice(0, Math.min(_settings.instanceSampleSize || 3, arr.length));
    })();

    const fetchedEntries = [];
    for (const base of instances) {
        try {
            const api = `${base}/api/v1/videos?sort=-publishedAt&start=0&count=30`;
            const res = safeHttpGet(api);
            if (!res || !res.isOk) { logSafe(`[getHome] non-ok from ${base}`); continue; }
            let body;
            try { body = JSON.parse(res.body); } catch (e) { logSafe(`[getHome] parse failed for ${base}: ${e}`); continue; }
            const data = body && body.data ? body.data : [];
            for (const v of data) {
                if (!v || !v.uuid) continue;
                fetchedEntries.push({ instance: base, video: v });
            }
        } catch (e) {
            logSafe(`[getHome] fetch error ${base}: ${e}`);
        }
    }

    // merge and dedupe with per-channel cap & language filtering
    const final = [];
    const perChannelCount = {};
    const seen = new Set();
    const maxPerChannel = Math.max(1, parseInt(_settings.maxPerChannel || 2, 10) || 2);
    const prefLangs = Array.isArray(_settings.preferredLanguages) ? _settings.preferredLanguages : [];

    for (const entry of fetchedEntries) {
        const v = entry.video;
        const vid = v.uuid;
        if (!vid) continue;
        if (seen.has(vid)) continue;
        if ((state.seenIds || []).includes(vid)) continue; // recently shown across sessions
        // language
        if (prefLangs.length) {
            const vlang = (v.language || v.languageId || '').toString().toLowerCase();
            if (vlang && prefLangs.indexOf(vlang) === -1) continue;
        }
        const channelKey = v.account?.url || v.account?.name || 'unknown';
        perChannelCount[channelKey] = perChannelCount[channelKey] || 0;
        if (perChannelCount[channelKey] >= maxPerChannel) continue;
        perChannelCount[channelKey]++;

        const built = buildPlatformVideoFromPeerTube(v, entry.instance);
        ensureContentType(built);
        final.push(built);
        seen.add(vid);
        pushSeenId(vid);
        if (final.length >= 20) break;
    }

    try {
        return new VideoPager(final, false, { continuation: null });
    } catch (e) {
        // fallback: ensure items have numeric contentType and return pager
        for (const it of final) ensureContentType(it);
        return new VideoPager(final, false, { continuation: null });
    }
};

// ---------------------- getContentDetails ----------------------
source.getContentDetails = function (url) {
    try {
        if (!url) return null;
        let base = pluginConfig?.constants?.baseUrl || '';
        try {
            const u = new URL(url);
            base = `${u.protocol}//${u.host}`;
        } catch (e) { /* ignore */ }

        // attempt to extract video id (uuid)
        const vid = (function extractId(uStr) {
            try {
                const u = new URL(uStr);
                const p = u.pathname;
                const m = p.match(/([a-zA-Z0-9\-_]{6,})$/);
                return m ? m[1] : null;
            } catch (e) { return null; }
        })(url);

        if (!vid) return null;

        const api = `${base}/api/v1/videos/${vid}`;
        const res = safeHttpGet(api);
        if (!res || !res.isOk) return null;
        const body = JSON.parse(res.body);
        const v = body;
        if (!v) return null;
        const built = buildPlatformVideoFromPeerTube(v, base);
        ensureContentType(built);
        // convert to PlatformVideoDetails if possible (best-effort)
        try {
            if (typeof PlatformVideoDetails !== 'undefined') {
                return new PlatformVideoDetails({
                    id: built.id,
                    name: built.name,
                    thumbnails: built.thumbnails,
                    author: built.author,
                    datetime: built.datetime,
                    duration: built.duration,
                    viewCount: built.viewCount,
                    url: built.url,
                    video: built.video ?? null,
                    subtitles: [],
                    description: built.description || ''
                });
            }
        } catch (e) {
            logSafe('[getContentDetails] PlatformVideoDetails ctor failed: ' + e);
        }
        return built;
    } catch (e) {
        logSafe('[getContentDetails] error: ' + e);
        return null;
    }
};

// ---------------------- search ----------------------
source.search = function (query, type, order, filters) {
    try {
        parseSettings(plugin?.settings || {});
        const results = [];
        for (const base of (_settings.instancesList || ['https://peertube.futo.org'])) {
            try {
                const api = `${base}/api/v1/search/videos?search=${encodeURIComponent(query)}&count=20`;
                const res = safeHttpGet(api);
                if (!res || !res.isOk) continue;
                const body = JSON.parse(res.body);
                const data = body && body.data ? body.data : [];
                for (const v of data) {
                    const built = buildPlatformVideoFromPeerTube(v, base);
                    ensureContentType(built);
                    results.push(built);
                }
            } catch (e) {
                logSafe('[search] error for ' + base + ': ' + e);
            }
        }
        return new VideoPager(results, false, {});
    } catch (e) {
        logSafe('[search] top-level error: ' + e);
        return new VideoPager([], false, {});
    }
};

// ---------------------- enable/saveState ----------------------
source.enable = function (conf, settings, saveStateStr) {
    try {
        pluginConfig = conf || pluginConfig || {};
        // wait for settings to be ready
        try { waitForReady(settings, 5, 150); } catch (e) {}
        // parse settings defensively
        parseSettings(settings || plugin?.settings || {});
        // attempt to parse saveStateStr safely
        try {
            if (saveStateStr && typeof saveStateStr === 'string' && saveStateStr.trim().length) {
                const parsed = JSON.parse(saveStateStr);
                if (parsed && parsed.seenIds) state.seenIds = parsed.seenIds;
            } else {
                logSafe('[enable] saveStateStr empty or absent');
            }
        } catch (e) {
            logSafe('[enable] failed to parse saveStateStr: ' + e);
        }
        logSafe('PeerTube Enhanced Multi-Instance plugin enabled (v31).');
    } catch (e) {
        logSafe('[enable] unexpected: ' + e);
    }
};

source.saveState = function () {
    try {
        return JSON.stringify({ seenIds: state.seenIds || [] });
    } catch (e) {
        return '{}';
    }
};
