// PeerTubeScript.js - Full updated plugin
// Features:
// - Detailed, defensive parseSettings with diagnostic logs
// - Retry-with-exponential-backoff before parsing settings/saveState
// - Multi-instance support (editable via settings), random sampling, dedupe, per-channel limits
// - Client-side preferred-language heuristic and best-effort server param
// - Safe saveState parsing with diagnostics
// - Full Pagers / Media handling / Playback tracker etc.

const PLATFORM = "PeerTube";
let config = {};
let _settings = {};
let state = {
    serverVersion: '',
    isSearchEngineSepiaSearch: false,
    seenIds: []
};

const supportedResolutions = {
    '1080p': { width: 1920, height: 1080 },
    '720p': { width: 1280, height: 720 },
    '480p': { width: 854, height: 480 },
    '360p': { width: 640, height: 360 },
    '240p': { width: 426, height: 240 },
    '144p': { width: 256, height: 144 }
};
const URLS = {
    PEERTUBE_LOGO: "https://plugins.grayjay.app/PeerTube/peertube.png"
};
let INDEX_INSTANCES = { instances: [] };
let SEARCH_ENGINE_OPTIONS = [];

Type.Feed.Playlists = "PLAYLISTS";

/* ---------------------- Diagnostics parseSettings ---------------------- */
/**
 * Detailed and defensive parseSettings:
 * - Logs per-key diagnostics (type, length).
 * - For JSON.parse errors logs stack, snippet (200 chars) and base64 length (if encodable).
 * - Never throws; always returns a safe object.
 */
function parseSettings(settings) {
    if (!settings) return {};

    const newSettings = {};
    const topLevelIsString = (typeof settings === 'string');

    for (const key in settings) {
        try {
            const val = settings[key];

            if (typeof val === 'string') {
                const raw = val;
                const trimmed = raw.length ? raw.trim() : '';

                if (trimmed === '') {
                    newSettings[key] = '';
                    log(`[parseSettings] key='${key}' type=string length=0 -> kept as empty string`);
                    continue;
                }

                const firstChar = trimmed[0];
                if (firstChar === '{' || firstChar === '[' || (firstChar === '"' && trimmed.endsWith('"'))) {
                    try {
                        newSettings[key] = JSON.parse(trimmed);
                        log(`[parseSettings] key='${key}' parsed as JSON type='${typeof newSettings[key]}'`);
                        continue;
                    } catch (parseErr) {
                        // Build diagnostics
                        const errStack = (new Error()).stack || 'no-stack';
                        const snippet = trimmed.length > 512 ? trimmed.slice(0, 512) + '...' : trimmed;
                        let b64 = '';
                        try {
                            if (typeof btoa === 'function') b64 = btoa(trimmed);
                            else if (typeof Buffer !== 'undefined') b64 = Buffer.from(trimmed).toString('base64');
                        } catch (e) { b64 = ''; }

                        log(`[parseSettings][JSON.parse FAILED] key='${key}' error='${parseErr}'`);
                        log(`STACK: ${errStack}`);
                        log(`KEY DIAGNOSTIC: key='${key}' type=string length=${raw.length} snippet(200)='${snippet}' base64_len=${b64.length}`);

                        try {
                            const summary = {};
                            for (const k2 in settings) {
                                const v2 = settings[k2];
                                summary[k2] = { type: typeof v2, length: (typeof v2 === 'string' ? v2.length : undefined) };
                            }
                            log(`[parseSettings] entire-settings-summary: ${JSON.stringify(summary)}`);
                        } catch (e2) { log('[parseSettings] failed to summarize settings: ' + e2); }

                        // fallback to trimmed string
                        newSettings[key] = trimmed;
                        continue;
                    }
                } else {
                    // Not JSON-like, keep trimmed string
                    newSettings[key] = trimmed;
                    log(`[parseSettings] key='${key}' kept raw string`);
                    continue;
                }
            } else {
                // non-string: use as-is
                newSettings[key] = val;
                log(`[parseSettings] key='${key}' type='${typeof val}' used as-is`);
                continue;
            }
        } catch (e) {
            log(`[parseSettings] unexpected error processing key='${key}': ${e}`);
            try { log((new Error()).stack || 'no-stack'); } catch (_) {}
            newSettings[key] = settings[key];
        }
    }

    // If top-level settings was a string (rare), attempt safe parse and merge
    if (topLevelIsString) {
        const rawTop = settings;
        const trimmedTop = rawTop.length ? rawTop.trim() : '';
        if (trimmedTop === '') {
            log("[parseSettings] top-level settings is empty string (length=0) — treating as {}");
            return newSettings;
        }
        try {
            const parsedTop = JSON.parse(trimmedTop);
            if (parsedTop && typeof parsedTop === 'object') {
                // parsedTop takes precedence but keep newSettings for keys we didn't parse
                return Object.assign({}, newSettings, parsedTop);
            }
        } catch (topErr) {
            const stack = (new Error()).stack || 'no-stack';
            let b64 = '';
            try {
                if (typeof btoa === 'function') b64 = btoa(trimmedTop);
                else if (typeof Buffer !== 'undefined') b64 = Buffer.from(trimmedTop).toString('base64');
            } catch (e) { b64 = ''; }
            log(`[parseSettings][TOP-LEVEL JSON.parse FAILED] error='${topErr}'`);
            log(`STACK: ${stack}`);
            log(`top-level type=string length=${rawTop.length} snippet(200)='${trimmedTop.slice(0,200)}' base64_len=${b64.length}`);
            return newSettings;
        }
    }

    return newSettings;
}

/* ---------------------- Normalizers & small helpers ---------------------- */
function normalizeInstancesList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(s => String(s).trim()).filter(Boolean);
    if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
    return [];
}
function normalizePreferredLanguages(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(s => String(s).trim().toLowerCase()).filter(Boolean);
    if (typeof raw === 'string') return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    return [];
}

/* Health check for instances */
function isInstanceHealthy(baseUrl) {
    try {
        if (!baseUrl) return false;
        const res = http.GET(`${baseUrl}/api/v1/config`, {});
        return !!(res && res.isOk);
    } catch (e) {
        log(`isInstanceHealthy error for ${baseUrl}: ${e}`);
        return false;
    }
}

/* Choose instances for sampling */
function selectInstancesForFeed() {
    const userList = normalizeInstancesList(_settings.instancesList);
    const candidates = [...new Set([ ...(userList || []), plugin.config?.constants?.baseUrl, ...INDEX_INSTANCES.instances ].filter(Boolean))];
    const sampleSize = Math.max(1, parseInt(_settings.instanceSampleSize) || 3);
    if (!_settings.randomizeInstances) {
        return [candidates[0] || plugin.config.constants.baseUrl];
    }
    const arr = candidates.slice();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    const selected = [];
    for (const host of arr) {
        if (selected.length >= sampleSize) break;
        if (isInstanceHealthy(host)) selected.push(host);
    }
    if (selected.length === 0) {
        return candidates.slice(0, Math.max(1, sampleSize));
    }
    return selected;
}

/* Seen IDs management */
function pushSeenId(id) {
    if (!id) return;
    state.seenIds = state.seenIds || [];
    if (state.seenIds.indexOf(id) === -1) state.seenIds.unshift(id);
    const seenMax = Math.max(0, parseInt(_settings.seenMax) || 500);
    if (state.seenIds.length > seenMax) state.seenIds = state.seenIds.slice(0, seenMax);
}

/* Language heuristic */
function matchesPreferredLanguage(videoObj) {
    const pref = normalizePreferredLanguages(_settings.preferredLanguages);
    if (!pref.length) return true;
    const cands = [];
    if (videoObj.language) cands.push(String(videoObj.language).toLowerCase());
    if (videoObj.languages && Array.isArray(videoObj.languages)) cands.push(...videoObj.languages.map(s => String(s).toLowerCase()));
    if (videoObj?.video?.language) cands.push(String(videoObj.video.language).toLowerCase());
    if (cands.length === 0) return true;
    for (const candidate of cands) {
        for (const p of pref) {
            if (candidate.indexOf(p) !== -1) return true;
        }
    }
    return false;
}

/* Defensive URL handling */
function getBaseUrl(url) {
    if (typeof url !== 'string') throw new ScriptException('URL must be a string');
    const t = url.trim();
    if (!t) throw new ScriptException('URL cannot be empty');
    try {
        const u = new URL(t);
        if (!u.host || !u.protocol) throw new ScriptException(`Invalid URL: ${url}`);
        return `${u.protocol}//${u.host}`;
    } catch (e) {
        throw new ScriptException(`Invalid URL format: ${url}`);
    }
}
function getBaseUrlSafe(url) {
    try { return getBaseUrl(url); } catch (e) {
        if (typeof url === 'string' && !/^https?:\/\//i.test(url)) {
            try { return getBaseUrl('https://' + url); } catch (e2) { return url; }
        }
        return url;
    }
}

/* URL hints */
function addUrlHint(url, hintParam, hintValue = '1') {
    if (!url) return url;
    if (url.includes(`${hintParam}=${hintValue}`)) return url;
    try {
        const u = new URL(url);
        u.searchParams.append(hintParam, hintValue);
        return u.toString();
    } catch (e) {
        log(`addUrlHint error for ${url}: ${e}`);
        return url;
    }
}
function addContentUrlHint(url) { return addUrlHint(url, 'isPeertubeContent'); }
function addChannelUrlHint(url) { return addUrlHint(url, 'isPeertubeChannel'); }
function addPlaylistUrlHint(url) { return addUrlHint(url, 'isPeertubePlaylist'); }

/* Media helpers */
function createAudioSource(file, duration) {
    return new AudioUrlSource({
        name: file.resolution?.label ?? file.label ?? "audio",
        url: file.fileUrl ?? file.fileDownloadUrl,
        duration: duration,
        container: "audio/mp3",
        codec: "aac"
    });
}
function createVideoSource(file, duration) {
    const supportedResolution = file.resolution?.width && file.resolution?.height ? { width: file.resolution.width, height: file.resolution.height } : supportedResolutions[file.resolution?.label];
    return new VideoUrlSource({
        name: file.resolution?.label ?? file.label ?? "",
        url: file.fileUrl ?? file.fileDownloadUrl,
        width: supportedResolution?.width,
        height: supportedResolution?.height,
        duration: duration,
        container: "video/mp4"
    });
}
function getMediaDescriptor(obj) {
    let inputFileSources = [];
    const hlsOutputSources = [];
    const muxedVideoOutputSources = [];
    const unMuxedVideoOnlyOutputSources = [];
    const unMuxedAudioOnlyOutputSources = [];
    for (const playlist of (obj?.streamingPlaylists ?? [])) {
        if (playlist?.playlistUrl) hlsOutputSources.push(new HLSSource({ name: "HLS", url: playlist.playlistUrl, duration: obj.duration ?? 0, priority: true }));
    }
    (obj?.files ?? []).forEach(file => inputFileSources.push(file));
    for (const file of inputFileSources) {
        const isAudioOnly = (file.hasAudio == undefined && file.hasVideo == undefined && file.resolution?.id === 0) || (file.hasAudio && !file.hasVideo);
        if (isAudioOnly) unMuxedAudioOnlyOutputSources.push(createAudioSource(file, obj.duration));
        const isMuxedVideo = (file.hasAudio == undefined && file.hasVideo == undefined && file.resolution?.id !== 0) || (file.hasAudio && file.hasVideo);
        if (isMuxedVideo) muxedVideoOutputSources.push(createVideoSource(file, obj.duration));
        const isUnMuxedVideoOnly = (!file.hasAudio && file.hasVideo);
        if (isUnMuxedVideoOnly) unMuxedVideoOnlyOutputSources.push(createVideoSource(file, obj.duration));
    }
    const isAudioMode = !unMuxedVideoOnlyOutputSources.length && !muxedVideoOutputSources.length && !hlsOutputSources.length;
    if (isAudioMode) return new UnMuxVideoSourceDescriptor([], unMuxedAudioOnlyOutputSources);
    if (hlsOutputSources.length && !unMuxedVideoOnlyOutputSources.length) return new VideoSourceDescriptor(hlsOutputSources);
    if (muxedVideoOutputSources.length) return new VideoSourceDescriptor(muxedVideoOutputSources);
    if (unMuxedVideoOnlyOutputSources.length && unMuxedAudioOnlyOutputSources.length) return new UnMuxVideoSourceDescriptor(unMuxedVideoOnlyOutputSources, unMuxedAudioOnlyOutputSources);
    return new VideoSourceDescriptor([]);
}

/* Pagers */
class PeerTubeVideoPager extends VideoPager {
    constructor(results, hasMore, path, params, page, sourceHost, isSearch, cbMap) { super(results, hasMore, { path, params, page, sourceHost, isSearch, cbMap }); }
    nextPage() { return getVideoPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1, this.context.sourceHost, this.context.isSearch, this.context.cbMap); }
}
class PeerTubeChannelPager extends ChannelPager {
    constructor(results, hasMore, path, params, page) { super(results, hasMore, { path, params, page }); }
    nextPage() { return getChannelPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1); }
}
class PeerTubeCommentPager extends CommentPager {
    constructor(results, hasMore, videoId, params, page, sourceBaseUrl) { super(results, hasMore, { videoId, params, page, sourceBaseUrl }); }
    nextPage() { return getCommentPager(this.context.videoId, this.context.params, (this.context.page ?? 0) + 1, this.context.sourceBaseUrl); }
}
class PeerTubePlaylistPager extends PlaylistPager {
    constructor(results, hasMore, path, params, page, sourceHost, isSearch) { super(results, hasMore, { path, params, page, sourceHost, isSearch }); }
    nextPage() { return getPlaylistPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1, this.context.sourceHost, this.context.isSearch); }
}

/* buildQuery */
function buildQuery(params) {
    let query = "";
    let first = true;
    for (const [key, value] of Object.entries(params || {})) {
        if (value == null || value === '') continue;
        if (Array.isArray(value)) {
            for (const item of value) {
                if (item == null || item === '') continue;
                if (!first) query += "&"; else first = false;
                query += `${key}=${encodeURIComponent(item)}`;
            }
        } else {
            if (!first) query += "&"; else first = false;
            query += `${key}=${encodeURIComponent(value)}`;
        }
    }
    return (query && query.length > 0) ? `?${query}` : "";
}

/* getChannelPager */
function getChannelPager(path, params, page, sourceHost = plugin.config.constants.baseUrl, isSearch = false) {
    const count = 20;
    const start = (page ?? 0) * count;
    params = { ...params, start, count };
    const url = `${sourceHost}${path}`;
    const urlWithParams = `${url}${buildQuery(params)}`;
    const res = http.GET(urlWithParams, {});
    if (res.code != 200) {
        log("Failed to get channels", res);
        return new ChannelPager([], false);
    }
    const obj = JSON.parse(res.body);
    return new PeerTubeChannelPager(obj.data.map(v => {
        const instanceBaseUrl = isSearch ? getBaseUrlSafe(v.url) : sourceHost;
        return new PlatformAuthorLink(
            new PlatformID(PLATFORM, v.name, config.id),
            v.displayName,
            v.url,
            getAvatarUrl(v, instanceBaseUrl),
            v?.followersCount ?? 0
        );
    }), obj.total > (start + count), path, params, page);
}

/* getVideoPager */
function getVideoPager(path, params, page, sourceHost = plugin.config.constants.baseUrl, isSearch = false, cbMap) {
    const count = 20;
    const start = (page ?? 0) * count;
    params = { ...params, start, count };
    const url = `${sourceHost}${path}`;
    const urlWithParams = `${url}${buildQuery(params)}`;
    const res = http.GET(urlWithParams, {});
    if (res.code != 200) {
        log("Failed to get videos", res);
        return new VideoPager([], false);
    }
    const obj = JSON.parse(res.body);
    const hasMore = obj.total > (start + count);
    if (typeof cbMap === 'function') obj.data = obj.data.map(cbMap);
    const contentResultList = obj.data
        .filter(Boolean)
        .map(v => {
            const baseUrl = [
                v.url,
                v.embedUrl,
                v.previewUrl,
                v?.thumbnailUrl,
                v?.account?.url,
                v?.channel?.url
            ].filter(Boolean).map(getBaseUrlSafe).find(Boolean);
            const contentUrl = addContentUrlHint(v.url || `${baseUrl}/videos/watch/${v.uuid}`);
            const instanceBaseUrl = isSearch ? baseUrl : sourceHost;
            const channelUrl = addChannelUrlHint(v.channel?.url || '');
            return new PlatformVideo({
                id: new PlatformID(PLATFORM, v.uuid, config.id),
                name: v.name ?? "",
                thumbnails: new Thumbnails([new Thumbnail(`${instanceBaseUrl}${v.thumbnailPath}`, 0)]),
                author: new PlatformAuthorLink(
                    new PlatformID(PLATFORM, v.channel?.name || '', config.id),
                    v.channel?.displayName || v.channel?.name || '',
                    channelUrl,
                    getAvatarUrl(v, instanceBaseUrl)
                ),
                datetime: Math.round((new Date(v.publishedAt)).getTime() / 1000),
                duration: v.duration,
                viewCount: v.views,
                url: contentUrl,
                isLive: v.isLive,
                language: v.language ?? v.languageId ?? null,
                languages: v.languages ?? null
            });
        });
    return new PeerTubeVideoPager(contentResultList, hasMore, path, params, page, sourceHost, isSearch, cbMap);
}

/* getCommentPager */
function getCommentPager(videoId, params, page, sourceBaseUrl = plugin.config.constants.baseUrl) {
    const count = 20;
    const start = (page ?? 0) * count;
    params = { ...params, start, count };
    const apiPath = `/api/v1/videos/${videoId}/comment-threads`;
    const apiUrl = `${sourceBaseUrl}${apiPath}`;
    const urlWithParams = `${apiUrl}${buildQuery(params)}`;
    const videoUrl = addContentUrlHint(`${sourceBaseUrl}/videos/watch/${videoId}`);
    const res = http.GET(urlWithParams, {});
    if (res.code != 200) {
        log("Failed to get comments", res);
        return new CommentPager([], false);
    }
    const obj = JSON.parse(res.body);
    return new PeerTubeCommentPager(obj.data
        .filter(v => !v.isDeleted || (v.isDeleted && v.totalReplies > 0))
        .map(v => {
            const accountName = (v.account?.name || 'unknown').toString();
            const displayName = (v.account?.displayName || v.account?.name || 'Unknown User').toString();
            const messageText = (v.text || '').toString();
            const commentId = (v.id || 'unknown').toString();
            const platformId = (config.id || 'peertube').toString();
            return new Comment({
                contextUrl: videoUrl || '',
                author: new PlatformAuthorLink(
                    new PlatformID(PLATFORM, accountName, platformId),
                    displayName,
                    addChannelUrlHint(`${sourceBaseUrl}/c/${accountName}`),
                    getAvatarUrl(v, sourceBaseUrl)
                ),
                message: messageText,
                rating: new RatingLikes(v.likes ?? 0),
                date: Math.round((new Date(v.createdAt ?? Date.now())).getTime() / 1000),
                replyCount: v.totalReplies ?? 0,
                context: { id: commentId }
            });
        }), obj.total > (start + count), videoId, params, page, sourceBaseUrl);
}

/* getPlaylistPager */
function getPlaylistPager(path, params, page, sourceHost = plugin.config.constants.baseUrl, isSearch = false) {
    const count = 20;
    const start = (page ?? 0) * count;
    params = { ...params, start, count };
    const url = `${sourceHost}${path}`;
    const urlWithParams = `${url}${buildQuery(params)}`;
    const res = http.GET(urlWithParams, {});
    if (res.code != 200) {
        log("Failed to get playlists", res);
        return new PlaylistPager([], false);
    }
    const obj = JSON.parse(res.body);
    const hasMore = obj.total > (start + count);
    const playlistResults = obj.data.map(playlist => {
        const playlistBaseUrl = isSearch ? getBaseUrlSafe(playlist.url) : sourceHost;
        const thumbnailUrl = playlist.thumbnailPath ? `${playlistBaseUrl}${playlist.thumbnailPath}` : URLS.PEERTUBE_LOGO;
        const channelUrl = addChannelUrlHint(playlist.ownerAccount?.url);
        const playlistUrl = addPlaylistUrlHint(`${playlistBaseUrl}/w/p/${playlist.uuid}`);
        return new PlatformPlaylist({
            id: new PlatformID(PLATFORM, playlist.uuid, config.id),
            name: playlist.displayName || playlist.name,
            author: new PlatformAuthorLink(
                new PlatformID(PLATFORM, playlist.ownerAccount?.name, config.id),
                playlist.ownerAccount?.displayName || playlist.ownerAccount?.name || "",
                channelUrl,
                getAvatarUrl(playlist.ownerAccount, playlistBaseUrl)
            ),
            thumbnail: thumbnailUrl,
            videoCount: playlist.videosLength || 0,
            url: playlistUrl
        });
    });
    return new PeerTubePlaylistPager(playlistResults, hasMore, path, params, page, sourceHost, isSearch);
}

/* processSubtitlesData */
function processSubtitlesData(subtitlesResponse) {
    if (!subtitlesResponse.isOk) {
        log("Failed to get video subtitles", subtitlesResponse);
        return [];
    }
    try {
        const baseUrl = getBaseUrlSafe(subtitlesResponse.url);
        const captionsData = JSON.parse(subtitlesResponse.body);
        if (!captionsData || !captionsData.data || captionsData.total === 0) return [];
        return captionsData.data.map(caption => {
            const subtitleUrl = caption?.fileUrl ?? (caption.captionPath ? `${baseUrl}${caption.captionPath}` : "");
            return {
                name: `${caption?.language?.label ?? caption?.language?.id} ${caption.automaticallyGenerated ? "(auto-generated)" : ""}`,
                url: subtitleUrl,
                format: "text/vtt",
                language: caption.language?.id
            };
        }).filter(caption => caption.url);
    } catch (e) {
        log("Error parsing captions data", e);
        return [];
    }
}

/* getContentDetails */
source.getContentDetails = function (url) {
    const videoId = extractVideoId(url);
    if (!videoId) return null;
    const sourceBaseUrl = getBaseUrlSafe(url);
    const [videoDetails, captionsData] = http.batch()
        .GET(`${sourceBaseUrl}/api/v1/videos/${videoId}`, {})
        .GET(`${sourceBaseUrl}/api/v1/videos/${videoId}/captions`, {})
        .execute();
    if (!videoDetails.isOk) {
        log("Failed to get video detail", videoDetails);
        return null;
    }
    const obj = JSON.parse(videoDetails.body);
    if (!obj) {
        log("Failed to parse response");
        return null;
    }
    const contentUrl = addContentUrlHint(obj.url || `${sourceBaseUrl}/videos/watch/${obj.uuid}`);
    const channelUrl = addChannelUrlHint(obj.channel?.url || '');
    const subtitles = processSubtitlesData(captionsData);
    const result = new PlatformVideoDetails({
        id: new PlatformID(PLATFORM, obj.uuid, config.id),
        name: obj.name,
        thumbnails: new Thumbnails([new Thumbnail(`${sourceBaseUrl}${obj.thumbnailPath}`, 0)]),
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM, obj.channel?.name || '', config.id),
            obj.channel?.displayName || obj.channel?.name || '',
            channelUrl,
            getAvatarUrl(obj, sourceBaseUrl)
        ),
        datetime: Math.round((new Date(obj.publishedAt)).getTime() / 1000),
        duration: obj.duration,
        viewCount: obj.views,
        url: contentUrl,
        isLive: obj.isLive,
        description: obj.description,
        video: getMediaDescriptor(obj),
        subtitles: subtitles,
        language: obj.language ?? obj.languageId ?? null,
        rating: new RatingLikesDislikes(obj?.likes ?? 0, obj?.dislikes ?? 0)
    });
    if (IS_TESTING) {
        source.getContentRecommendations(url, obj);
    } else {
        result.getContentRecommendations = function () {
            return source.getContentRecommendations(url, obj);
        };
    }
    return result;
};

/* getContentRecommendations */
source.getContentRecommendations = function (url, obj) {
    const sourceHost = getBaseUrlSafe(url);
    const videoId = extractVideoId(url);
    let tagsOneOf = obj?.tags ?? [];
    if (!obj && videoId) {
        const res = http.GET(`${sourceHost}/api/v1/videos/${videoId}`, {});
        if (res.isOk) {
            const obj2 = JSON.parse(res.body);
            if (obj2) tagsOneOf = obj2?.tags ?? [];
        }
    }
    const params = {
        skipCount: false,
        nsfw: false,
        tagsOneOf,
        sort: "-publishedAt",
        searchTarget: "local"
    };
    const pager = getVideoPager('/api/v1/search/videos', params, 0, sourceHost, false);
    pager.results = pager.results.filter(v => v.id.value != videoId);
    return pager;
};

/* getComments */
source.getComments = function (url) {
    const videoId = extractVideoId(url);
    const sourceBaseUrl = getBaseUrlSafe(url);
    return getCommentPager(videoId, {}, 0, sourceBaseUrl);
};

/* getSubComments */
source.getSubComments = function (comment) {
    if (typeof comment === 'string') {
        try {
            comment = JSON.parse(comment);
        } catch (parseError) {
            bridge.log("Failed to parse comment string: " + parseError);
            return new CommentPager([], false);
        }
    }
    if (!comment || !comment.contextUrl) {
        bridge.log("getSubComments: Missing contextUrl in comment");
        return new CommentPager([], false);
    }
    if (!comment.context || !comment.context.id) {
        bridge.log("getSubComments: Missing comment context or ID");
        return new CommentPager([], false);
    }
    const videoId = extractVideoId(comment.contextUrl);
    if (!videoId) {
        bridge.log("getSubComments: Could not extract video ID from contextUrl");
        return new CommentPager([], false);
    }
    const sourceBaseUrl = getBaseUrlSafe(comment.contextUrl);
    const commentId = comment.context.id;
    const apiUrl = `${sourceBaseUrl}/api/v1/videos/${videoId}/comment-threads/${commentId}`;
    try {
        const res = http.GET(apiUrl, {});
        if (res.code != 200) {
            bridge.log("Failed to get sub-comments, status: " + res.code);
            return new CommentPager([], false);
        }
        const obj = JSON.parse(res.body);
        const replies = obj.children || [];
        const comments = replies.map(v => {
            const accountName = (v.comment?.account?.name || 'unknown').toString();
            const displayName = (v.comment?.account?.displayName || v.comment?.account?.name || 'Unknown User').toString();
            const messageText = (v.comment?.text || '').toString();
            const replyCommentId = (v.comment?.id || 'unknown').toString();
            const platformId = (config.id || 'peertube').toString();
            return new Comment({
                contextUrl: comment.contextUrl,
                author: new PlatformAuthorLink(
                    new PlatformID(PLATFORM, accountName, platformId),
                    displayName,
                    addChannelUrlHint(`${sourceBaseUrl}/c/${accountName}`),
                    getAvatarUrl(v.comment, sourceBaseUrl)
                ),
                message: messageText,
                rating: new RatingLikes(v.comment?.likes ?? 0),
                date: Math.round((new Date(v.comment?.createdAt ?? Date.now())).getTime() / 1000),
                replyCount: v.comment?.totalReplies ?? 0,
                context: { id: replyCommentId }
            });
        });
        return new CommentPager(comments, false);
    } catch (error) {
        bridge.log("Error getting sub-comments: " + error);
        return new CommentPager([], false);
    }
};

/* Playback tracker */
source.getPlaybackTracker = function (url) {
    if (!_settings.submitActivity) return null;
    const videoId = extractVideoId(url);
    if (!videoId) return null;
    const sourceBaseUrl = getBaseUrlSafe(url);
    return new PeerTubePlaybackTracker(videoId, sourceBaseUrl);
};
class PeerTubePlaybackTracker extends PlaybackTracker {
    constructor(videoId, baseUrl) {
        super(5000);
        this.videoId = videoId;
        this.baseUrl = baseUrl;
        this.lastReportedTime = 0;
        this.seekOccurred = false;
    }
    onInit(seconds) {
        this.lastReportedTime = Math.floor(seconds);
        this.reportView(this.lastReportedTime);
    }
    onProgress(seconds, isPlaying) {
        if (!isPlaying) return;
        const currentTime = Math.floor(seconds);
        if (Math.abs(currentTime - this.lastReportedTime) > 10) {
            this.seekOccurred = true;
        }
        this.lastReportedTime = currentTime;
        this.reportView(currentTime);
    }
    onConcluded() {
        this.reportView(this.lastReportedTime);
    }
    reportView(currentTime) {
        const url = `${this.baseUrl}/api/v1/videos/${this.videoId}/views`;
        const body = { currentTime, client: "GrayJay.app" };
        if (this.seekOccurred) { body.viewEvent = "seek"; this.seekOccurred = false; }
        http.POST(url, JSON.stringify(body), { "Content-Type": "application/json" }, false);
    }
}

/* extractors */
function extractVideoId(url) {
    try {
        if (!url) return null;
        const u = new URL(url);
        const { pathname } = u;
        const match = pathname.match(/^\/(videos\/(watch|embed)\/|w\/|api\/v1\/videos\/)([a-zA-Z0-9-_]+)(?:\/.*)?$/);
        return match ? match[3] : null;
    } catch (e) { log('Error extracting PeerTube video ID:' + e); return null; }
}
function extractChannelId(url) {
    try {
        if (!url) return null;
        const u = new URL(url);
        const { pathname } = u;
        const match = pathname.match(/^\/(c|video-channels|api\/v1\/video-channels)\/([a-zA-Z0-9-_.]+)(?:\/(video|videos)?)?\/?$/);
        return match ? match[2] : null;
    } catch (e) { log('Error extracting PeerTube channel ID:' + e); return null; }
}
function extractPlaylistId(url) {
    try {
        if (!url) return null;
        const u = new URL(url);
        const { pathname } = u;
        let match = pathname.match(/^\/(videos\/watch\/playlist\/|w\/p\/)([a-zA-Z0-9-_]+)(?:\/.*)?$/);
        if (!match) match = pathname.match(/^\/(video-playlists|api\/v1\/video-playlists)\/([a-zA-Z0-9-_]+)(?:\/.*)?$/);
        if (!match) match = pathname.match(/^\/(video-channels|c)\/[a-zA-Z0-9-_.]+\/video-playlists\/([a-zA-Z0-9-_]+)(?:\/.*)?$/);
        return match ? match[match.length - 1] : null;
    } catch (e) { log('Error extracting PeerTube playlist ID:' + e); return null; }
}

/* getAvatarUrl */
function getAvatarUrl(obj, baseUrl = plugin.config.constants.baseUrl) {
    const relativePath = [
        obj?.avatar?.path,
        obj?.channel?.avatar?.path,
        obj?.account?.avatar?.path,
        obj?.ownerAccount?.avatar?.path,
        obj?.avatars?.length ? obj.avatars[obj.avatars.length - 1].path : "",
        obj?.channel?.avatars?.length ? obj.channel.avatars[obj.channel.avatars.length - 1].path : "",
        obj?.account?.avatars?.length ? obj.account.avatars[obj.account.avatars.length - 1].path : "",
        obj?.ownerAccount?.avatars?.length ? obj.ownerAccount.avatars[obj.ownerAccount.avatars.length - 1].path : ""
    ].find(v => v);
    if (relativePath) return `${baseUrl}${relativePath}`;
    return URLS.PEERTUBE_LOGO;
}

/* loadOptionsForSetting */
function loadOptionsForSetting(settingKey, transformCallback) {
    transformCallback ??= (o) => o;
    const setting = config?.settings?.find((s) => s.variable == settingKey);
    return setting?.options?.map(transformCallback) ?? [];
}

/* Safe logger */
function log(s) {
    try {
        if (s === undefined) return;
        if (typeof s === 'string') bridge.log(s);
        else bridge.log(JSON.stringify(s, null, 2));
    } catch (e) { /* swallow */ }
}

/* sleep wrapper (prefers Thread.sleep) */
function sleepMs(ms) {
    try {
        if (typeof Thread !== 'undefined' && typeof Thread.sleep === 'function') {
            Thread.sleep(ms);
            return;
        }
    } catch (e) { /* fall through */ }
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy-wait fallback (short) */ }
}

/* Wait-for-readiness with exponential backoff */
function waitForSettingsReady(settingsCandidate, maxAttempts = 5, baseDelay = 150) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            if (settingsCandidate && typeof settingsCandidate === 'object') return true;
            if (typeof settingsCandidate === 'string' && settingsCandidate.trim().length) return true;
        } catch (e) { /* ignore */ }
        const delay = baseDelay * Math.pow(2, attempt);
        sleepMs(delay);
    }
    return false;
}

/* ---------------------- source implementation (enable, saveState, flows) ---------------------- */

/* enable: wait/exponential backoff then parse settings and saveState defensively */
source.enable = function (conf, settings, saveStateStr) {
    config = conf ?? {};

    try {
        waitForSettingsReady(settings, 5, 150);
    } catch (e) { log('waitForSettingsReady(settings) failed: ' + e); }

    try {
        _settings = parseSettings(settings ?? {});
    } catch (e) {
        log("source.enable: parseSettings threw - falling back to empty settings. Error: " + e);
        _settings = {};
    }

    SEARCH_ENGINE_OPTIONS = loadOptionsForSetting('searchEngineIndex');
    let didSaveState = false;

    if (IS_TESTING) {
        plugin.config = { constants: { baseUrl: "https://peertube.futo.org" } };
        _settings.searchEngineIndex = 0;
        _settings.submitActivity = true;
    }

    state.isSearchEngineSepiaSearch = SEARCH_ENGINE_OPTIONS[_settings.searchEngineIndex] == 'Sepia Search';

    try {
        waitForSettingsReady(saveStateStr, 4, 150);
    } catch (e) { log('waitForSettingsReady(saveStateStr) failed: ' + e); }

    try {
        if (saveStateStr && typeof saveStateStr === 'string' && saveStateStr.trim().length) {
            try {
                const parsed = JSON.parse(saveStateStr);
                if (parsed) {
                    state = { ...state, ...parsed };
                    didSaveState = true;
                }
            } catch (stateErr) {
                const s = saveStateStr;
                const stack = (new Error()).stack || 'no-stack';
                let b64 = '';
                try { if (typeof btoa === 'function') b64 = btoa(s); else if (typeof Buffer !== 'undefined') b64 = Buffer.from(s).toString('base64'); } catch (e) { b64 = ''; }
                log(`[enable][saveState parse FAILED] error='${stateErr}'`);
                log(`STACK: ${stack}`);
                log(`saveStateStr type=string length=${s.length} snippet(200)='${s.slice(0,200)}' base64_len=${b64.length}`);
            }
        } else {
            log('[enable] saveStateStr is empty/absent or not a string; skipping parse');
        }
    } catch (e) {
        log('[enable] unexpected error while parsing saveStateStr: ' + e);
    }

    if (!didSaveState) {
        try {
            const primary = plugin.config.constants.baseUrl;
            const [currentInstanceConfig] = http.batch().GET(`${primary}/api/v1/config`, {}).execute();
            if (currentInstanceConfig && currentInstanceConfig.isOk) {
                const serverConfig = JSON.parse(currentInstanceConfig.body);
                state.serverVersion = serverConfig.serverVersion;
            }
        } catch (e) {
            log('Failed to fetch base instance config: ' + e);
        }
    }

    state.seenIds = state.seenIds || [];
};

/* saveState */
source.saveState = function () {
    return JSON.stringify({ serverVersion: state.serverVersion, seenIds: state.seenIds });
};

/* getHome: aggregated feed across sampled instances */
source.getHome = function () {
    let sort = '';
    if (ServerInstanceVersionIsSameOrNewer(state.serverVersion, '3.1.0')) sort = 'best';
    const instances = selectInstancesForFeed();
    const params = {};
    if (sort) params.sort = sort;
    const prefLangs = normalizePreferredLanguages(_settings.preferredLanguages);
    if (prefLangs.length) params.languageOneOf = prefLangs;
    const perInstanceResults = [];
    for (const instance of instances) {
        try {
            const pager = getVideoPager('/api/v1/videos', params, 0, instance, false);
            if (pager && pager.results && pager.results.length) {
                pager.results.forEach(r => r._instanceHost = instance);
                perInstanceResults.push(...pager.results);
            }
        } catch (e) {
            log(`Error fetching from instance ${instance}: ${e}`);
        }
    }
    const seen = new Set();
    const final = [];
    const perChannelCount = {};
    const maxPerChannel = Math.max(1, parseInt(_settings.maxPerChannel) || 2);
    const totalLimit = 20;
    for (const item of perInstanceResults) {
        if (!item || !item.id || !item.id.value) continue;
        const vid = item.id.value;
        if (seen.has(vid)) continue;
        if ((state.seenIds || []).includes(vid)) continue;
        if (!matchesPreferredLanguage(item)) continue;
        const channelKey = (item.author && item.author.id && item.author.id.value) || item.author?.name || 'unknown';
        perChannelCount[channelKey] = perChannelCount[channelKey] || 0;
        if (perChannelCount[channelKey] >= maxPerChannel) continue;
        seen.add(vid);
        perChannelCount[channelKey]++;
        final.push(item);
        if (final.length >= totalLimit) break;
    }
    final.forEach(v => pushSeenId(v.id.value));
    return new PeerTubeVideoPager(final, false, '/api/v1/videos', params, 0, instances.length ? instances[0] : plugin.config.constants.baseUrl, false);
};

/* search, searchChannels, searchPlaylists */
source.search = function (query, type, order, filters) {
    if (source.isContentDetailsUrl(query)) return new ContentPager([source.getContentDetails(query)], false);
    let sort = order;
    if (sort === Type.Order.Chronological) sort = "-publishedAt";
    const params = { search: query, sort };
    if (type == Type.Feed.Streams) params.isLive = true;
    else if (type == Type.Feed.Videos) params.isLive = false;
    const prefLangs = normalizePreferredLanguages(_settings.preferredLanguages);
    if (prefLangs.length) params.languageOneOf = prefLangs;
    let sourceHost = '';
    if (state.isSearchEngineSepiaSearch) {
        params.resultType = 'videos';
        params.nsfw = false;
        params.sort = '-createdAt';
        sourceHost = 'https://sepiasearch.org';
    } else {
        sourceHost = plugin.config.constants.baseUrl;
    }
    const isSearch = true;
    return getVideoPager('/api/v1/search/videos', params, 0, sourceHost, isSearch);
};
source.searchChannels = function (query) {
    let sourceHost = state.isSearchEngineSepiaSearch ? 'https://sepiasearch.org' : plugin.config.constants.baseUrl;
    return getChannelPager('/api/v1/search/video-channels', { search: query }, 0, sourceHost, true);
};
source.searchPlaylists = function (query) {
    let sourceHost = state.isSearchEngineSepiaSearch ? 'https://sepiasearch.org' : plugin.config.constants.baseUrl;
    const params = { search: query };
    if (state.isSearchEngineSepiaSearch) {
        params.resultType = 'video-playlists';
        params.nsfw = false;
        params.sort = '-createdAt';
    }
    return getPlaylistPager('/api/v1/search/video-playlists', params, 0, sourceHost, true);
};

/* getChannel, getChannelContents, getPlaylist - defined earlier in file patterns (kept consistent) */
source.getChannel = function (url) {
    const handle = extractChannelId(url);
    if (!handle) throw new ScriptException(`Failed to extract channel ID from URL: ${url}`);
    const sourceBaseUrl = getBaseUrlSafe(url);
    const urlWithParams = `${sourceBaseUrl}/api/v1/video-channels/${handle}`;
    const res = http.GET(urlWithParams, {});
    if (res.code != 200) { log("Failed to get channel", res); return null; }
    const obj = JSON.parse(res.body);
    const channelUrl = obj.url || `${sourceBaseUrl}/video-channels/${handle}`;
    const channelUrlWithHint = addChannelUrlHint(channelUrl);
    return new PlatformChannel({
        id: new PlatformID(PLATFORM, obj.name, config.id),
        name: obj.displayName || obj.name || handle,
        thumbnail: getAvatarUrl(obj, sourceBaseUrl),
        banner: null,
        subscribers: obj.followersCount || 0,
        description: obj.description ?? "",
        url: channelUrlWithHint,
        links: {},
        urlAlternatives: [channelUrl, channelUrlWithHint]
    });
};
source.getChannelContents = function (url, type, order, filters) {
    let sort = order;
    if (sort === Type.Order.Chronological) sort = "-publishedAt";
    const params = { sort };
    const handle = extractChannelId(url);
    const sourceBaseUrl = getBaseUrlSafe(url);
    if (type === Type.Feed.Playlists) return source.getChannelPlaylists(url, order, filters);
    if (type == Type.Feed.Streams) params.isLive = true;
    else if (type == Type.Feed.Videos) params.isLive = false;
    return getVideoPager(`/api/v1/video-channels/${handle}/videos`, params, 0, sourceBaseUrl);
};
source.getChannelPlaylists = function (url, order, filters) {
    let sort = order;
    if (sort === Type.Order.Chronological) sort = "-publishedAt";
    const params = { sort };
    const handle = extractChannelId(url);
    if (!handle) return new PlaylistPager([], false);
    const sourceBaseUrl = getBaseUrlSafe(url);
    return getPlaylistPager(`/api/v1/video-channels/${handle}/video-playlists`, params, 0, sourceBaseUrl);
};
source.getPlaylist = function (url) {
    const playlistId = extractPlaylistId(url);
    if (!playlistId) return null;
    const sourceBaseUrl = getBaseUrlSafe(url);
    const urlWithParams = `${sourceBaseUrl}/api/v1/video-playlists/${playlistId}`;
    const res = http.GET(urlWithParams, {});
    if (res.code != 200) { log("Failed to get playlist", res); return null; }
    const playlist = JSON.parse(res.body);
    const thumbnailUrl = playlist.thumbnailPath ? `${sourceBaseUrl}${playlist.thumbnailPath}` : URLS.PEERTUBE_LOGO;
    const channelUrl = addChannelUrlHint(playlist.ownerAccount?.url);
    const playlistUrl = addPlaylistUrlHint(`${sourceBaseUrl}/w/p/${playlist.uuid}`);
    return new PlatformPlaylistDetails({
        id: new PlatformID(PLATFORM, playlist.uuid, config.id),
        name: playlist.displayName || playlist.name,
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM, playlist.ownerAccount?.name, config.id),
            playlist.ownerAccount?.displayName || playlist.ownerAccount?.name || "",
            channelUrl,
            getAvatarUrl(playlist.ownerAccount, sourceBaseUrl)
        ),
        thumbnail: thumbnailUrl,
        videoCount: playlist.videosLength || 0,
        url: playlistUrl,
        contents: getVideoPager(`/api/v1/video-playlists/${playlistId}/videos`, {}, 0, sourceBaseUrl, false, (playlistItem) => playlistItem.video)
    });
};

/* Minimal http.batch fallback if host doesn't provide it */
if (http && typeof http.batch === 'function') {
    // host provides it
} else if (http) {
    http.batch = function () {
        const calls = [];
        return {
            GET: function (url, headers) { calls.push({ method: 'GET', url, headers }); return this; },
            execute: function () {
                return calls.map(c => {
                    try { return http.GET(c.url, c.headers || {}); } catch (e) { return { isOk: false, code: 0, body: null }; }
                });
            }
        };
    };
}

/* Keep original automated instance list (append user ones) */
INDEX_INSTANCES.instances = [...INDEX_INSTANCES.instances, 'poast.tv','videos.upr.fr','peertube.red'];
INDEX_INSTANCES.instances = [...INDEX_INSTANCES.instances, "video.blinkyparts.com","vid.chaoticmira.gay","peertube.nthpyro.dev","watch.bojidar-bg.dev","ishotenedthislistbecauseitstoolong.and.dumb.com"];

/* End of file */
