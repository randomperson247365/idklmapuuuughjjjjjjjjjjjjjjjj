// Declare source object first - REQUIRED by Grayjay
const source = {};

// Plugin constants
const PLATFORM = "PeerTube";
const TAG = "Enhanced PeerTube";

// Plugin state
let config = {};

// Default instance
const DEFAULT_INSTANCE = "peertube.futo.org";

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
            this.context.instance
        );
    }
}

// Plugin lifecycle methods
source.enable = function(conf, settings, saveStateStr) {
    // Log what we're receiving to debug
    console.log(`${TAG}: enable called`);
    console.log(`${TAG}: conf type: ${typeof conf}`);
    console.log(`${TAG}: settings type: ${typeof settings}`);
    console.log(`${TAG}: saveStateStr type: ${typeof saveStateStr}`);
    
    // Handle conf parameter safely
    if (conf === undefined || conf === null) {
        config = {};
    } else if (typeof conf === 'string') {
        // If it's a string, try to parse it
        try {
            config = JSON.parse(conf);
        } catch (e) {
            console.log(`${TAG}: Failed to parse conf string: ${e.message}`);
            console.log(`${TAG}: conf value: ${conf}`);
            config = {};
        }
    } else if (typeof conf === 'object') {
        // If it's already an object, use it directly
        config = conf;
    } else {
        // Unknown type, log it and use empty config
        console.log(`${TAG}: Unknown conf type: ${typeof conf}, value: ${conf}`);
        config = {};
    }
    
    console.log(`${TAG}: Plugin enabled with config: ${JSON.stringify(config)}`);
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
        nsfw: "both"
    }, page, DEFAULT_INSTANCE);
};

// Search suggestions (not implemented for PeerTube)
source.searchSuggestions = function(query) {
    return [];
};

// Search implementation
source.search = function(query, type, order, filters, continuationToken) {
    console.log(`${TAG}: Searching for: ${query}`);
    const page = continuationToken ? parseInt(continuationToken) : 0;
    
    return getVideoPager('/api/v1/search/videos', { 
        search: query, 
        sort: "-publishedAt",
        nsfw: "both"
    }, page, DEFAULT_INSTANCE);
};

// Channel URL detection
source.isChannelUrl = function(url) {
    return url.includes("/c/") || url.includes("/a/") || url.includes("/video-channels/");
};

// Content URL detection
source.isContentDetailsUrl = function(url) {
    return url.includes("/w/") || url.includes("/videos/watch/");
};

// Get channel details
source.getChannel = function(url) {
    console.log(`${TAG}: Getting channel from URL: ${url}`);
    
    const channelMatch = url.match(/\/c\/([^\/]+)|\/video-channels\/([^\/]+)/);
    if (!channelMatch) return null;
    
    const channelName = channelMatch[1] || channelMatch[2];
    const instance = extractInstance(url) || DEFAULT_INSTANCE;
    const apiUrl = `https://${instance}/api/v1/video-channels/${channelName}`;
    
    try {
        const response = Http.GET(apiUrl, {}, false);
        if (!response.isOk) {
            console.log(`${TAG}: Failed to get channel, status: ${response.code}`);
            return null;
        }
        
        // Log raw response for debugging
        console.log(`${TAG}: Raw channel response length: ${response.body ? response.body.length : 0}`);
        
        let channel;
        try {
            channel = JSON.parse(response.body);
        } catch (parseError) {
            console.log(`${TAG}: Failed to parse channel JSON: ${parseError.message}`);
            console.log(`${TAG}: Response body preview: ${response.body ? response.body.substring(0, 100) : 'empty'}`);
            return null;
        }
        
        return new PlatformChannel({
            id: new PlatformID(PLATFORM, channel.name, config.id),
            name: channel.displayName,
            thumbnail: channel.avatar ? `https://${instance}${channel.avatar.path}` : "",
            banner: channel.banner ? `https://${instance}${channel.banner.path}` : "",
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
    if (!channelMatch) return new PeerTubeVideoPager([], false, {});
    
    const channelName = channelMatch[1] || channelMatch[2];
    const instance = extractInstance(url) || DEFAULT_INSTANCE;
    const page = continuationToken ? parseInt(continuationToken) : 0;
    
    return getVideoPager(`/api/v1/video-channels/${channelName}/videos`, {
        sort: "-publishedAt",
        nsfw: "both"
    }, page, instance);
};

// Get video details
source.getContentDetails = function(url) {
    console.log(`${TAG}: Getting content details for: ${url}`);
    
    const videoId = extractVideoId(url);
    if (!videoId) {
        console.log(`${TAG}: Could not extract video ID from URL`);
        return null;
    }

    const instance = extractInstance(url) || DEFAULT_INSTANCE;
    const apiUrl = `https://${instance}/api/v1/videos/${videoId}`;
    
    try {
        const response = Http.GET(apiUrl, {}, false);
        if (!response.isOk) {
            console.log(`${TAG}: Failed to fetch video details, status: ${response.code}`);
            return null;
        }
        
        // Log raw response for debugging
        console.log(`${TAG}: Raw video response length: ${response.body ? response.body.length : 0}`);
        
        let video;
        try {
            video = JSON.parse(response.body);
        } catch (parseError) {
            console.log(`${TAG}: Failed to parse video JSON: ${parseError.message}`);
            console.log(`${TAG}: Response body preview: ${response.body ? response.body.substring(0, 100) : 'empty'}`);
            return null;
        }
        
        // Build video sources
        const videoSources = [];
        
        // Add HLS sources if available
        if (video.streamingPlaylists && video.streamingPlaylists.length > 0) {
            for (const playlist of video.streamingPlaylists) {
                if (playlist.type === 1 && playlist.playlistUrl) {
                    videoSources.push(new HLSSource({
                        name: "HLS Stream",
                        url: playlist.playlistUrl,
                        duration: video.duration
                    }));
                }
            }
        }
        
        // Add direct file sources
        if (video.files && video.files.length > 0) {
            for (const file of video.files) {
                if (file.fileUrl) {
                    const height = file.resolution?.height || 0;
                    const width = file.resolution?.width || 0;
                    const label = file.resolution?.label || "Direct";
                    
                    videoSources.push(new VideoUrlSource({
                        url: file.fileUrl,
                        quality: label,
                        name: label,
                        width: width,
                        height: height,
                        container: "video/mp4",
                        duration: video.duration
                    }));
                }
            }
        }

        // Build thumbnails
        const thumbnails = [];
        if (video.thumbnailPath) {
            thumbnails.push(new Thumbnail(`https://${instance}${video.thumbnailPath}`, 0));
        }
        if (video.previewPath) {
            thumbnails.push(new Thumbnail(`https://${instance}${video.previewPath}`, 1));
        }

        // Build author/channel info
        const channelUrl = `https://${instance}/c/${video.channel.name}`;
        const channelAvatar = video.channel.avatar ? `https://${instance}${video.channel.avatar.path}` : "";

        return new PlatformVideoDetails({
            id: new PlatformID(PLATFORM, video.uuid, config.id),
            name: video.name,
            thumbnails: new Thumbnails(thumbnails),
            author: new PlatformAuthorLink(
                new PlatformID(PLATFORM, video.channel.name, config.id),
                video.channel.displayName,
                channelUrl,
                channelAvatar
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

// Main video fetching function with improved error handling
function getVideoPager(path, params, page, instance) {
    const inst = instance || DEFAULT_INSTANCE;
    const count = 20;
    const start = page * count;
    
    const queryParams = { 
        start: start, 
        count: count
    };
    
    // Add params
    for (const key in params) {
        if (params[key] !== undefined && params[key] !== null) {
            queryParams[key] = params[key];
        }
    }
    
    const queryString = Object.keys(queryParams)
        .map(key => `${key}=${encodeURIComponent(queryParams[key])}`)
        .join('&');
    
    const url = `https://${inst}${path}?${queryString}`;
    
    console.log(`${TAG}: Fetching from: ${url}`);
    
    try {
        const response = Http.GET(url, {}, false);
        
        // Check if response is OK
        if (!response.isOk) {
            console.log(`${TAG}: Failed to fetch videos, status: ${response.code}`);
            return new PeerTubeVideoPager([], false, {});
        }
        
        // Log raw response for debugging
        console.log(`${TAG}: Response status: ${response.code}, body length: ${response.body ? response.body.length : 0}`);
        
        // Check if response body exists
        if (!response.body) {
            console.log(`${TAG}: Empty response body`);
            return new PeerTubeVideoPager([], false, {});
        }
        
        // Try to parse JSON
        let data;
        try {
            data = JSON.parse(response.body);
        } catch (parseError) {
            console.log(`${TAG}: JSON parse error: ${parseError.message}`);
            console.log(`${TAG}: Response body preview: ${response.body.substring(0, 200)}`);
            return new PeerTubeVideoPager([], false, {});
        }
        
        // Validate data structure
        if (!data || typeof data !== 'object') {
            console.log(`${TAG}: Invalid data type: ${typeof data}`);
            return new PeerTubeVideoPager([], false, {});
        }
        
        if (!data.data || !Array.isArray(data.data)) {
            console.log(`${TAG}: Invalid data structure - missing or non-array data field`);
            console.log(`${TAG}: Data keys: ${Object.keys(data).join(', ')}`);
            return new PeerTubeVideoPager([], false, {});
        }
        
        const videos = [];
        for (const video of data.data) {
            try {
                videos.push(convertToPlatformVideo(video, inst));
            } catch (conversionError) {
                console.log(`${TAG}: Error converting video: ${conversionError.message}`);
            }
        }
        
        const hasMore = data.total > (start + count);
        
        const context = {
            path: path,
            params: params,
            page: page,
            instance: inst
        };
        
        return new PeerTubeVideoPager(videos, hasMore, context);
    } catch (error) {
        console.log(`${TAG}: Error fetching videos: ${error.message}`);
        console.log(`${TAG}: Error stack: ${error.stack}`);
        return new PeerTubeVideoPager([], false, {});
    }
}

// Convert PeerTube video object to Grayjay PlatformVideo with validation
function convertToPlatformVideo(video, instance) {
    // Validate required fields
    if (!video || !video.uuid || !video.name) {
        console.log(`${TAG}: Invalid video object - missing required fields`);
        throw new Error("Invalid video object");
    }
    
    if (!video.channel || !video.channel.name) {
        console.log(`${TAG}: Invalid video object - missing channel info`);
        throw new Error("Invalid channel info");
    }
    
    const baseUrl = `https://${instance}`;
    
    const thumbnails = [];
    if (video.thumbnailPath) {
        thumbnails.push(new Thumbnail(`${baseUrl}${video.thumbnailPath}`, 0));
    }
    if (video.previewPath) {
        thumbnails.push(new Thumbnail(`${baseUrl}${video.previewPath}`, 1));
    }
    
    const channelUrl = `${baseUrl}/c/${video.channel.name}`;
    const channelAvatar = video.channel.avatar ? `${baseUrl}${video.channel.avatar.path}` : "";
    
    return new PlatformVideo({
        id: new PlatformID(PLATFORM, video.uuid, config.id),
        name: video.name,
        thumbnails: new Thumbnails(thumbnails),
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM, video.channel.name, config.id),
            video.channel.displayName || video.channel.name,
            channelUrl,
            channelAvatar
        ),
        uploadDate: video.publishedAt ? Math.floor(new Date(video.publishedAt).getTime() / 1000) : 0,
        duration: video.duration || 0,
        viewCount: video.views || 0,
        url: `${baseUrl}/w/${video.uuid}`,
        isLive: video.isLive || false
    });
}

// Utility functions with better error handling
function extractVideoId(url) {
    if (!url || typeof url !== 'string') {
        return null;
    }
    
    const patterns = [
        /\/w\/([a-zA-Z0-9-]+)/,
        /\/videos\/watch\/([a-zA-Z0-9-]+)/,
        /\/videos\/embed\/([a-zA-Z0-9-]+)/
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match && match[1]) {
            return match[1];
        }
    }
    return null;
}

function extractInstance(url) {
    if (!url || typeof url !== 'string') {
        return null;
    }
    
    try {
        const match = url.match(/https?:\/\/([^\/]+)/);
        return match ? match[1] : null;
    } catch (error) {
        console.log(`${TAG}: Error extracting instance: ${error.message}`);
        return null;
    }
}

// Log plugin loaded
console.log(`${TAG}: Enhanced PeerTube plugin loaded successfully`);