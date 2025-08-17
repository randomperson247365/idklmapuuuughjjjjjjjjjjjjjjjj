// Declare source object first - REQUIRED by Grayjay
const source = {};

// Plugin constants
const PLATFORM = "PeerTube";
const TAG = "Enhanced PeerTube";
const PLATFORM_CLAIMTYPE = 1; // PeerTube platform claim type

// Plugin state
let config = {};
let _settings = {};
let instanceCache = null;
let instanceCacheTime = 0;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// Fallback instances if API fails
const FALLBACK_INSTANCES = [
    "peertube.futo.org",
    "tube.tchncs.de",
    "video.blender.org",
    "peertube.social",
    "framatube.org"
];

// Custom VideoPager class - REQUIRED for pagination
class PeerTubeVideoPager extends VideoPager {
    constructor(results, hasMore, context) {
        super(results, hasMore, context);
        this.context = context || {};
    }
    
    nextPage() {
        this.context.page = (this.context.page || 0) + 1;
        return getVideoPager(
            this.context.path,
            this.context.params,
            this.context.page,
            this.context.sourceHost
        );
    }
}

// Plugin lifecycle methods
source.enable = function(conf, settings, saveStateStr) {
    config = conf ?? {};
    _settings = settings ?? {};
    console.log(`${TAG}: Plugin enabled with settings:`, JSON.stringify(_settings));
};

source.disable = function() {
    console.log(`${TAG}: Plugin disabled`);
};

// Home feed
source.getHome = function(continuationToken) {
    console.log(`${TAG}: Getting home feed`);
    const page = continuationToken ? parseInt(continuationToken) : 0;
    return getVideoPager('/api/v1/videos', { 
        sort: "-publishedAt",
        isLocal: _settings.showRemoteVideos ? undefined : true
    }, page);
};

// Search suggestions (not implemented for PeerTube)
source.searchSuggestions = function(query) {
    return [];
};

// Search capabilities
source.getSearchCapabilities = function() {
    return {
        types: ["Feeds"],
        sorts: ["publishedAt", "-publishedAt", "views", "-views"]
    };
};

// Search implementation
source.search = function(query, type, order, filters, continuationToken) {
    console.log(`${TAG}: Searching for: ${query}`);
    const page = continuationToken ? parseInt(continuationToken) : 0;
    const sort = order || "-publishedAt";
    
    return getVideoPager('/api/v1/search/videos', { 
        search: query, 
        sort: sort,
        isLocal: _settings.showRemoteVideos ? undefined : true
    }, page);
};

// Channel URL detection
source.isChannelUrl = function(url) {
    return /\/c\/|\/a\/|\/video-channels\//.test(url);
};

// Content URL detection
source.isContentDetailsUrl = function(url) {
    return /\/w\/|\/videos\/watch\//.test(url);
};

// Get channel details
source.getChannel = function(url) {
    console.log(`${TAG}: Getting channel from URL: ${url}`);
    
    const channelMatch = url.match(/\/c\/([^\/]+)|\/video-channels\/([^\/]+)/);
    if (!channelMatch) return null;
    
    const channelName = channelMatch[1] || channelMatch[2];
    const baseUrl = extractBaseUrl(url) || getBaseInstance();
    const apiUrl = `https://${baseUrl}/api/v1/video-channels/${channelName}`;
    
    try {
        const response = Http.GET(apiUrl, {}, false);
        if (!response.isOk) return null;
        
        const channel = JSON.parse(response.body);
        
        return new PlatformChannel({
            id: new PlatformID(PLATFORM, channel.name, config.id, PLATFORM_CLAIMTYPE),
            name: channel.displayName,
            thumbnail: channel.avatar ? `https://${baseUrl}${channel.avatar.path}` : null,
            banner: channel.banner ? `https://${baseUrl}${channel.banner.path}` : null,
            subscribers: channel.followersCount || 0,
            description: channel.description || "",
            url: url,
            links: []
        });
    } catch (error) {
        console.log(`${TAG}: Error fetching channel: ${error.message}`);
        return null;
    }
};

// Get channel contents
source.getChannelContents = function(url, type, order, filters, continuationToken) {
    console.log(`${TAG}: Getting channel contents from: ${url}`);
    
    const channelMatch = url.match(/\/c\/([^\/]+)|\/video-channels\/([^\/]+)/);
    if (!channelMatch) return new VideoPager([], false);
    
    const channelName = channelMatch[1] || channelMatch[2];
    const baseUrl = extractBaseUrl(url) || getBaseInstance();
    const page = continuationToken ? parseInt(continuationToken) : 0;
    
    return getVideoPager(`/api/v1/video-channels/${channelName}/videos`, {
        sort: order || "-publishedAt"
    }, page, baseUrl);
};

// Get video details
source.getContentDetails = function(url) {
    console.log(`${TAG}: Getting content details for: ${url}`);
    
    const videoId = extractVideoId(url);
    if (!videoId) {
        console.log(`${TAG}: Could not extract video ID from URL`);
        return null;
    }

    const baseUrl = extractBaseUrl(url) || getBaseInstance();
    const apiUrl = `https://${baseUrl}/api/v1/videos/${videoId}`;
    
    try {
        const response = Http.GET(apiUrl, {}, false);
        if (!response.isOk) {
            console.log(`${TAG}: Failed to fetch video details, status: ${response.code}`);
            return null;
        }
        
        const video = JSON.parse(response.body);
        
        // Build video sources
        const videoSources = [];
        
        // Add HLS sources if available
        if (video.streamingPlaylists && video.streamingPlaylists.length > 0) {
            video.streamingPlaylists.forEach(playlist => {
                if (playlist.type === 1 && playlist.playlistUrl) {
                    videoSources.push(new HLSSource({
                        name: "HLS Stream",
                        url: playlist.playlistUrl,
                        duration: video.duration,
                        priority: true
                    }));
                }
            });
        }
        
        // Add direct file sources
        if (video.files && video.files.length > 0) {
            video.files.forEach(file => {
                if (file.fileUrl) {
                    videoSources.push(new VideoUrlSource({
                        url: file.fileUrl,
                        quality: file.resolution?.label || "Unknown",
                        name: file.resolution?.label || "Direct",
                        width: file.resolution?.width || 0,
                        height: file.resolution?.height || 0,
                        container: "video/mp4",
                        duration: video.duration
                    }));
                }
            });
        }

        // Build thumbnails array
        const thumbnails = [];
        if (video.thumbnailPath) {
            thumbnails.push(new Thumbnail(`https://${baseUrl}${video.thumbnailPath}`, 0));
        }
        if (video.previewPath) {
            thumbnails.push(new Thumbnail(`https://${baseUrl}${video.previewPath}`, 1));
        }

        return new PlatformVideoDetails({
            id: new PlatformID(PLATFORM, video.uuid, config.id, PLATFORM_CLAIMTYPE),
            name: video.name,
            thumbnails: new Thumbnails(thumbnails),
            author: new PlatformAuthorLink(
                new PlatformID(PLATFORM, video.channel.name, config.id, PLATFORM_CLAIMTYPE),
                video.channel.displayName,
                `https://${baseUrl}/c/${video.channel.name}`,
                video.channel.avatar ? `https://${baseUrl}${video.channel.avatar.path}` : null
            ),
            uploadDate: Math.floor(new Date(video.publishedAt).getTime() / 1000),
            duration: video.duration || 0,
            viewCount: video.views || 0,
            url: url,
            isLive: video.isLive || false,
            description: video.description || "",
            video: new VideoSourceDescriptor(videoSources),
            rating: video.likes ? new RatingLikes(video.likes) : null,
            subtitles: []
        });
    } catch (error) {
        console.log(`${TAG}: Error fetching video details: ${error.message}`);
        return null;
    }
};

// Helper function to get video sources (called by getContentDetails)
source.getVideoSources = function(url) {
    const details = source.getContentDetails(url);
    return details ? details.video : new VideoSourceDescriptor([]);
};

// Main video fetching function
function getVideoPager(path, params, page, sourceHost) {
    const instances = getActiveInstances();
    const videosPerInstance = parseInt(_settings.contentMixRatio) || 3;
    const allVideos = [];
    let hasMoreContent = false;
    
    // Fetch from multiple instances if enabled
    if (instances.length > 1 && page === 0 && !sourceHost) {
        instances.forEach(instance => {
            try {
                const result = fetchVideosFromInstance(instance, path, params, 0, videosPerInstance);
                allVideos.push(...result.videos);
                hasMoreContent = hasMoreContent || result.hasMore;
            } catch (error) {
                console.log(`${TAG}: Failed to fetch from ${instance}: ${error.message}`);
            }
        });
        
        // Shuffle videos for variety
        shuffleArray(allVideos);
    } else {
        // Single instance fetch (for pagination or specific source)
        const host = sourceHost || instances[0] || getBaseInstance();
        const result = fetchVideosFromInstance(host, path, params, page || 0, 20);
        allVideos.push(...result.videos);
        hasMoreContent = result.hasMore;
    }
    
    const context = {
        path: path,
        params: params,
        page: page || 0,
        sourceHost: sourceHost
    };
    
    return new PeerTubeVideoPager(allVideos, hasMoreContent, context);
}

// Fetch videos from a specific instance
function fetchVideosFromInstance(host, path, params, page, count) {
    const start = page * count;
    
    const queryParams = { 
        ...params, 
        start: start, 
        count: count,
        nsfw: "both"
    };
    
    // Filter out undefined values
    Object.keys(queryParams).forEach(key => {
        if (queryParams[key] === undefined || queryParams[key] === null) {
            delete queryParams[key];
        }
    });
    
    const queryString = Object.keys(queryParams)
        .map(key => `${key}=${encodeURIComponent(queryParams[key])}`)
        .join('&');
    
    const url = `https://${host}${path}?${queryString}`;
    
    console.log(`${TAG}: Fetching from: ${url}`);
    
    try {
        const response = Http.GET(url, {}, false);
        if (!response.isOk) {
            console.log(`${TAG}: Failed to fetch videos from ${url}, status: ${response.code}`);
            return { videos: [], hasMore: false };
        }
        
        const data = JSON.parse(response.body);
        const videos = (data.data || []).map(video => convertToPlatformVideo(video, host));
        
        return {
            videos: videos,
            hasMore: data.total > (start + count)
        };
    } catch (error) {
        console.log(`${TAG}: Error fetching videos: ${error.message}`);
        return { videos: [], hasMore: false };
    }
}

// Convert PeerTube video object to Grayjay PlatformVideo
function convertToPlatformVideo(video, instance) {
    const baseUrl = `https://${instance}`;
    
    const thumbnails = [];
    if (video.thumbnailPath) {
        thumbnails.push(new Thumbnail(`${baseUrl}${video.thumbnailPath}`, 0));
    }
    if (video.previewPath) {
        thumbnails.push(new Thumbnail(`${baseUrl}${video.previewPath}`, 1));
    }
    
    return new PlatformVideo({
        id: new PlatformID(PLATFORM, video.uuid, config.id, PLATFORM_CLAIMTYPE),
        name: video.name,
        thumbnails: new Thumbnails(thumbnails),
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM, video.channel.name, config.id, PLATFORM_CLAIMTYPE),
            video.channel.displayName,
            `${baseUrl}/c/${video.channel.name}`,
            video.channel.avatar ? `${baseUrl}${video.channel.avatar.path}` : null
        ),
        uploadDate: Math.floor(new Date(video.publishedAt).getTime() / 1000),
        duration: video.duration || 0,
        viewCount: video.views || 0,
        url: `${baseUrl}/w/${video.uuid}`,
        isLive: video.isLive || false
    });
}

// Get active instances based on settings
function getActiveInstances() {
    const instances = [];
    
    // Add primary instance
    const primary = _settings.primaryInstance || "peertube.futo.org";
    instances.push(primary);
    
    // Add additional instances
    if (_settings.additionalInstances) {
        const additional = _settings.additionalInstances.split(',')
            .map(i => i.trim())
            .filter(i => i && !instances.includes(i));
        instances.push(...additional);
    }
    
    // Add random instances if enabled
    if (_settings.enableRandomInstances) {
        const randomInstances = getRandomInstances();
        randomInstances.forEach(instance => {
            if (!instances.includes(instance)) {
                instances.push(instance);
            }
        });
    }
    
    return instances.length > 0 ? instances : FALLBACK_INSTANCES;
}

// Get random instances (with caching)
function getRandomInstances() {
    // Check cache
    if (_settings.cacheRandomInstances && instanceCache && 
        (Date.now() - instanceCacheTime) < CACHE_DURATION) {
        return instanceCache;
    }
    
    try {
        // Fetch instance list from PeerTube directory
        const response = Http.GET("https://instances.joinpeertube.org/api/v1/instances?count=100&healthy=true", {}, false);
        if (response.isOk) {
            const data = JSON.parse(response.body);
            const instances = data.data
                .filter(i => i.totalVideos > 100)
                .map(i => i.host)
                .slice(0, parseInt(_settings.randomInstanceCount) || 3);
            
            // Update cache
            instanceCache = instances;
            instanceCacheTime = Date.now();
            
            return instances;
        }
    } catch (error) {
        console.log(`${TAG}: Failed to fetch random instances: ${error.message}`);
    }
    
    return [];
}

// Utility functions
function getBaseInstance() {
    return _settings.primaryInstance || config.constants?.baseUrl?.replace('https://', '') || "peertube.futo.org";
}

function extractVideoId(url) {
    const patterns = [
        /\/w\/([a-zA-Z0-9-]+)/,
        /\/videos\/watch\/([a-zA-Z0-9-]+)/,
        /\/videos\/embed\/([a-zA-Z0-9-]+)/
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

function extractBaseUrl(url) {
    try {
        const match = url.match(/https?:\/\/([^\/]+)/);
        return match ? match[1] : null;
    } catch (error) {
        return null;
    }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// Log plugin loaded
console.log(`${TAG}: Enhanced PeerTube plugin loaded successfully`);