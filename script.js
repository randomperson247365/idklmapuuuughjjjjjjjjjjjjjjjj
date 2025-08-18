// PeerTubeScript.js - v32
// Fixes: skip and cache failing instances, avoid retrying fake links, persist unhealthy hosts.
// All prior features preserved: robust parseSettings, instance normalization, dedupe, language filter, per-channel cap, seen-IDs.

const PLATFORM = "PeerTube";
const FALLBACK_CONFIG_ID = "enhanced-peertube-multi-instance-v32";
let pluginConfig = {};
let _settings = {};
let state = {
    serverVersion: '',
    seenIds: [],
    unhealthyHosts: {} // { "<host>": expiryTimestampMs }
};

// ---------------------- Safe logger ----------------------
function logSafe(msg) {
    try {
        if (typeof bridge !== 'undefined' && bridge.log) bridge.log(String(msg));
        else if (typeof console !== 'undefined' && console.log) console.log(String(msg));
    } catch (e) {}
}

// ---------------------- JSON.parse shim (diagnostic) ----------------------
(function installJsonShim() {
    try {
        if (typeof JSON !== 'undefined' && typeof JSON.parse === 'function') {
            const _orig = JSON.parse;
            JSON.parse = function (input) {
                try { return _orig.call(JSON, input); }
                catch (err) {
                    try {
                        logSafe(`[JSON.parse SHIM] parse failed: ${err}`);
                        if (typeof input === 'string') {
                            const snippet = input.length > 512 ? input.slice(0,512) + '...' : input;
                            logSafe(`[JSON.parse SHIM] snippet(512): ${snippet}`);
                        } else {
                            logSafe(`[JSON.parse SHIM] arg type: ${typeof input}`);
                        }
                    } catch (e) {}
                    throw err;
                }
            };
            logSafe('[JSON.parse SHIM] installed');
        }
    } catch (e) {}
})();

// ---------------------- helpers ----------------------
function sleepMs(ms) {
    try { if (typeof Thread !== 'undefined' && typeof Thread.sleep === 'function') { Thread.sleep(ms); return; } } catch(e){}
    const end = Date.now() + ms;
    while (Date.now() < end) {}
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
        // Quick sanity: disallow strings with spaces or obviously invalid chars
        if (/\s/.test(s)) return null;
        // Prepend https if missing
        if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
        s = s.replace(/\/+$/, '');
        // Validate URL object
        try { new URL(s); } catch (e) { return null; }
        return s;
    } catch (e) {
        return null;
    }
}

// ---------------------- parseSettings ----------------------
function parseSettings(settingsCandidate) {
    if (!settingsCandidate) settingsCandidate = plugin?.settings || {};
    const parsed = {};
    try {
        // Instances
        const instances = [];
        const rawInstances = settingsCandidate.instancesList ?? settingsCandidate.instances ?? settingsCandidate.instances_list ?? settingsCandidate.instancesListValue;
        if (Array.isArray(rawInstances)) {
            for (const it of rawInstances) { const n = normalizeInstanceUrlCandidate(it); if (n) instances.push(n); }
        } else if (typeof rawInstances === 'string') {
            for (const part of rawInstances.split(',').map(s => s.trim()).filter(Boolean)) { const n = normalizeInstanceUrlCandidate(part); if (n) instances.push(n); }
        } else if (rawInstances && typeof rawInstances === 'object') {
            if (Array.isArray(rawInstances.value)) {
                for (const it of rawInstances.value) { const n = normalizeInstanceUrlCandidate(it); if (n) instances.push(n); }
            } else if (typeof rawInstances.value === 'string') {
                for (const part of rawInstances.value.split(',').map(s => s.trim()).filter(Boolean)) { const n = normalizeInstanceUrlCandidate(part); if (n) instances.push(n); }
            } else {
                for (const k of Object.keys(rawInstances)) {
                    const v = rawInstances[k];
                    if (typeof v === 'string' && v.length < 500) {
                        for (const part of v.split(',').map(s => s.trim()).filter(Boolean)) { const n = normalizeInstanceUrlCandidate(part); if (n) instances.push(n); }
                    }
                }
            }
        }
        if (!instances.length) instances.push('https://peertube.futo.org');
        parsed.instancesList = [...new Set(instances)];

        // converters
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

        // languages
        const langs = [];
        const rawLangs = settingsCandidate.preferredLanguages ?? settingsCandidate.preferred_languages ?? settingsCandidate.languages;
        if (Array.isArray(rawLangs)) {
            for (const l of rawLangs) if (typeof l === 'string' && l.trim()) langs.push(l.trim().toLowerCase());
        } else if (typeof rawLangs === 'string') {
            for (const p of rawLangs.split(',').map(s => s.trim()).filter(Boolean)) langs.push(p.toLowerCase());
        } else if (rawLangs && typeof rawLangs === 'object' && typeof rawLangs.value === 'string') {
            for (const p of rawLangs.value.split(',').map(s => s.trim()).filter(Boolean)) langs.push(p.toLowerCase());
        }
        parsed.preferredLanguages = [...new Set(langs)];

        _settings = parsed;
        logSafe(`[parseSettings] instances:${parsed.instancesList.length} randomize:${parsed.randomizeInstances} sampleSize:${parsed.instanceSampleSize}`);
        return parsed;
    } catch (e) {
        logSafe('[parseSettings] error: ' + e);
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

// ---------------------- safe http GET ----------------------
function safeHttpGet(url) {
    try {
        if (typeof Http !== 'undefined' && typeof Http.GET === 'function') {
            return Http.GET(url, {});
        }
        if (typeof http !== 'undefined' && typeof http.GET === 'function') {
            return http.GET(url, {});
        }
    } catch (e) {
        return { isOk: false, code: 0, body: null };
    }
    return { isOk: false, code: 0, body: null };
}

// ---------------------- unhealthy host cache management ----------------------
const UNHEALTHY_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes default

function markHostUnhealthy(host, reason) {
    try {
        const expiry = Date.now() + UNHEALTHY_COOLDOWN_MS;
        state.unhealthyHosts = state.unhealthyHosts || {};
        state.unhealthyHosts[host] = expiry;
        logSafe(`[markHostUnhealthy] ${host} marked unhealthy until ${new Date(expiry).toISOString()} reason:${reason}`);
    } catch (e) {}
}

function isHostCurrentlyUnhealthy(host) {
    try {
        state.unhealthyHosts = state.unhealthyHosts || {};
        const expiry = state.unhealthyHosts[host];
        if (!expiry) return false;
        if (Date.now() > expiry) {
            // cooled down — forget it
            delete state.unhealthyHosts[host];
            return false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

// ---------------------- isInstanceHealthy (improved) ----------------------
function isInstanceHealthy(baseUrl) {
    try {
        if (!baseUrl) return false;
        // quick guard: host already marked unhealthy?
        if (isHostCurrentlyUnhealthy(baseUrl)) {
            logSafe(`[isInstanceHealthy] skipping ${baseUrl} because it is currently unhealthy (cached)`);
            return false;
        }
        // quick local validation: URL must parse and have http/https
        try {
            const u = new URL(baseUrl);
            if (!u.protocol || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
                markHostUnhealthy(baseUrl, 'invalid-protocol');
                return false;
            }
        } catch (e) {
            markHostUnhealthy(baseUrl, 'invalid-url');
            return false;
        }
        // Probe minimal endpoint with a short timeout behavior (we cannot set timeout in Http.GET typically)
        try {
            const probeUrl = baseUrl.replace(/\/+$/, '') + '/api/v1/config';
            const res = safeHttpGet(probeUrl);
            if (!res || !res.isOk) {
                markHostUnhealthy(baseUrl, `non-ok-response-code:${res && res.code ? res.code : 'no-res'}`);
                return false;
            }
            // parse safely
            try { JSON.parse(res.body); } catch (e) {
                markHostUnhealthy(baseUrl, 'invalid-json-config');
                return false;
            }
            return true;
        } catch (e) {
            markHostUnhealthy(baseUrl, 'exception:' + e);
            return false;
        }
    } catch (e) {
        markHostUnhealthy(baseUrl, 'unexpected:' + e);
        return false;
    }
}

// ---------------------- ensure numeric contentType ----------------------
function ensureContentType(item) {
    try {
        if (!item || typeof item !== 'object') return item;
        if (typeof item.contentType === 'number' && Number.isInteger(item.contentType)) return item;
        item.contentType = 1;
        return item;
    } catch (e) { return item; }
}

// reuse buildPlatformVideoFromPeerTube from v31 (keeps PlatformVideo usage when available)
function buildPlatformVideoFromPeerTube(v, instanceBaseUrl) {
    try {
        const configId = (typeof plugin !== 'undefined' && plugin.id) ? plugin.id : FALLBACK_CONFIG_ID;
        const PlatformIDClass = (typeof PlatformID !== 'undefined') ? PlatformID : null;
        const PlatformAuthorLinkClass = (typeof PlatformAuthorLink !== 'undefined') ? PlatformAuthorLink : null;
        const ThumbnailClass = (typeof Thumbnail !== 'undefined') ? Thumbnail : null;
        const ThumbnailsClass = (typeof Thumbnails !== 'undefined') ? Thumbnails : null;
        const PlatformVideoClass = (typeof PlatformVideo !== 'undefined') ? PlatformVideo : null;

        const idObj = PlatformIDClass ? new PlatformIDClass(PLATFORM, v.uuid, configId) : { platform: PLATFORM, value: v.uuid, owner: configId };
        const authorUrl = (v.account && v.account.url) ? v.account.url : (instanceBaseUrl || '');
        let authorObj;
        if (PlatformAuthorLinkClass && PlatformIDClass) {
            const aId = new PlatformIDClass(PLATFORM, v.account?.name || (v.account?.url || 'unknown'), configId);
            authorObj = new PlatformAuthorLinkClass(aId, v.account?.displayName || v.account?.name || 'Unknown', authorUrl, null, v.account?.followersCount || 0);
        } else {
            authorObj = { id: { platform: PLATFORM, value: v.account?.name || '' }, name: v.account?.displayName || v.account?.name || 'Unknown', url: authorUrl };
        }
        const thumbs = [];
        if (v.thumbnailPath) {
            const turl = (instanceBaseUrl || '') + v.thumbnailPath;
            if (ThumbnailClass) thumbs.push(new ThumbnailClass(turl, 0)); else thumbs.push({ url: turl, width: 0 });
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
                logSafe(`[buildPlatformVideoFromPeerTube] PlatformVideo ctor failed: ${e}`);
            }
        }
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
        logSafe('[buildPlatformVideoFromPeerTube] fatal error: ' + err);
        return { contentType: 1, id: { platform: PLATFORM, value: v.uuid || '', owner: FALLBACK_CONFIG_ID }, name: v.name || '', url: v.url || '' };
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

// ---------------------- getHome: sample healthy instances, skip unhealthy quickly ----------------------
source.getHome = function (continuationToken) {
    try {
        // refresh settings
        try { waitForReady(plugin?.settings, 4, 150); } catch (e) {}
        parseSettings(plugin?.settings || {});

        // build candidate pool and filter out currently-unhealthy hosts
        const rawList = (_settings.instancesList || ['https://peertube.futo.org']).slice();
        const healthyCandidates = [];
        for (const candidate of rawList) {
            if (isHostCurrentlyUnhealthy(candidate)) {
                logSafe(`[getHome] skipping candidate (cached unhealthy): ${candidate}`);
                continue;
            }
            // quick local validation - reject obviously invalid URLs
            try { new URL(candidate); } catch (e) { markHostUnhealthy(candidate, 'invalid-url-format'); continue; }
            healthyCandidates.push(candidate);
        }

        // if none healthy, fall back to first configured list but still try once (prevents empty feed)
        let candidatesToTry = healthyCandidates.length ? healthyCandidates : rawList.slice(0, 3);

        // random sample if requested
        if (_settings.randomizeInstances) {
            const arr = candidatesToTry.slice();
            for (let i = arr.length-1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i+1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            candidatesToTry = arr.slice(0, Math.min(_settings.instanceSampleSize || 3, arr.length));
        } else {
            candidatesToTry = candidatesToTry.slice(0, Math.min(_settings.instanceSampleSize || 3, candidatesToTry.length));
        }

        logSafe(`[getHome] trying instances: ${candidatesToTry.join(', ')}`);

        // iterate candidates; on failure mark unhealthy and continue to next
        const aggregated = [];
        const perChannelCount = {};
        const seen = new Set();
        const maxPerChannel = Math.max(1, parseInt(_settings.maxPerChannel || 2, 10) || 2);
        const prefLangs = Array.isArray(_settings.preferredLanguages) ? _settings.preferredLanguages : [];

        // limit attempts per invocation (avoid long hangs)
        const MAX_FETCH_ATTEMPTS = Math.max(3, candidatesToTry.length);

        let fetchAttempts = 0;
        for (const base of candidatesToTry) {
            if (fetchAttempts >= MAX_FETCH_ATTEMPTS) break;
            fetchAttempts++;
            try {
                // If candidate was healthy earlier check but turned bad now, mark and skip on first failure
                const api = `${base}/api/v1/videos?sort=-publishedAt&start=0&count=30`;
                const res = safeHttpGet(api);
                if (!res || !res.isOk) {
                    markHostUnhealthy(base, `getHome_nonok_${res && res.code ? res.code : 'nores'}`);
                    continue;
                }
                let body;
                try { body = JSON.parse(res.body); } catch (e) { markHostUnhealthy(base, 'getHome_parse_err'); continue; }
                const data = body && body.data ? body.data : [];
                for (const v of data) {
                    if (!v || !v.uuid) continue;
                    if (state.seenIds && state.seenIds.indexOf(v.uuid) !== -1) continue; // session dedupe
                    // language filter
                    if (prefLangs.length) {
                        const vlang = (v.language || v.languageId || '').toString().toLowerCase();
                        if (vlang && prefLangs.indexOf(vlang) === -1) continue;
                    }
                    const channelKey = v.account?.url || v.account?.name || 'unknown';
                    perChannelCount[channelKey] = perChannelCount[channelKey] || 0;
                    if (perChannelCount[channelKey] >= maxPerChannel) continue;
                    perChannelCount[channelKey]++;
                    // build typed item
                    const built = buildPlatformVideoFromPeerTube(v, base);
                    ensureContentType(built);
                    if (seen.has(v.uuid)) continue;
                    seen.add(v.uuid);
                    aggregated.push(built);
                    pushSeenId(v.uuid);
                    if (aggregated.length >= 20) break;
                }
            } catch (e) {
                markHostUnhealthy(base, 'exception:' + e);
                continue;
            }
            if (aggregated.length >= 20) break;
        }

        // Final fallback: if we still have no items, try the primary baseUrl once more but do not loop forever
        if (!aggregated.length && (_settings.instancesList && _settings.instancesList.length)) {
            try {
                const primary = _settings.instancesList[0];
                if (!isHostCurrentlyUnhealthy(primary)) {
                    const res = safeHttpGet(`${primary}/api/v1/videos?sort=-publishedAt&start=0&count=10`);
                    if (res && res.isOk) {
                        let body = null;
                        try { body = JSON.parse(res.body); } catch (e) { body = null; }
                        if (body && body.data) {
                            for (const v of body.data) {
                                if (!v || !v.uuid) continue;
                                const built = buildPlatformVideoFromPeerTube(v, primary);
                                ensureContentType(built);
                                aggregated.push(built);
                                pushSeenId(v.uuid);
                                if (aggregated.length >= 10) break;
                            }
                        }
                    }
                }
            } catch (e) {}
        }

        try { return new VideoPager(aggregated, false, {}); } catch (e) {
            // ensure each item has numeric contentType
            for (const it of aggregated) ensureContentType(it);
            return new VideoPager(aggregated, false, {});
        }
    } catch (err) {
        logSafe('[getHome] fatal: ' + err);
        return new VideoPager([], false, {});
    }
};

// ---------------------- search (unchanged behavior, respects unhealthy cache) ----------------------
source.search = function (query, type, order, filters) {
    try {
        parseSettings(plugin?.settings || {});
        const results = [];
        const bases = (_settings.instancesList || ['https://peertube.futo.org']);
        for (const base of bases) {
            if (isHostCurrentlyUnhealthy(base)) { logSafe(`[search] skipping unhealthy ${base}`); continue; }
            try {
                const api = `${base}/api/v1/search/videos?search=${encodeURIComponent(query)}&count=20`;
                const res = safeHttpGet(api);
                if (!res || !res.isOk) { markHostUnhealthy(base, 'search_nonok'); continue; }
                const body = JSON.parse(res.body);
                for (const v of (body.data || [])) {
                    const built = buildPlatformVideoFromPeerTube(v, base);
                    ensureContentType(built);
                    results.push(built);
                }
            } catch (e) {
                markHostUnhealthy(base, 'search_exception:' + e);
                continue;
            }
        }
        return new VideoPager(results, false, {});
    } catch (e) {
        logSafe('[search] error: ' + e);
        return new VideoPager([], false, {});
    }
};

// ---------------------- getContentDetails (respects unhealthy cache) ----------------------
source.getContentDetails = function (url) {
    try {
        if (!url) return null;
        let base = pluginConfig?.constants?.baseUrl || '';
        try { const u = new URL(url); base = `${u.protocol}//${u.host}`; } catch (e) {}
        if (isHostCurrentlyUnhealthy(base)) { logSafe(`[getContentDetails] skipping unhealthy ${base}`); return null; }
        try {
            const id = (function extractId(uStr) { try { const u = new URL(uStr); const m = u.pathname.match(/([a-zA-Z0-9\-_]{6,})$/); return m ? m[1] : null; } catch (e) { return null; } })(url);
            if (!id) return null;
            const res = safeHttpGet(`${base}/api/v1/videos/${id}`);
            if (!res || !res.isOk) { markHostUnhealthy(base, 'details_nonok'); return null; }
            const body = JSON.parse(res.body);
            const built = buildPlatformVideoFromPeerTube(body, base);
            ensureContentType(built);
            return built;
        } catch (e) { markHostUnhealthy(base, 'details_exception:' + e); return null; }
    } catch (e) { return null; }
};

// ---------------------- enable / saveState ----------------------
source.enable = function (conf, settings, saveStateStr) {
    try {
        pluginConfig = conf || pluginConfig || {};
        parseSettings(settings || plugin.settings || {});
        // attempt to load persisted state (seenIds and unhealthyHosts)
        try {
            if (saveStateStr && typeof saveStateStr === 'string' && saveStateStr.trim().length) {
                const parsed = JSON.parse(saveStateStr);
                if (parsed) {
                    state.seenIds = parsed.seenIds || state.seenIds || [];
                    // restore unhealthyHosts but only keep future expiries
                    if (parsed.unhealthyHosts && typeof parsed.unhealthyHosts === 'object') {
                        state.unhealthyHosts = state.unhealthyHosts || {};
                        for (const h in parsed.unhealthyHosts) {
                            const exp = parsed.unhealthyHosts[h];
                            if (exp && exp > Date.now()) state.unhealthyHosts[h] = exp;
                        }
                    }
                }
            } else {
                logSafe('[enable] saveStateStr empty or absent');
            }
        } catch (e) {
            logSafe('[enable] saveState parse failed: ' + e);
        }
        logSafe('PeerTube Enhanced Multi-Instance plugin enabled (v32).');
    } catch (e) {
        logSafe('[enable] unexpected: ' + e);
    }
};

source.saveState = function () {
    try {
        return JSON.stringify({ seenIds: state.seenIds || [], unhealthyHosts: state.unhealthyHosts || {} });
    } catch (e) { return '{}'; }
};

// ---------------------- ensureContentType + buildPlatformVideoFromPeerTube (reused from v31) ----------------------
function ensureContentType(item) {
    try {
        if (!item || typeof item !== 'object') return item;
        if (typeof item.contentType === 'number' && Number.isInteger(item.contentType)) return item;
        item.contentType = 1;
        return item;
    } catch (e) { return item; }
}

function buildPlatformVideoFromPeerTube(v, instanceBaseUrl) {
    try {
        const configId = (typeof plugin !== 'undefined' && plugin.id) ? plugin.id : FALLBACK_CONFIG_ID;
        const PlatformIDClass = (typeof PlatformID !== 'undefined') ? PlatformID : null;
        const PlatformAuthorLinkClass = (typeof PlatformAuthorLink !== 'undefined') ? PlatformAuthorLink : null;
        const ThumbnailClass = (typeof Thumbnail !== 'undefined') ? Thumbnail : null;
        const ThumbnailsClass = (typeof Thumbnails !== 'undefined') ? Thumbnails : null;
        const PlatformVideoClass = (typeof PlatformVideo !== 'undefined') ? PlatformVideo : null;

        const idObj = PlatformIDClass ? new PlatformIDClass(PLATFORM, v.uuid, configId) : { platform: PLATFORM, value: v.uuid, owner: configId };
        const authorUrl = (v.account && v.account.url) ? v.account.url : (instanceBaseUrl || '');
        let authorObj;
        if (PlatformAuthorLinkClass && PlatformIDClass) {
            const aId = new PlatformIDClass(PLATFORM, v.account?.name || (v.account?.url || 'unknown'), configId);
            authorObj = new PlatformAuthorLinkClass(aId, v.account?.displayName || v.account?.name || 'Unknown', authorUrl, null, v.account?.followersCount || 0);
        } else {
            authorObj = { id: { platform: PLATFORM, value: v.account?.name || '' }, name: v.account?.displayName || v.account?.name || 'Unknown', url: authorUrl };
        }
        const thumbs = [];
        if (v.thumbnailPath) {
            const turl = (instanceBaseUrl || '') + v.thumbnailPath;
            if (ThumbnailClass) thumbs.push(new ThumbnailClass(turl, 0)); else thumbs.push({ url: turl, width: 0 });
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
                logSafe(`[buildPlatformVideoFromPeerTube] PlatformVideo ctor failed: ${e}`);
            }
        }

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
        logSafe('[buildPlatformVideoFromPeerTube] fatal error: ' + err);
        return { contentType: 1, id: { platform: PLATFORM, value: v.uuid || '', owner: FALLBACK_CONFIG_ID }, name: v.name || '', url: v.url || '' };
    }
}
