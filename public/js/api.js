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
     * Executes extraction request against Reeva API and normalizes response.
     *
     * @param {string} platform
     * @param {string} rawUrl
     * @param {object} [options={}]
     * @param {typeof fetch} [options.fetchFn]
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
            const resp = await fetchFn(endpoint, {
                headers: { "Accept": "application/json" }
            });

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

            return {
                success: true,
                streamUrl,
                downloadUrl
            };

        } catch (err) {
            return {
                success: false,
                code: "NETWORK_ERROR",
                message: err && err.message ? err.message : "A network error occurred."
            };
        }
    }

    return {
        buildDownloadUrl,
        fetchMedia
    };
});
