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
     * Validates whether a media URL conform to safe relative or same-origin Reeva media paths.
     * Prevents dangerous schemes (javascript:, data:, file:) and arbitrary domain redirects.
     *
     * @param {string} url
     * @returns {boolean}
     */
    function isValidMediaUrl(url) {
        if (!url || typeof url !== "string") return false;
        const trimmed = url.trim();

        // Reject whitespace, newlines, control characters
        if (/[\s\x00-\x1F\x7F-\x9F]/.test(trimmed)) return false;

        // Reject dangerous protocol schemes
        if (/^(javascript|data|file|vbscript):/i.test(trimmed)) return false;

        // Standard Reeva media route: /api/media/:mediaId or /api/media/:mediaId?download=1
        if (/^\/api\/media\/[a-zA-Z0-9_\-]+(\?[a-zA-Z0-9_\-=&]*)?$/.test(trimmed)) {
            return true;
        }

        // Relative path starting with /api/media/
        if (trimmed.startsWith("/api/media/")) {
            return true;
        }

        // Absolute URL check against same origin (if running in browser)
        if (typeof window !== "undefined" && window.location && window.location.origin) {
            try {
                const parsed = new URL(trimmed, window.location.origin);
                if (parsed.origin === window.location.origin && parsed.pathname.startsWith("/api/media/")) {
                    return true;
                }
            } catch (_) {
                return false;
            }
        }

        return false;
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

            // Media URL security validation
            if (!isValidMediaUrl(streamUrl) || (downloadUrl && !isValidMediaUrl(downloadUrl))) {
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

    return {
        isValidMediaUrl,
        buildDownloadUrl,
        fetchMedia
    };
});
