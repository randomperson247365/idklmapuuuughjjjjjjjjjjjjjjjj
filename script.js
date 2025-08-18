// == PeerTube Enhanced Multi-Instance Plugin ==
// Version: 28
// Changelog: normalize instance URLs automatically, fix missing function stubs
// ==============================================

// ---- Shim to prevent JSON parse crashes ----
(function() {
    const oldParse = JSON.parse;
    JSON.parse = function(str) {
        if (!str || typeof str !== "string") return {};
        try {
            return oldParse(str);
        } catch (e) {
            console.warn("[JSON.parse SHIM] failed on input:", str, e);
            return {};
        }
    };
    console.log("[JSON.parse SHIM] installed");
})();

// ---- Utility: Normalize instance URLs ----
function normalizeInstanceUrl(raw) {
    let url = raw.trim();
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = "https://" + url; // default to https
    }
    return url.replace(/\/+$/, ""); // strip trailing slash
}

// ---- Stub missing function from original plugin ----
function ServerInstanceVersionIsSameOrNewer() {
    // Always succeed; placeholder for future version checks
    return true;
}

// ---- Plugin State ----
let seenVideoIds = [];
let seenMax = 500;

// ---- Parse Settings ----
function parseSettings(settings) {
    const parsed = {};

    parsed.instancesList = (settings.instancesList || "https://peertube.futo.org")
        .split(",")
        .map(normalizeInstanceUrl)
        .filter(u => u.length > 0);

    parsed.randomizeInstances = (settings.randomizeInstances === true || settings.randomizeInstances === "true");
    parsed.instanceSampleSize = parseInt(settings.instanceSampleSize || "3", 10);
    parsed.maxPerChannel = parseInt(settings.maxPerChannel || "2", 10);
    parsed.preferredLanguages = (settings.preferredLanguages || "")
        .split(",")
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    parsed.seenMax = parseInt(settings.seenMax || "500", 10);
    parsed.submitActivity = (settings.submitActivity === true || settings.submitActivity === "true");

    return parsed;
}

// ---- Home Feed ----
source.getHome = function(continuationToken) {
    const settings = parseSettings(plugin.settings || {});
    let instances = settings.instancesList;

    // Sample random subset if requested
    if (settings.randomizeInstances) {
        const shuffled = [...instances].sort(() => 0.5 - Math.random());
        instances = shuffled.slice(0, Math.min(settings.instanceSampleSize, shuffled.length));
    }

    const results = [];
    const seenChannels = {};

    for (const baseUrl of instances) {
        try {
            const url = `${baseUrl}/api/v1/videos?sort=-publishedAt&start=0&count=10`;
            const resp = Http.GET(url, { headers: { "Accept": "application/json" } });
            if (!resp.isOk) continue;

            const data = JSON.parse(resp.body);
            for (const vid of data.data || []) {
                if (seenVideoIds.includes(vid.uuid)) continue; // dedupe globally

                // Limit per channel
                const channelKey = vid.account?.url || "unknown";
                seenChannels[channelKey] = (seenChannels[channelKey] || 0) + 1;
                if (seenChannels[channelKey] > settings.maxPerChannel) continue;

                // Language filtering
                if (settings.preferredLanguages.length > 0 && vid.language) {
                    if (!settings.preferredLanguages.includes(vid.language.toLowerCase())) {
                        continue;
                    }
                }

                results.push({
                    id: vid.uuid,
                    name: vid.name,
                    author: { name: vid.account?.displayName || "Unknown", url: vid.account?.url },
                    datetime: new Date(vid.publishedAt).getTime(),
                    duration: vid.duration,
                    viewCount: vid.views,
                    url: `${baseUrl}/w/${vid.uuid}`,
                    thumbnails: [{ url: vid.thumbnailPath ? baseUrl + vid.thumbnailPath : "" }],
                    description: vid.description || "",
                    isLive: vid.isLive || false
                });

                seenVideoIds.push(vid.uuid);
                if (seenVideoIds.length > settings.seenMax) {
                    seenVideoIds.shift();
                }
            }
        } catch (e) {
            console.error(`[getHome] error for ${baseUrl}`, e);
        }
    }

    return new VideoPager(results, false, {});
};

// ---- Search ----
source.search = function(query, type, order, filters) {
    const settings = parseSettings(plugin.settings || {});
    let results = [];

    for (const baseUrl of settings.instancesList) {
        try {
            const url = `${baseUrl}/api/v1/search/videos?search=${encodeURIComponent(query)}&count=10`;
            const resp = Http.GET(url, { headers: { "Accept": "application/json" } });
            if (!resp.isOk) continue;

            const data = JSON.parse(resp.body);
            for (const vid of data.data || []) {
                results.push({
                    id: vid.uuid,
                    name: vid.name,
                    author: { name: vid.account?.displayName || "Unknown", url: vid.account?.url },
                    datetime: new Date(vid.publishedAt).getTime(),
                    duration: vid.duration,
                    viewCount: vid.views,
                    url: `${baseUrl}/w/${vid.uuid}`,
                    thumbnails: [{ url: vid.thumbnailPath ? baseUrl + vid.thumbnailPath : "" }],
                    description: vid.description || "",
                    isLive: vid.isLive || false
                });
            }
        } catch (e) {
            console.error(`[search] error for ${baseUrl}`, e);
        }
    }

    return new VideoPager(results, false, {});
};

// ---- Plugin Enable ----
source.enable = function() {
    console.log("=== PeerTube Multi-Instance Plugin v28 loaded ===");
};
