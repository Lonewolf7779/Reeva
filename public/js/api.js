// public/js/api.js — Frontend API Client and Contract Adapter
"use strict";

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.Reeva = root.Reeva || {};
        root.Reeva.api = factory();
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {

    /**
     * Validates whether a media URL conforms strictly to the canonical Reeva media path contract.
     * Accepts exclusively:
     *   /api/media/<valid-media-id>
     *   /api/media/<valid-media-id>?download=1
     * where media ID matches ^[a-zA-Z0-9_-]{8,64}$
     *
     * Rejects traversal, extra path segments, arbitrary query parameters, fragments,
     * control characters, newlines, whitespace, protocol-relative, absolute URLs, and dangerous schemes.
     *
     * @param {string} url
     * @returns {boolean}
     */
    function isValidMediaUrl(url) {
        if (!url || typeof url !== "string") return false;

        // Reject whitespace, newlines, control characters, or hash fragments anywhere in the URL
        if (/[\s\x00-\x1F\x7F-\x9F#]/.test(url)) return false;

        // Strictly accept only /api/media/<valid-media-id> or /api/media/<valid-media-id>?download=1
        // where media ID is 8 to 64 chars matching ^[a-zA-Z0-9_-]{8,64}$
        return /^\/api\/media\/[a-zA-Z0-9_-]{8,64}(\?download=1)?$/.test(url);
    }

    /**
     * Constructs the extraction endpoint URL for a given platform and source URL.
     * Preserves exact backend route: /api/download/:platform?url=<encoded URL>
     *
     * @param {string} platform
     * @param {string} rawUrl
     * @returns {string}
     */
    function buildDownloadUrl(platform, rawUrl) {
        if (!platform || typeof platform !== "string") {
            throw new Error("Platform identifier is required.");
        }
        if (!rawUrl || typeof rawUrl !== "string") {
            throw new Error("Source URL is required.");
        }
        return `/api/download/${encodeURIComponent(platform.trim())}?url=${encodeURIComponent(rawUrl.trim())}`;
    }

    /**
     * Constructs the embed endpoint URL for a given platform and source URL.
     * Preserves exact backend route: /api/embed/:platform?url=<encoded URL>
     *
     * @param {string} platform
     * @param {string} rawUrl
     * @returns {string}
     */
    function buildEmbedUrl(platform, rawUrl) {
        if (!platform || typeof platform !== "string") {
            throw new Error("Platform identifier is required.");
        }
        if (!rawUrl || typeof rawUrl !== "string") {
            throw new Error("Source URL is required.");
        }
        return `/api/embed/${encodeURIComponent(platform.trim())}?url=${encodeURIComponent(rawUrl.trim())}`;
    }

    /**
     * Validates whether an embed URL matches approved provider embed domains and patterns.
     * Restricts to exact trusted providers:
     *   tiktok: https://www.tiktok.com/embed/v2/<id>
     *   instagram: https://www.instagram.com/p/<shortcode>/embed/
     *   facebook: https://www.facebook.com/plugins/video.php?href=...
     *
     * Rejects javascript:, data:, blob:, unknown protocols, credentials, and untrusted hosts.
     *
     * @param {string} platform
     * @param {string} url
     * @returns {boolean}
     */
    function isValidEmbedUrl(platform, url) {
        if (!platform || typeof platform !== "string" || !url || typeof url !== "string") return false;
        if (/[\s\x00-\x1F\x7F-\x9F]/.test(url)) return false;

        const p = platform.trim().toLowerCase();
        if (p === "tiktok") {
            return /^https:\/\/(www\.)?tiktok\.com\/embed\/v2\/[a-zA-Z0-9_-]+$/.test(url);
        }
        if (p === "instagram") {
            return /^https:\/\/(www\.)?instagram\.com\/p\/[a-zA-Z0-9_-]+\/embed\/?$/.test(url);
        }
        if (p === "facebook") {
            return /^https:\/\/(www\.)?facebook\.com\/plugins\/video\.php\?href=[^&]+&show_text=false&width=\d+$/.test(url);
        }
        return false;
    }

    /**
     * Executes extraction request against Reeva API, validates media URLs, and normalizes response.
     * Supports AbortController cancellation via options.signal.
     *
     * @param {string} platform
     * @param {string} rawUrl
     * @param {object} [options={}]
     * @param {typeof fetch} [options.fetchFn]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<{ success: boolean, streamUrl?: string, downloadUrl?: string, code?: string, message?: string }>}
     */
    async function fetchMedia(platform, rawUrl, options = {}) {
        const fetchFn = options.fetchFn || (typeof fetch !== "undefined" ? fetch : null);
        if (!fetchFn) {
            return {
                success: false,
                code: "FETCH_UNAVAILABLE",
                message: "HTTP fetch client is not available."
            };
        }

        try {
            const endpoint = buildDownloadUrl(platform, rawUrl);
            const fetchOpts = {
                headers: { "Accept": "application/json" }
            };
            if (options.signal) {
                fetchOpts.signal = options.signal;
            }

            const resp = await fetchFn(endpoint, fetchOpts);

            let data;
            try {
                data = await resp.json();
            } catch (_) {
                return {
                    success: false,
                    code: "INVALID_JSON_RESPONSE",
                    message: "The server returned an invalid response format."
                };
            }

            if (!resp.ok) {
                const errMsg = (data && data.error && data.error.message) ||
                               (data && data.error) ||
                               "Failed to retrieve media. Please try again.";
                const errCode = (data && data.error && data.error.code) || "EXTRACTION_FAILED";

                return {
                    success: false,
                    code: errCode,
                    message: typeof errMsg === "string" ? errMsg : "Failed to retrieve media. Please try again."
                };
            }

            // Preserves existing contract: streamUrl with videoUrl fallback
            const streamUrl = data.streamUrl || data.videoUrl;
            const downloadUrl = data.downloadUrl || streamUrl;

            if (!streamUrl) {
                return {
                    success: false,
                    code: "NO_STREAM_URL",
                    message: "Could not find a downloadable video for this link."
                };
            }

            // Media URL security validation: both streamUrl and downloadUrl must strictly be valid canonical media URLs
            if (!isValidMediaUrl(streamUrl) || !isValidMediaUrl(downloadUrl)) {
                return {
                    success: false,
                    code: "UNSAFE_MEDIA_URL",
                    message: "Received invalid or unsafe media stream reference."
                };
            }

            return {
                success: true,
                streamUrl,
                downloadUrl
            };

        } catch (err) {
            if (err && (err.name === "AbortError" || err.code === 20)) {
                return {
                    success: false,
                    code: "ABORTED",
                    message: "Request was cancelled."
                };
            }

            return {
                success: false,
                code: "NETWORK_ERROR",
                message: err && err.message ? err.message : "A network error occurred."
            };
        }
    }

    /**
     * Executes embed resolution request against Reeva official embed endpoint.
     * Validates provider embed URL structure against approved provider whitelist.
     *
     * @param {string} platform
     * @param {string} rawUrl
     * @param {object} [options={}]
     * @param {typeof fetch} [options.fetchFn]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<{ success: boolean, embed?: object, code?: string, message?: string }>}
     */
    async function fetchEmbed(platform, rawUrl, options = {}) {
        const fetchFn = options.fetchFn || (typeof fetch !== "undefined" ? fetch : null);
        if (!fetchFn) {
            return {
                success: false,
                code: "FETCH_UNAVAILABLE",
                message: "HTTP fetch client is not available."
            };
        }

        try {
            const endpoint = buildEmbedUrl(platform, rawUrl);
            const fetchOpts = {
                headers: { "Accept": "application/json" }
            };
            if (options.signal) {
                fetchOpts.signal = options.signal;
            }

            const resp = await fetchFn(endpoint, fetchOpts);

            let data;
            try {
                data = await resp.json();
            } catch (_) {
                return {
                    success: false,
                    code: "INVALID_JSON_RESPONSE",
                    message: "The server returned an invalid response format."
                };
            }

            if (!resp.ok) {
                const errMsg = (data && data.error && data.error.message) ||
                               (data && data.error) ||
                               "Failed to resolve official embed.";
                const errCode = (data && data.error && data.error.code) || "EMBED_ERROR";

                return {
                    success: false,
                    code: errCode,
                    message: typeof errMsg === "string" ? errMsg : "Failed to resolve official embed."
                };
            }

            const embed = data && data.embed;
            if (!embed || !embed.embedUrl) {
                return {
                    success: false,
                    code: "NO_EMBED_URL",
                    message: "Official player is not available for this link."
                };
            }

            // Provider URL validation
            if (!isValidEmbedUrl(embed.platform || platform, embed.embedUrl)) {
                return {
                    success: false,
                    code: "UNSAFE_EMBED_URL",
                    message: "Received invalid or unsafe embed player reference."
                };
            }

            return {
                success: true,
                embed
            };

        } catch (err) {
            if (err && (err.name === "AbortError" || err.code === 20)) {
                return {
                    success: false,
                    code: "ABORTED",
                    message: "Request was cancelled."
                };
            }

            return {
                success: false,
                code: "NETWORK_ERROR",
                message: err && err.message ? err.message : "A network error occurred."
            };
        }
    }

    return {
        isValidMediaUrl,
        isValidEmbedUrl,
        buildDownloadUrl,
        buildEmbedUrl,
        fetchMedia,
        fetchEmbed
    };
});
