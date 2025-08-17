// PeerTubeScript.v2.js - Enhanced Multi-Instance + robust settings parsing + dedupe + language filter
const PLATFORM = "PeerTube";
let config = {};
let _settings = {};
let state = {
    serverVersion: '',
    isSearchEngineSepiaSearch: false,
    seenIds: [], // recent seen video IDs to reduce repeats
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
// instances are populated during deploy appended to the end of this javascript file
// this update process is done at update-instances.sh
let INDEX_INSTANCES = {
    instances: []
};
let SEARCH_ENGINE_OPTIONS = [];
Type.Feed.Playlists = "PLAYLISTS";

/**
 * Robust settings parser:
 * - Accepts object or string values
 * - Ignores empty strings
 * - On malformed JSON, falls back to raw string
 */
function parseSettings(settings) {
    if (!settings) return {};
    const newSettings = {};
    for (const key in settings) {
        try {
            const val = settings[key];
            if (typeof val === 'string') {
                const s = val.trim();
                if (s === '') {
                    newSettings[key] = '';
                    continue;
                }
                try {
                    newSettings[key] = JSON.parse(s);
                } catch (e) {
                    log(`parseSettings: failed to JSON.parse setting '${key}', using raw string. Error: ${e}`);
                    newSettings[key] = s;
                }
            } else {
                newSettings[key] = val;
            }
        } catch (e) {
            log(`parseSettings: unexpected error for key '${key}': ${e}`);
            newSettings[key] = settings[key];
        }
    }
    return newSettings;
}

/** Normalize comma-separated instance list into array of trimmed base URLs */
function normalizeInstancesList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
        return raw.map(s => String(s).trim()).filter(Boolean);
    }
    if (typeof raw === 'string') {
        return raw.split(',').map(s => s.trim()).filter(Boolean);
    }
    // unsupported type -> ignore
    return [];
}

/** Normalize languages string into array of language codes (lowercase) */
function normalizePreferredLanguages(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
        return raw.map(s => String(s).trim().toLowerCase()).filter(Boolean);
    }
    if (typeof raw === 'string') {
        return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
    return [];
}

/** Limited health-check for an instance. Returns true if instance responds to /api/v1/config */
function isInstanceHealthy(baseUrl) {
    try {
        if (!baseUrl) return false;
        // quick config fetch; keep short
        const res = http.GET(`${baseUrl}/api/v1/config`, {});
        return !!(res && res.isOk);
    } catch (e) {
        log(`Instance health check failed for ${baseUrl}: ${e}`);
        return false;
    }
}

/** Select instances for feed sampling */
function selectInstancesForFeed() {
    // Build candidate list:
    // 1) user-provided instances in settings
    // 2) plugin.config.constants.baseUrl as fallback
    // 3) known INDEX_INSTANCES.instances as fallback
    const userInstances = normalizeInstancesList(_settings.instancesList);
    const candidates = [...new Set([
        ...userInstances,
        plugin.config?.constants?.baseUrl,
        ...INDEX_INSTANCES.instances
    ].filter(Boolean))];

    // If user chose not to randomize, return first candidate (or baseUrl)
    const sampleSize = parseInt(_settings.instanceSampleSize) || 3;
    if (!_settings.randomizeInstances) {
        return [candidates[0] || plugin.config.constants.baseUrl];
    }

    // Shuffle and pick sample size, but only keep healthy instances
    const shuffled = candidates.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const selected = [];
    for (const instance of shuffled) {
        if (selected.length >= sampleSize) break;
        try {
            if (isInstanceHealthy(instance)) {
                selected.push(instance);
            } else {
                log(`Skipping unhealthy instance: ${instance}`);
            }
        } catch (e) {
            log(`Error checking instance ${instance}: ${e}`);
        }
    }
    // if none healthy, fall back to first candidate(s) without health check
    if (selected.length === 0) {
        return candidates.slice(0, Math.max(1, sampleSize));
    }
    return selected;
}

/** Persist seen IDs in state and trim to seenMax */
function pushSeenId(id) {
    if (!id) return;
    const seenMax = parseInt(_settings.seenMax) || 500;
    state.seenIds = state.seenIds || [];
    // keep unique
    if (!state.seenIds.includes(id)) {
        state.seenIds.unshift(id);
    }
    // trim
    if (state.seenIds.length > seenMax) {
        state.seenIds = state.seenIds.slice(0, seenMax);
    }
}

/** Helper to check if a video matches preferred languages client-side */
function matchesPreferredLanguage(videoObj) {
    const pref = normalizePreferredLanguages(_settings.preferredLanguages);
    if (!pref || pref.length === 0) return true; // no filter
    // videoObj may have language fields in different keys
    const candidates = [];
    if (videoObj.language) candidates.push(String(videoObj.language).toLowerCase());
    if (videoObj.languages) {
        if (Array.isArray(videoObj.languages)) {
            candidates.push(...videoObj.languages.map(s => String(s).toLowerCase()));
        } else {
            candidates.push(String(videoObj.languages).toLowerCase());
        }
    }
    // Some PeerTube instances include language info in metadata fields like 'language' or 'locale'
    if (videoObj?.video?.language) candidates.push(String(videoObj.video.language).toLowerCase());
    // check thumbnail alt or description? not reliable
    for (const c of candidates.filter(Boolean)) {
        for (const p of pref) {
            if (c.indexOf(p) !== -1) return true;
        }
    }
    // If no language metadata present, treat as match (prefer not to filter out unknown)
    if (candidates.length === 0) return true;
    return false;
}

/** Safe getBaseUrl - reusing original with defensive checks */
function getBaseUrl(url) {
    if (typeof url !== 'string') {
        throw new ScriptException('URL must be a string');
    }
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
        throw new ScriptException('URL cannot be empty');
    }
    try {
        const urlTest = new URL(trimmedUrl);
        const host = urlTest.host;
        const protocol = urlTest.protocol;
        if (!host) throw new ScriptException(`URL must contain a valid host: ${url}`);
        if (!protocol) throw new ScriptException(`URL must contain a valid protocol: ${url}`);
        return `${protocol}//${host}`;
    } catch (error) {
        if (error instanceof ScriptException) {
            throw error;
        }
        throw new ScriptException(`Invalid URL format: ${url}`);
    }
}

/** addUrlHint helpers */
function addUrlHint(url, hintParam, hintValue = '1') {
    if (!url) return url;
    if (url.includes(`${hintParam}=${hintValue}`)) return url;
    try {
        const urlObj = new URL(url);
        urlObj.searchParams.append(hintParam, hintValue);
        return urlObj.toString();
    } catch (error) {
        log(`Error adding URL hint to ${url}: ${error}`);
        return url;
    }
}
function addContentUrlHint(url) { return addUrlHint(url, 'isPeertubeContent'); }
function addChannelUrlHint(url) { return addUrlHint(url, 'isPeertubeChannel'); }
function addPlaylistUrlHint(url) { return addUrlHint(url, 'isPeertubePlaylist'); }

/** Basic helpers from original script (shortened where appropriate) */
function extractVideoId(url) {
    try {
        if (!url) return null;
        const urlTest = new URL(url);
        const { pathname } = urlTest;
        const match = pathname.match(/^\/(videos\/(watch|embed)\/|w\/|api\/v1\/videos\/)([a-zA-Z0-9-_]+)(?:\/.*)?$/);
        return match ? match[3] : null;
    } catch (error) {
        log('Error extracting PeerTube video ID:' + error);
        return null;
    }
}
function extractChannelId(url) {
    try {
        if (!url) return null;
        const urlTest = new URL(url);
        const { pathname } = urlTest;
        const match = pathname.match(/^\/(c|video-channels|api\/v1\/video-channels)\/([a-zA-Z0-9-_.]+)(?:\/(video|videos)?)?\/?$/);
        return match ? match[2] : null;
    } catch (error) {
        log('Error extracting PeerTube channel ID:' + error);
        return null;
    }
}
function extractPlaylistId(url) {
    try {
        if (!url) return null;
        const urlTest = new URL(url);
        const { pathname } = urlTest;
        let match = pathname.match(/^\/(videos\/watch\/playlist\/|w\/p\/)([a-zA-Z0-9-_]+)(?:\/.*)?$/);
        if (!match) match = pathname.match(/^\/(video-playlists|api\/v1\/video-playlists)\/([a-zA-Z0-9-_]+)(?:\/.*)?$/);
        if (!match) match = pathname.match(/^\/(video-channels|c)\/[a-zA-Z0-9-_.]+\/video-playlists\/([a-zA-Z0-9-_]+)(?:\/.*)?$/);
        return match ? match[match.length - 1] : null;
    } catch (error) {
        log('Error extracting PeerTube playlist ID:' + error);
        return null;
    }
}

/** create media source helpers (copied from original) */
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
    const supportedResolution = file.resolution?.width && file.resolution?.height
        ? { width: file.resolution.width, height: file.resolution.height }
        : supportedResolutions[file.resolution?.label];
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
        if (playlist?.playlistUrl) {
            hlsOutputSources.push(new HLSSource({
                name: "HLS",
                url: playlist.playlistUrl,
                duration: obj.duration ?? 0,
                priority: true
            }));
        }
    }
    (obj?.files ?? []).forEach((file) => {
        inputFileSources.push(file);
    });
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
    else {
        if (hlsOutputSources.length && !unMuxedVideoOnlyOutputSources.length) return new VideoSourceDescriptor(hlsOutputSources);
        else if (muxedVideoOutputSources.length) return new VideoSourceDescriptor(muxedVideoOutputSources);
        else if (unMuxedVideoOnlyOutputSources.length && unMuxedAudioOnlyOutputSources.length) return new UnMuxVideoSourceDescriptor(unMuxedVideoOnlyOutputSources, unMuxedAudioOnlyOutputSources);
        return new VideoSourceDescriptor([]);
    }
}

/** --- Pagers and specialized pager classes (copied/kept) --- */
class PeerTubeVideoPager extends VideoPager {
    constructor(results, hasMore, path, params, page, sourceHost, isSearch, cbMap) {
        super(results, hasMore, { path, params, page, sourceHost, isSearch, cbMap });
    }
    nextPage() {
        return getVideoPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1, this.context.sourceHost, this.context.isSearch, this.context.cbMap);
    }
}
class PeerTubeChannelPager extends ChannelPager {
    constructor(results, hasMore, path, params, page) {
        super(results, hasMore, { path, params, page });
    }
    nextPage() {
        return getChannelPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1);
    }
}
class PeerTubeCommentPager extends CommentPager {
    constructor(results, hasMore, videoId, params, page, sourceBaseUrl) {
        super(results, hasMore, { videoId, params, page, sourceBaseUrl });
    }
    nextPage() {
        return getCommentPager(this.context.videoId, this.context.params, (this.context.page ?? 0) + 1, this.context.sourceBaseUrl);
    }
}
class PeerTubePlaylistPager extends PlaylistPager {
    constructor(results, hasMore, path, params, page, sourceHost, isSearch) {
        super(results, hasMore, { path, params, page, sourceHost, isSearch });
    }
    nextPage() {
        return getPlaylistPager(this.context.path, this.context.params, (this.context.page ?? 0) + 1, this.context.sourceHost, this.context.isSearch);
    }
}

/** Build query string from params (handles arrays) */
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

/** getChannelPager - unchanged logic but uses sourceHost param */
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
        const instanceBaseUrl = isSearch ? getBaseUrl(v.url) : sourceHost;
        return new PlatformAuthorLink(
            new PlatformID(PLATFORM, v.name, config.id),
            v.displayName,
            v.url,
            getAvatarUrl(v, instanceBaseUrl),
            v?.followersCount ?? 0
        );
    }), obj.total > (start + count), path, params, page);
}

/**
 * getVideoPager - fetches a page from a specific instance.
 * Accepts sourceHost param, isSearch flag, and optional cbMap to transform items.
 */
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
            ].filter(Boolean).map(getBaseUrl).find(Boolean);
            const contentUrl = addContentUrlHint(v.url || `${baseUrl}/videos/watch/${v.uuid}`);
            const instanceBaseUrl = isSearch ? baseUrl : sourceHost;
            const channelUrl = addChannelUrlHint(v.channel.url);
            return new PlatformVideo({
                id: new PlatformID(PLATFORM, v.uuid, config.id),
                name: v.name ?? "",
                thumbnails: new Thumbnails([new Thumbnail(`${instanceBaseUrl}${v.thumbnailPath}`, 0)]),
                author: new PlatformAuthorLink(
                    new PlatformID(PLATFORM, v.channel.name, config.id),
                    v.channel.displayName,
                    channelUrl,
                    getAvatarUrl(v, instanceBaseUrl)
                ),
                datetime: Math.round((new Date(v.publishedAt)).getTime() / 1000),
                duration: v.duration,
                viewCount: v.views,
                url: contentUrl,
                isLive: v.isLive,
                // attach raw metadata to allow client side language checks
                language: v.language ?? v.languageId ?? null,
                languages: v.languages ?? null
            });
        });
    return new PeerTubeVideoPager(contentResultList, hasMore, path, params, page, sourceHost, isSearch, cbMap);
}

/** getCommentPager (kept) */
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

/** getPlaylistPager (kept with sourceHost param support) */
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
        const playlistBaseUrl = isSearch ? getBaseUrl(playlist.url) : sourceHost;
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

/** Process subtitles - unchanged but defensive */
function processSubtitlesData(subtitlesResponse) {
    if (!subtitlesResponse.isOk) {
        log("Failed to get video subtitles", subtitlesResponse);
        return [];
    }
    try {
        const baseUrl = getBaseUrl(subtitlesResponse.url);
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

/** getContentDetails - kept mostly same but defensive + language metadata attached */
source.getContentDetails = function (url) {
    const videoId = extractVideoId(url);
    if (!videoId) return null;
    const sourceBaseUrl = getBaseUrl(url);
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
    const channelUrl = addChannelUrlHint(obj.channel.url);
    const subtitles = processSubtitlesData(captionsData);
    const result = new PlatformVideoDetails({
        id: new PlatformID(PLATFORM, obj.uuid, config.id),
        name: obj.name,
        thumbnails: new Thumbnails([new Thumbnail(`${sourceBaseUrl}${obj.thumbnailPath}`, 0)]),
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM, obj.channel.name, config.id),
            obj.channel.displayName,
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

/** getContentRecommendations - uses getVideoPager with sourceHost */
source.getContentRecommendations = function (url, obj) {
    const sourceHost = getBaseUrl(url);
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

/** getComments - unchanged wrapper */
source.getComments = function (url) {
    const videoId = extractVideoId(url);
    const sourceBaseUrl = getBaseUrl(url);
    return getCommentPager(videoId, {}, 0, sourceBaseUrl);
};

/** getSubComments - kept but defensive */
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
    const sourceBaseUrl = getBaseUrl(comment.contextUrl);
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

/** Playback tracker - unchanged except minor defensive checks */
source.getPlaybackTracker = function (url) {
    if (!_settings.submitActivity) return null;
    const videoId = extractVideoId(url);
    if (!videoId) return null;
    const sourceBaseUrl = getBaseUrl(url);
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
        const body = {
            currentTime,
            client: "GrayJay.app"
        };
        if (this.seekOccurred) {
            body.viewEvent = "seek";
            this.seekOccurred = false;
        }
        http.POST(url, JSON.stringify(body), { "Content-Type": "application/json" }, false);
    }
}

/** isChannelUrl / isPlaylistUrl / isContentDetailsUrl - kept (unchanged) */
source.isChannelUrl = function (url) {
    try {
        if (!url) return false;
        if (url.includes('isPeertubeChannel=1')) return true;
        const baseUrl = plugin.config.constants.baseUrl;
        const isInstanceChannel = url.startsWith(`${baseUrl}/video-channels/`) || url.startsWith(`${baseUrl}/c/`);
        if (isInstanceChannel) return true;
        const urlTest = new URL(url);
        const { host, pathname, searchParams } = urlTest;
        if (searchParams.has('isPeertubeChannel')) return true;
        const isKnownInstanceUrl = INDEX_INSTANCES.instances.includes(host);
        const isPeerTubeChannelPath = /^\/(c|video-channels|api\/v1\/video-channels)\/[a-zA-Z0-9-_.]+(\/(video|videos)?)?\/?$/.test(pathname);
        return isKnownInstanceUrl && isPeerTubeChannelPath;
    } catch (error) {
        log('Error checking PeerTube channel URL:', error);
        return false;
    }
};
source.isPlaylistUrl = function (url) {
    try {
        if (!url) return false;
        if (url.includes('isPeertubePlaylist=1')) return true;
        const baseUrl = plugin.config.constants.baseUrl;
        const isInstancePlaylist = url.startsWith(`${baseUrl}/videos/watch/playlist/`) ||
            url.startsWith(`${baseUrl}/w/p/`) ||
            url.startsWith(`${baseUrl}/video-playlists/`) ||
            (url.startsWith(`${baseUrl}/video-channels/`) && url.includes('/video-playlists/')) ||
            (url.startsWith(`${baseUrl}/c/`) && url.includes('/video-playlists/'));
        if (isInstancePlaylist) return true;
        const urlTest = new URL(url);
        const { host, pathname, searchParams } = urlTest;
        if (searchParams.has('isPeertubePlaylist')) return true;
        const isKnownInstanceUrl = INDEX_INSTANCES.instances.includes(host);
        const isPeerTubePlaylistPath = /^\/(videos\/watch\/playlist|w\/p)\/[a-zA-Z0-9-_]+$/.test(pathname) ||
            /^\/(video-playlists|api\/v1\/video-playlists)\/[a-zA-Z0-9-_]+$/.test(pathname) ||
            /^\/(video-channels|c)\/[a-zA-Z0-9-_.]+\/video-playlists\/[a-zA-Z0-9-_]+$/.test(pathname);
        return isKnownInstanceUrl && isPeerTubePlaylistPath;
    } catch (error) {
        log('Error checking PeerTube playlist URL:', error);
        return false;
    }
};
source.isContentDetailsUrl = function (url) {
    try {
        if (!url) return false;
        if (url.includes('isPeertubeContent=1')) return true;
        const baseUrl = plugin.config.constants.baseUrl;
        const isInstanceContentDetails = url.startsWith(`${baseUrl}/videos/watch/`) || url.startsWith(`${baseUrl}/w/`);
        if (isInstanceContentDetails) return true;
        const urlTest = new URL(url);
        const { host, pathname, searchParams } = urlTest;
        if (searchParams.has('isPeertubeContent')) return true;
        const isPeerTubeVideoPath = /^\/(videos\/(watch|embed)|w|api\/v1\/videos)\/[a-zA-Z0-9-_]+$/.test(pathname);
        const isKnownInstanceUrl = INDEX_INSTANCES.instances.includes(host);
        return isInstanceContentDetails || (isKnownInstanceUrl && isPeerTubeVideoPath);
    } catch (error) {
        log('Error checking PeerTube content URL:', error);
        return false;
    }
};

/** getChannel - unchanged except defensive extraction */
source.getChannel = function (url) {
    const handle = extractChannelId(url);
    if (!handle) {
        throw new ScriptException(`Failed to extract channel ID from URL: ${url}`);
    }
    const sourceBaseUrl = getBaseUrl(url);
    const urlWithParams = `${sourceBaseUrl}/api/v1/video-channels/${handle}`;
    const res = http.GET(urlWithParams, {});
    if (res.code != 200) {
        log("Failed to get channel", res);
        return null;
    }
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

/** getChannelContents - delegates to getPlaylistPager or getVideoPager with sourceHost */
source.getChannelContents = function (url, type, order, filters) {
    let sort = order;
    if (sort === Type.Order.Chronological) sort = "-publishedAt";
    const params = { sort };
    const handle = extractChannelId(url);
    const sourceBaseUrl = getBaseUrl(url);
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
    const sourceBaseUrl = getBaseUrl(url);
    return getPlaylistPager(`/api/v1/video-channels/${handle}/video-playlists`, params, 0, sourceBaseUrl);
};

/** getPlaylist - kept but defensive */
source.getPlaylist = function (url) {
    const playlistId = extractPlaylistId(url);
    if (!playlistId) return null;
    const sourceBaseUrl = getBaseUrl(url);
    const urlWithParams = `${sourceBaseUrl}/api/v1/video-playlists/${playlistId}`;
    const res = http.GET(urlWithParams, {});
    if (res.code != 200) {
        log("Failed to get playlist", res);
        return null;
    }
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
        contents: getVideoPager(
            `/api/v1/video-playlists/${playlistId}/videos`,
            {},
            0,
            sourceBaseUrl,
            false,
            (playlistItem) => playlistItem.video
        )
    });
};

/** getSearchCapabilities - kept */
source.getSearchCapabilities = () => ({
    types: [Type.Feed.Mixed, Type.Feed.Streams, Type.Feed.Videos],
    sorts: [Type.Order.Chronological, "publishedAt"]
});

/** searchSuggestions - simple empty (kept) */
source.searchSuggestions = function (query) {
    return [];
};

/**
 * search - supports SepiaSearch or instance search.
 * Adds languageOneOf param if available in settings (best-effort).
 */
source.search = function (query, type, order, filters) {
    if (source.isContentDetailsUrl(query)) return new ContentPager([source.getContentDetails(query)], false);
    let sort = order;
    if (sort === Type.Order.Chronological) sort = "-publishedAt";
    const params = { search: query, sort };
    if (type == Type.Feed.Streams) params.isLive = true;
    else if (type == Type.Feed.Videos) params.isLive = false;

    // language param (best-effort): if preferredLanguages set, try to include as languageOneOf
    const prefLangs = normalizePreferredLanguages(_settings.preferredLanguages);
    if (prefLangs.length) {
        params.languageOneOf = prefLangs;
    }

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

/**
 * getHome - build aggregated feed across selected instances
 * - samples instances (random or not)
 * - requests first page from each
 * - merges results, dedupes by id.value
 * - applies seenIds filter + maxPerChannel limit
 */
source.getHome = function () {
    // decide sort depending on server version compatibility
    let sort = '';
    if (ServerInstanceVersionIsSameOrNewer(state.serverVersion, '3.1.0')) sort = 'best';
    // select instances
    const instances = selectInstancesForFeed();
    // prepare params (attempt languageOneOf as best-effort)
    const params = {};
    if (sort) params.sort = sort;
    const prefLangs = normalizePreferredLanguages(_settings.preferredLanguages);
    if (prefLangs.length) params.languageOneOf = prefLangs;

    const perInstanceResults = [];
    for (const instance of instances) {
        try {
            const pager = getVideoPager('/api/v1/videos', params, 0, instance, false);
            if (pager && pager.results && pager.results.length) {
                // annotate instance host for each video so we can trace origin if needed
                pager.results.forEach(r => r._instanceHost = instance);
                perInstanceResults.push(...pager.results);
            }
        } catch (e) {
            log(`Error fetching from instance ${instance}: ${e}`);
        }
    }

    // combine, dedupe by id.value, skip seenIds, enforce per-channel limit
    const seen = new Set();
    const final = [];
    const perChannelCount = {};
    const maxPerChannel = Math.max(1, parseInt(_settings.maxPerChannel) || 2);
    const totalLimit = 20; // page size
    const includeSeen = false; // do not include videos in state's seenIds

    // first pass: remove exact duplicates by id and optionally filter by language client side
    for (const item of perInstanceResults) {
        if (!item || !item.id || !item.id.value) continue;
        const vid = item.id.value;
        if (seen.has(vid)) continue;
        if (includeSeen === false && (state.seenIds || []).includes(vid)) continue;
        // language filtering client-side as fallback
        if (!matchesPreferredLanguage(item)) continue;
        // channel flood control
        const channelKey = (item.author && item.author.id && item.author.id.value) || item.author?.name || 'unknown';
        perChannelCount[channelKey] = perChannelCount[channelKey] || 0;
        if (perChannelCount[channelKey] >= maxPerChannel) continue;
        // accept
        seen.add(vid);
        perChannelCount[channelKey]++;
        final.push(item);
        if (final.length >= totalLimit) break;
    }

    // push seen IDs into state
    final.forEach(v => pushSeenId(v.id.value));

    // return a pager containing merged results
    return new PeerTubeVideoPager(final, false, '/api/v1/videos', params, 0, instances.length ? instances[0] : plugin.config.constants.baseUrl, false);
};

/** getSearchChannels and getSearchPlaylists - use selected instance or SepiaSearch similar to search() */
source.searchChannels = function (query) {
    let sourceHost = state.isSearchEngineSepiaSearch ? 'https://sepiasearch.org' : plugin.config.constants.baseUrl;
    const isSearch = true;
    return getChannelPager('/api/v1/search/video-channels', { search: query }, 0, sourceHost, isSearch);
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

/** enable - parse config, settings, and saved state defensively */
source.enable = function (conf, settings, saveStateStr) {
    config = conf ?? {};
    _settings = parseSettings(settings ?? {});
    SEARCH_ENGINE_OPTIONS = loadOptionsForSetting('searchEngineIndex');
    let didSaveState = false;

    // default settings for testing
    if (IS_TESTING) {
        plugin.config = { constants: { baseUrl: "https://peertube.futo.org" } };
        _settings.searchEngineIndex = 0;
        _settings.submitActivity = true;
        _settings.instancesList = plugin.config.constants.baseUrl;
        _settings.randomizeInstances = false;
        _settings.instanceSampleSize = 3;
        _settings.maxPerChannel = 2;
        _settings.seenMax = 500;
    }

    state.isSearchEngineSepiaSearch = SEARCH_ENGINE_OPTIONS[_settings.searchEngineIndex] == 'Sepia Search';

    try {
        if (saveStateStr && typeof saveStateStr === 'string' && saveStateStr.trim().length) {
            const parsed = JSON.parse(saveStateStr);
            if (parsed) {
                // merge parsed state (but preserve defaults)
                state = { ...state, ...parsed };
                didSaveState = true;
            }
        }
    } catch (ex) {
        log('Failed to parse saveState:' + ex);
    }

    // If no saved state was loaded, attempt to get instance server version for baseUrl
    if (!didSaveState) {
        try {
            const [currentInstanceConfig] = http.batch()
                .GET(`${plugin.config.constants.baseUrl}/api/v1/config`, {})
                .execute();
            if (currentInstanceConfig.isOk) {
                const serverConfig = JSON.parse(currentInstanceConfig.body);
                state.serverVersion = serverConfig.serverVersion;
            }
        } catch (e) {
            log('Failed to fetch base instance config: ' + e);
        }
    }

    // Ensure state.seenIds exists
    state.seenIds = state.seenIds || [];
};

/** saveState - persist minimal state */
source.saveState = function () {
    return JSON.stringify({
        serverVersion: state.serverVersion,
        seenIds: state.seenIds
    });
};

/** getAvatarUrl - supports many PeerTube API shapes */
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

/** loadOptionsForSetting - utility from original */
function loadOptionsForSetting(settingKey, transformCallback) {
    transformCallback ??= (o) => o;
    const setting = config?.settings?.find((s) => s.variable == settingKey);
    return setting?.options?.map(transformCallback) ?? [];
}

/** helper: safe log */
function log(str) {
    if (!str) return;
    if (typeof str == "string") bridge.log(str);
    else bridge.log(JSON.stringify(str, null, 4));
}

/** Minimal batch definition fallback if http.batch not present in some runtimes */
if (http && typeof http.batch === 'function') {
    // use original
} else if (http) {
    http.batch = function () {
        const calls = [];
        return {
            GET: function (url, headers) {
                calls.push({ method: 'GET', url, headers });
                return this;
            },
            execute: function () {
                // naive sequential execution - not expected in production (host provides real batch)
                const results = calls.map(c => {
                    try {
                        const r = http.GET(c.url, c.headers || {});
                        return r;
                    } catch (e) {
                        return { isOk: false, code: 0, body: null };
                    }
                });
                return results;
            }
        };
    };
}

// Those instances were requested by users (existing list preserved)
INDEX_INSTANCES.instances = [
    ...INDEX_INSTANCES.instances, 'poast.tv', 'videos.upr.fr', 'peertube.red'
];
// BEGIN AUTOGENERATED INSTANCES
// This content is autogenerated during deployment using update-instances.sh and content from https://instances.joinpeertube.org
// Last updated at: 2025-07-12
INDEX_INSTANCES.instances = [
    ...INDEX_INSTANCES.instances,
    "video.blinkyparts.com",
    "vid.chaoticmira.gay",
    "peertube.nthpyro.dev",
    "watch.bojidar-bg.dev",
    "ishotenedthislistbecauseitstoolong.and.dumb.com",
];
// END AUTOGENERATED INSTANCES

// ---- End of script ----
