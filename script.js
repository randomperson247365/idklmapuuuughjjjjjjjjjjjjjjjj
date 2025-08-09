const PLATFORM = "PeerTube";
const TAG = "Enhanced PeerTube";

let settings = {};
let randomInstancesCache = [];
let lastInstanceFetch = 0;
const INSTANCE_CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// Video categories mapping
const CATEGORIES = {
    1: "music",
    2: "films", 
    3: "vehicles",
    4: "art",
    5: "sports",
    6: "travels",
    7: "gaming",
    8: "people",
    9: "comedy",
    10: "entertainment",
    11: "news",
    12: "howto",
    13: "education",
    14: "activism",
    15: "science"
};

// Language codes mapping
const LANGUAGES = {
    "en": "English",
    "fr": "French", 
    "de": "German",
    "es": "Spanish",
    "it": "Italian",
    "pt": "Portuguese",
    "ru": "Russian",
    "ja": "Japanese",
    "zh": "Chinese"
};

/**
 * Initialize plugin settings
 */
function getSettings() {
    return {
        primaryInstance: getSetting("primaryInstance") || "peertube.futo.org",
        additionalInstances: (getSetting("additionalInstances") || "").split(",").map(s => s.trim()).filter(s => s),
        contentMixRatio: 3, // Fixed value since we removed the setting
        showRemoteVideos: true, // Fixed value
        preferredLanguages: ["en"], // Fixed value
        contentCategories: ["all"], // Fixed value
        enableRandomInstances: getSetting("enableRandomInstances") !== "false",
        randomInstanceCount: 3, // Fixed value
        instanceHealthFilter: true, // Fixed value
        cacheRandomInstances: true // Fixed value
    };
}

/**
 * Fetch random PeerTube instances from the public directory
 */
function fetchRandomInstances() {
    const settings = getSettings();
    
    if (!settings.enableRandomInstances) {
        return [];
    }

    // Check cache validity
    if (settings.cacheRandomInstances && 
        randomInstancesCache.length > 0 && 
        Date.now() - lastInstanceFetch < INSTANCE_CACHE_DURATION) {
        console.log(`${TAG}: Using cached random instances`);
        return randomInstancesCache.slice(0, settings.randomInstanceCount);
    }

    try {
        console.log(`${TAG}: Fetching random instances from public directory`);
        
        // Try the instances API first
        let instances = [];
        try {
            const hostsUrl = "https://instances.joinpeertube.org/api/v1/instances/hosts";
            const hostsResponse = makeRequest(hostsUrl);
            
            if (hostsResponse && Array.isArray(hostsResponse.hosts)) {
                instances = hostsResponse.hosts;
                console.log(`${TAG}: Fetched ${instances.length} instance hosts`);
            }
        } catch (error) {
            console.log(`${TAG}: Failed to fetch hosts, trying full instances list`);
        }
        
        // If hosts API failed, try the full instances API
        if (instances.length === 0) {
            try {
                const instancesUrl = "https://instances.joinpeertube.org/api/v1/instances?start=0&count=200";
                const instancesResponse = makeRequest(instancesUrl);
                
                if (instancesResponse && instancesResponse.data && Array.isArray(instancesResponse.data)) {
                    instances = instancesResponse.data.map(instance => instance.host).filter(host => host);
                    console.log(`${TAG}: Fetched ${instances.length} instances from full API`);
                }
            } catch (error) {
                console.log(`${TAG}: Failed to fetch full instances list: ${error.message}`);
            }
        }
        
        // If both APIs failed, use fallback instances
        if (instances.length === 0) {
            console.log(`${TAG}: Using fallback instances`);
            instances = [
                "tube.tchncs.de",
                "video.blender.org", 
                "peertube.social",
                "framatube.org",
                "tube.arthack.nz",
                "peertube.linuxrocks.online",
                "peertube.debian.social",
                "tube.pol.social",
                "video.ploud.fr",
                "peertube.stream"
            ];
        }

        // Filter healthy instances if enabled
        if (settings.instanceHealthFilter && instances.length > 0) {
            instances = filterHealthyInstances(instances);
        }

        // Randomize and select instances
        const randomInstances = shuffleArray(instances)
            .slice(0, Math.min(settings.randomInstanceCount * 2, instances.length)) // Get more than needed
            .slice(0, settings.randomInstanceCount); // Then limit to actual need

        // Cache the results
        if (settings.cacheRandomInstances) {
            randomInstancesCache = randomInstances;
            lastInstanceFetch = Date.now();
        }

        console.log(`${TAG}: Selected ${randomInstances.length} random instances: ${randomInstances.join(", ")}`);
        return randomInstances;
        
    } catch (error) {
        console.log(`${TAG}: Error fetching random instances: ${error.message}`);
        return [];
    }
}

/**
 * Filter instances by health (basic connectivity check)
 */
function filterHealthyInstances(instances) {
    const healthyInstances = [];
    const maxChecks = Math.min(20, instances.length); // Don't check too many to avoid timeouts
    
    console.log(`${TAG}: Checking health of ${maxChecks} instances`);
    
    for (let i = 0; i < maxChecks && healthyInstances.length < 10; i++) {
        try {
            const instance = instances[i];
            const healthUrl = `https://${instance}/api/v1/server/stats`;
            
            // Quick health check with short timeout
            const response = http.GET(healthUrl, {}, false);
            if (response.code >= 200 && response.code < 400) {
                healthyInstances.push(instance);
                console.log(`${TAG}: Instance ${instance} is healthy`);
            }
        } catch (error) {
            // Silently skip unhealthy instances
            continue;
        }
    }
    
    console.log(`${TAG}: Found ${healthyInstances.length} healthy instances`);
    return healthyInstances.length > 0 ? healthyInstances : instances.slice(0, 10);
}

/**
 * Shuffle array using Fisher-Yates algorithm
 */
function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

/**
 * Get all configured instances including random ones
 */
function getAllInstances() {
    const settings = getSettings();
    const staticInstances = [settings.primaryInstance];
    staticInstances.push(...settings.additionalInstances);
    
    // Add random instances
    if (settings.enableRandomInstances) {
        const randomInstances = fetchRandomInstances();
        staticInstances.push(...randomInstances);
    }
    
    // Remove duplicates and filter out empty strings
    const uniqueInstances = staticInstances.filter((instance, index, self) => 
        instance && instance.trim() && self.indexOf(instance) === index
    );
    
    console.log(`${TAG}: Using ${uniqueInstances.length} total instances: ${uniqueInstances.join(", ")}`);
    return uniqueInstances;
}

/**
 * Make HTTP request with error handling
 */
function makeRequest(url, options = {}) {
    try {
        console.log(`${TAG}: Making request to ${url}`);
        const response = http.GET(url, options.headers || {}, options.useAuth || false);
        if (response.code >= 200 && response.code < 300) {
            return JSON.parse(response.body);
        } else {
            console.log(`${TAG}: Request failed with code ${response.code}: ${response.body}`);
            return null;
        }
    } catch (error) {
        console.log(`${TAG}: Request error: ${error.message}`);
        return null;
    }
}

/**
 * Convert PeerTube video to platform video object
 */
function convertToPlatformVideo(video, instance) {
    const baseUrl = `https://${instance}`;
    const videoUrl = video.url || `${baseUrl}/w/${video.uuid}`;
    
    // Handle remote videos by using local instance URL
    const playableUrl = videoUrl.startsWith(`https://${instance}`) ? 
        videoUrl : `${baseUrl}/w/${video.uuid}`;

    return new PlatformVideo({
        id: new PlatformID(PLATFORM, video.uuid, instance),
        name: video.name,
        thumbnails: new Thumbnails(video.thumbnailUrl ? [new Thumbnail(video.thumbnailUrl, 0)] : []),
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM, video.account.name, instance),
            video.account.displayName || video.account.name,
            `${baseUrl}/a/${video.account.name}`,
            video.account.avatar?.url ? `${baseUrl}${video.account.avatar.url}` : null
        ),
        uploadDate: Math.floor(new Date(video.publishedAt).getTime() / 1000),
        duration: video.duration || 0,
        viewCount: video.views || 0,
        url: playableUrl,
        isLive: video.isLive || false
    });
}

/**
 * Convert PeerTube channel to platform author
 */
function convertToPlatformAuthor(channel, instance) {
    const baseUrl = `https://${instance}`;
    return new PlatformAuthorLink(
        new PlatformID(PLATFORM, channel.name, instance),
        channel.displayName || channel.name,
        `${baseUrl}/c/${channel.name}`,
        channel.avatar?.url ? `${baseUrl}${channel.avatar.url}` : null,
        channel.followersCount || 0
    );
}

/**
 * Get video details from PeerTube API
 */
function getVideoDetails(url, instance) {
    const videoId = extractVideoId(url);
    if (!videoId) return null;

    const apiUrl = `https://${instance}/api/v1/videos/${videoId}`;
    const videoData = makeRequest(apiUrl);
    
    if (!videoData) return null;

    const streamingPlaylists = videoData.streamingPlaylists || [];
    const files = videoData.files || [];
    
    const videoSources = [];
    const audioSources = [];
    
    // Add HLS sources
    streamingPlaylists.forEach(playlist => {
        if (playlist.type === 1) { // HLS
            videoSources.push(new VideoUrlSource({
                url: playlist.playlistUrl,
                name: "HLS",
                container: "application/vnd.apple.mpegurl"
            }));
        }
    });
    
    // Add direct file sources
    files.forEach(file => {
        const quality = file.resolution?.label || `${file.resolution?.id}p` || "Unknown";
        videoSources.push(new VideoUrlSource({
            url: file.fileUrl,
            name: quality,
            container: file.extname || "mp4",
            bitrate: file.size
        }));
    });

    return new PlatformVideoDetails({
        id: new PlatformID(PLATFORM, videoData.uuid, instance),
        name: videoData.name,
        thumbnails: new Thumbnails([new Thumbnail(videoData.thumbnailUrl, 0)]),
        author: convertToPlatformAuthor(videoData.channel, instance),
        uploadDate: Math.floor(new Date(videoData.publishedAt).getTime() / 1000),
        duration: videoData.duration,
        viewCount: videoData.views,
        url: url,
        isLive: videoData.isLive,
        description: videoData.description,
        video: new VideoSourceDescriptor(videoSources),
        audio: new AudioSourceDescriptor(audioSources),
        live: videoData.isLive ? new HLSSource({
            name: "Live",
            url: streamingPlaylists.find(p => p.type === 1)?.playlistUrl
        }) : null
    });
}

/**
 * Extract video ID from various PeerTube URL formats
 */
function extractVideoId(url) {
    const patterns = [
        /\/w\/([a-f0-9-]+)/i,
        /\/videos\/watch\/([a-f0-9-]+)/i,
        /\/api\/v1\/videos\/([a-f0-9-]+)/i
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

/**
 * Build API query parameters
 */
function buildApiParams(params = {}) {
    const settings = getSettings();
    const apiParams = {
        start: params.start || 0,
        count: params.count || settings.contentMixRatio,
        sort: params.sort || "-publishedAt",
        nsfw: "both",
        ...params
    };

    // Add language filter
    if (settings.preferredLanguages.length > 0 && !settings.preferredLanguages.includes("all")) {
        apiParams.languageOneOf = settings.preferredLanguages.join(",");
    }

    // Add category filter
    if (settings.contentCategories.length > 0 && !settings.contentCategories.includes("all")) {
        const categoryIds = settings.contentCategories.map(cat => {
            const categoryId = Object.keys(CATEGORIES).find(id => CATEGORIES[id] === cat.toLowerCase());
            return categoryId;
        }).filter(id => id);
        
        if (categoryIds.length > 0) {
            apiParams.categoryOneOf = categoryIds.join(",");
        }
    }

    return new URLSearchParams(apiParams).toString();
}

/**
 * Fetch videos from multiple instances and mix them
 */
function fetchMixedVideos(params = {}) {
    const instances = getAllInstances();
    const settings = getSettings();
    let allVideos = [];

    // Calculate videos per instance to maintain diversity
    const videosPerInstance = Math.max(1, Math.floor(settings.contentMixRatio / Math.max(1, instances.length - 1)));
    
    instances.forEach((instance, index) => {
        try {
            // Use higher ratio for primary instance, lower for others
            const instanceVideoCount = index === 0 ? settings.contentMixRatio : videosPerInstance;
            
            const apiParams = buildApiParams({
                ...params,
                count: instanceVideoCount
            });
            
            const apiUrl = `https://${instance}/api/v1/videos?${apiParams}`;
            const response = makeRequest(apiUrl);
            
            if (response && response.data) {
                const videos = response.data.map(video => {
                    const platformVideo = convertToPlatformVideo(video, instance);
                    // Add instance info for debugging
                    platformVideo._sourceInstance = instance;
                    return platformVideo;
                });
                allVideos = allVideos.concat(videos);
                console.log(`${TAG}: Fetched ${videos.length} videos from ${instance}`);
            } else {
                console.log(`${TAG}: No data received from ${instance}`);
            }
        } catch (error) {
            console.log(`${TAG}: Failed to fetch from ${instance}: ${error.message}`);
        }
    });

    // Shuffle for maximum diversity - don't just sort by date
    allVideos = shuffleArray(allVideos);
    
    // Limit total results to avoid overwhelming the user
    const maxResults = Math.min(allVideos.length, 100);
    const finalVideos = allVideos.slice(0, maxResults);
    
    console.log(`${TAG}: Returning ${finalVideos.length} mixed videos from ${instances.length} instances`);
    return new VideoPager(finalVideos, allVideos.length > 0);
}

/**
 * Search across multiple instances
 */
function searchMixed(query, params = {}) {
    const instances = getAllInstances();
    let allResults = [];

    instances.forEach(instance => {
        try {
            const searchParams = buildApiParams({
                search: query,
                searchTarget: settings.showRemoteVideos ? "search-index" : "local",
                ...params
            });
            
            const apiUrl = `https://${instance}/api/v1/search/videos?${searchParams}`;
            const response = makeRequest(apiUrl);
            
            if (response && response.data) {
                const videos = response.data.map(video => convertToPlatformVideo(video, instance));
                allResults = allResults.concat(videos);
            }
        } catch (error) {
            console.log(`${TAG}: Search failed on ${instance}: ${error.message}`);
        }
    });

    return new VideoPager(allResults.sort(() => Math.random() - 0.5), false);
}

// Plugin Interface Implementation
source.enable = function(config) {
    settings = getSettings();
    console.log(`${TAG}: Enabled with ${getAllInstances().length} instances`);
};

source.getHome = function() {
    return fetchMixedVideos({ count: 20 });
};

source.searchSuggestions = function(query) {
    return [];
};

source.getSearchCapabilities = function() {
    return {
        types: [Type.Feed.Mixed],
        sorts: [Type.Order.Chronological, "Views", "Likes"],
        filters: []
    };
};

source.search = function(query, type, order, filters) {
    const sortMap = {
        [Type.Order.Chronological]: "-publishedAt",
        "Views": "-views", 
        "Likes": "-likes"
    };
    
    return searchMixed(query, { 
        sort: sortMap[order] || "-publishedAt",
        count: 50 
    });
};

source.getSearchChannelContentsCapabilities = function() {
    return {
        types: [Type.Feed.Mixed],
        sorts: [Type.Order.Chronological],
        filters: []
    };
};

source.searchChannelContents = function(channelUrl, query, type, order, filters) {
    const instance = extractInstanceFromUrl(channelUrl);
    const channelName = extractChannelNameFromUrl(channelUrl);
    
    if (!instance || !channelName) {
        return new VideoPager([], false);
    }

    const apiUrl = `https://${instance}/api/v1/video-channels/${channelName}/videos?${buildApiParams({ search: query })}`;
    const response = makeRequest(apiUrl);
    
    if (response && response.data) {
        const videos = response.data.map(video => convertToPlatformVideo(video, instance));
        return new VideoPager(videos, false);
    }
    
    return new VideoPager([], false);
};

source.isChannelUrl = function(url) {
    return /\/c\/|\/a\/|\/video-channels\//.test(url);
};

source.getChannel = function(url) {
    const instance = extractInstanceFromUrl(url);
    const channelName = extractChannelNameFromUrl(url);
    
    if (!instance || !channelName) return null;

    const apiUrl = `https://${instance}/api/v1/video-channels/${channelName}`;
    const channelData = makeRequest(apiUrl);
    
    if (!channelData) return null;

    return new PlatformChannel({
        id: new PlatformID(PLATFORM, channelData.name, instance),
        name: channelData.displayName || channelData.name,
        thumbnail: channelData.avatar?.url ? `https://${instance}${channelData.avatar.url}` : null,
        banner: channelData.banner?.url ? `https://${instance}${channelData.banner.url}` : null,
        subscribers: channelData.followersCount || 0,
        description: channelData.description,
        url: url,
        links: {}
    });
};

source.getChannelContents = function(url, type, order, filters) {
    const instance = extractInstanceFromUrl(url);
    const channelName = extractChannelNameFromUrl(url);
    
    if (!instance || !channelName) {
        return new VideoPager([], false);
    }

    const sortMap = {
        [Type.Order.Chronological]: "-publishedAt"
    };

    const apiUrl = `https://${instance}/api/v1/video-channels/${channelName}/videos?${buildApiParams({ sort: sortMap[order] || "-publishedAt" })}`;
    const response = makeRequest(apiUrl);
    
    if (response && response.data) {
        const videos = response.data.map(video => convertToPlatformVideo(video, instance));
        return new VideoPager(videos, response.data.length > 0);
    }
    
    return new VideoPager([], false);
};

source.isContentDetailsUrl = function(url) {
    return /\/w\/|\/videos\/watch\//.test(url);
};

source.getContentDetails = function(url) {
    const instance = extractInstanceFromUrl(url);
    if (!instance) {
        // Try primary instance if we can't determine instance
        return getVideoDetails(url, getSettings().primaryInstance);
    }
    return getVideoDetails(url, instance);
};

// Utility functions
function extractInstanceFromUrl(url) {
    try {
        const urlObj = new URL(url);
        return urlObj.hostname;
    } catch (e) {
        return null;
    }
}

function extractChannelNameFromUrl(url) {
    const patterns = [
        /\/c\/([^\/\?]+)/,
        /\/a\/([^\/\?]+)/,
        /\/video-channels\/([^\/\?]+)/
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

// Plugin info
console.log(`${TAG}: Enhanced PeerTube plugin loaded`);
