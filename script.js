const PLATFORM = "PeerTube";
const TAG = "Enhanced PeerTube";

let config = {};
let _settings = {};

// Fallback instances if API fails
const FALLBACK_INSTANCES = [
    "peertube.futo.org",
    "tube.tchncs.de",
    "video.blender.org",
    "peertube.social",
    "framatube.org"
];

source.enable = function(conf, settings, saveStateStr) {
    config = conf ?? {};
    _settings = settings ?? {};
    console.log(`${TAG}: Plugin enabled`);
};

source.getHome = function() {
    return getVideoPager('/api/v1/videos', { sort: "-publishedAt" }, 0);
};

source.searchSuggestions = function(query) {
    return [];
};

source.getSearchCapabilities = function() {
    return {
        types: [Type.Feed.Mixed],
        sorts: [Type.Order.Chronological, "publishedAt"]
    };
};

source.search = function(query, type, order, filters) {
    const sort = order === Type.Order.Chronological ? "-publishedAt" : order;
    return getVideoPager('/api/v1/search/videos', { search: query, sort }, 0);
};

source.isChannelUrl = function(url) {
    return /\/c\/|\/a\/|\/video-channels\//.test(url);
};

source.isContentDetailsUrl = function(url) {
    return /\/w\/|\/videos\/watch\//.test(url);
};

source.getContentDetails = function(url) {
    const videoId = extractVideoId(url);
    if (!videoId) return null;

    const baseUrl = getBaseInstance();
    const apiUrl = `https://${baseUrl}/api/v1/videos/${videoId}`;
    
    try {
        const response = http.GET(apiUrl, {}, false);
        if (response.code !== 200) return null;
        
        const video = JSON.parse(response.body);
        
        const videoSources = [];
        
        // Add HLS sources
        if (video.streamingPlaylists) {
            video.streamingPlaylists.forEach(playlist => {
                if (playlist.type === 1) {
                    videoSources.push(new HLSSource({
                        name: "HLS",
                        url: playlist.playlistUrl,
                        duration: video.duration
                    }));
                }
            });
        }
        
        // Add direct file sources
        if (video.files) {
            video.files.forEach(file => {
                videoSources.push(new VideoUrlSource({
                    url: file.fileUrl,
                    name: file.resolution?.label || "Unknown",
                    container: "mp4",
                    width: file.resolution?.width || 0,
                    height: file.resolution?.height || 0,
                    duration: video.duration
                }));
            });
        }

        return new PlatformVideoDetails({
            id: new PlatformID(PLATFORM, video.uuid, config.id),
            name: video.name,
            thumbnails: new Thumbnails([new Thumbnail(`https://${baseUrl}${video.thumbnailPath}`, 0)]),
            author: new PlatformAuthorLink(
                new PlatformID(PLATFORM, video.channel.name, config.id),
                video.channel.displayName,
                `https://${baseUrl}/c/${video.channel.name}`,
                video.channel.avatar?.url ? `https://${baseUrl}${video.channel.avatar.url}` : null
            ),
            uploadDate: Math.floor(new Date(video.publishedAt).getTime() / 1000),
            duration: video.duration,
            viewCount: video.views,
            url: url,
            isLive: video.isLive,
            description: video.description,
            video: new VideoSourceDescriptor(videoSources)
        });
    } catch (error) {
        console.log(`${TAG}: Error fetching video details: ${error.message}`);
        return null;
    }
};

function getVideoPager(path, params, page, sourceHost) {
    const host = sourceHost || getBaseInstance();
    const count = 20;
    const start = (page ?? 0) * count;
    
    const queryParams = { 
        ...params, 
        start, 
        count,
        nsfw: "both"
    };
    
    const queryString = Object.keys(queryParams)
        .filter(key => queryParams[key] !== undefined && queryParams[key] !== null)
        .map(key => `${key}=${encodeURIComponent(queryParams[key])}`)
        .join('&');
    
    const url = `https://${host}${path}?${queryString}`;
    
    try {
        const response = http.GET(url, {}, false);
        if (response.code !== 200) {
            console.log(`${TAG}: Failed to fetch videos from ${url}`);
            return new VideoPager([], false);
        }
        
        const data = JSON.parse(response.body);
        const videos = (data.data || []).map(video => convertToPlatformVideo(video, host));
        
        return new VideoPager(videos, data.total > (start + count));
    } catch (error) {
        console.log(`${TAG}: Error fetching videos: ${error.message}`);
        return new VideoPager([], false);
    }
}

function convertToPlatformVideo(video, instance) {
    const baseUrl = `https://${instance}`;
    
    return new PlatformVideo({
        id: new PlatformID(PLATFORM, video.uuid, config.id),
        name: video.name,
        thumbnails: new Thumbnails([new Thumbnail(`${baseUrl}${video.thumbnailPath}`, 0)]),
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM, video.channel.name, config.id),
            video.channel.displayName,
            `${baseUrl}/c/${video.channel.name}`,
            video.channel.avatar?.url ? `${baseUrl}${video.channel.avatar.url}` : null
        ),
        uploadDate: Math.floor(new Date(video.publishedAt).getTime() / 1000),
        duration: video.duration || 0,
        viewCount: video.views || 0,
        url: `${baseUrl}/w/${video.uuid}`,
        isLive: video.isLive || false
    });
}

function getBaseInstance() {
    return _settings.primaryInstance || config.constants?.baseUrl?.replace('https://', '') || "peertube.futo.org";
}

function extractVideoId(url) {
    const patterns = [
        /\/w\/([a-f0-9-]+)/i,
        /\/videos\/watch\/([a-f0-9-]+)/i
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

console.log(`${TAG}: Enhanced PeerTube plugin loaded`);