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
                downloadUrl,
                media: data.media || null,
                items: Array.isArray(data.items) ? data.items : null,
                itemCount: typeof data.itemCount === "number" ? data.itemCount : (Array.isArray(data.items) ? data.items.length : 0)
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

    // =========================================================================
    // Phase 2B Media Workspace API Client
    // =========================================================================
    const ALLOWED_MEDIA_OPERATIONS = Object.freeze([
        "compress",
        "convert",
        "extract_audio",
        "trim",
        "resize"
    ]);

    function isValidJobId(jobId) {
        return typeof jobId === "string" && /^job_[a-f0-9]{32}$/.test(jobId);
    }

    /**
     * Validates and constructs an allowlisted Phase 2B processing profile object.
     *
     * @param {string} operation
     * @param {object} [rawOptions={}]
     * @returns {{ ok: boolean, profile?: object, message?: string }}
     */
    function buildMediaProfile(operation, rawOptions = {}) {
        const op = typeof operation === "string" ? operation.trim().toLowerCase() : "";
        if (!ALLOWED_MEDIA_OPERATIONS.includes(op)) {
            return { ok: false, message: "Please select a supported media operation." };
        }

        const opts = rawOptions && typeof rawOptions === "object" ? rawOptions : {};

        if (op === "compress") {
            const preset = typeof opts.preset === "string" ? opts.preset.trim().toLowerCase() : "balanced";
            if (!["compact", "balanced", "high_quality"].includes(preset)) {
                return { ok: false, message: "Invalid compression preset selected." };
            }
            return { ok: true, profile: { operation: "compress", options: { preset } } };
        }

        if (op === "convert") {
            const format = typeof opts.format === "string" ? opts.format.trim().toLowerCase() : "mp4";
            if (!["mp4", "webm", "mov"].includes(format)) {
                return { ok: false, message: "Invalid conversion target format." };
            }
            return { ok: true, profile: { operation: "convert", options: { format, remux: Boolean(opts.remux) } } };
        }

        if (op === "extract_audio") {
            const format = typeof opts.format === "string" ? opts.format.trim().toLowerCase() : "mp3";
            if (!["mp3", "aac", "opus", "wav"].includes(format)) {
                return { ok: false, message: "Invalid audio format selected." };
            }
            const options = { format };
            if (format !== "wav" && typeof opts.bitrate === "string" && opts.bitrate.trim()) {
                options.bitrate = opts.bitrate.trim().toLowerCase();
            }
            return { ok: true, profile: { operation: "extract_audio", options } };
        }

        if (op === "trim") {
            const startSeconds = Number(opts.startSeconds ?? 0);
            const endSeconds = Number(opts.endSeconds);
            if (!Number.isFinite(startSeconds) || startSeconds < 0) {
                return { ok: false, message: "Start time must be 0 or greater." };
            }
            if (!Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
                return { ok: false, message: "End time must be greater than start time." };
            }
            if ((endSeconds - startSeconds) > 1800) {
                return { ok: false, message: "Trim duration cannot exceed 30 minutes (1800s)." };
            }
            const mode = typeof opts.mode === "string" && ["fast_copy", "accurate"].includes(opts.mode.trim().toLowerCase())
                ? opts.mode.trim().toLowerCase()
                : "fast_copy";
            return { ok: true, profile: { operation: "trim", options: { startSeconds, endSeconds, mode } } };
        }

        // resize
        const preset = typeof opts.preset === "string" ? opts.preset.trim().toLowerCase() : "portrait_1080x1920";
        if (!["portrait_1080x1920", "square_1080x1080", "landscape_1920x1080", "hd_1280x720", "sd_854x480"].includes(preset)) {
            return { ok: false, message: "Invalid resize resolution preset." };
        }
        const fit = typeof opts.fit === "string" && ["contain", "cover"].includes(opts.fit.trim().toLowerCase())
            ? opts.fit.trim().toLowerCase()
            : "contain";
        return { ok: true, profile: { operation: "resize", options: { preset, fit } } };
    }

    /**
     * Submits a multipart media processing job to POST /api/media/jobs.
     * Supports XHR upload progress events when available, falling back to fetch.
     */
    async function submitMediaJob({ file, profile, onProgress, signal, fetchFn, xhrFactory } = {}) {
        if (!file) {
            return { success: false, code: "MISSING_FILE", message: "Please select a media file first." };
        }
        if (!profile || typeof profile !== "object") {
            return { success: false, code: "INVALID_PROFILE", message: "Invalid processing profile." };
        }

        const FormDataCtor = typeof FormData !== "undefined" ? FormData : null;
        if (!FormDataCtor) {
            return { success: false, code: "FORMDATA_UNAVAILABLE", message: "Multipart upload is not supported in this environment." };
        }

        const formData = new FormDataCtor();
        formData.append("profile", JSON.stringify(profile));
        formData.append("file", file);

        const XhrCtor = xhrFactory || (typeof XMLHttpRequest !== "undefined" ? XMLHttpRequest : null);
        if (XhrCtor && typeof onProgress === "function") {
            return new Promise((resolve) => {
                const xhr = new XhrCtor();
                let abortListener = null;

                const cleanupAbort = () => {
                    if (signal && abortListener) {
                        try { signal.removeEventListener("abort", abortListener); } catch (_) {}
                        abortListener = null;
                    }
                };

                if (signal) {
                    if (signal.aborted) {
                        return resolve({ success: false, code: "ABORTED", message: "Upload cancelled." });
                    }
                    abortListener = () => {
                        try { xhr.abort(); } catch (_) {}
                    };
                    signal.addEventListener("abort", abortListener, { once: true });
                }

                xhr.open("POST", "/api/media/jobs", true);
                xhr.setRequestHeader("Accept", "application/json");

                if (xhr.upload && typeof xhr.upload.addEventListener === "function") {
                    xhr.upload.addEventListener("progress", (evt) => {
                        if (evt && evt.lengthComputable && evt.total > 0) {
                            onProgress(Math.min(100, Math.round((evt.loaded / evt.total) * 100)));
                        }
                    });
                }

                xhr.onload = () => {
                    cleanupAbort();
                    let data = null;
                    try { data = JSON.parse(xhr.responseText || "{}"); } catch (_) {}

                    if (xhr.status < 200 || xhr.status >= 300) {
                        return resolve({
                            success: false,
                            statusCode: xhr.status,
                            code: (data && data.error && data.error.code) || "UPLOAD_FAILED",
                            message: (data && data.error && data.error.message) || "Failed to submit media processing job."
                        });
                    }

                    if (!data || !data.job || !isValidJobId(data.job.jobId) || typeof data.capabilityToken !== "string" || !data.capabilityToken) {
                        return resolve({
                            success: false,
                            code: "INVALID_RESPONSE",
                            message: "Server returned an invalid job response."
                        });
                    }

                    return resolve({
                        success: true,
                        job: data.job,
                        capabilityToken: data.capabilityToken
                    });
                };

                xhr.onerror = () => {
                    cleanupAbort();
                    resolve({ success: false, code: "NETWORK_ERROR", message: "Network error during upload." });
                };

                xhr.onabort = () => {
                    cleanupAbort();
                    resolve({ success: false, code: "ABORTED", message: "Upload cancelled." });
                };

                xhr.send(formData);
            });
        }

        const effectiveFetch = fetchFn || (typeof fetch !== "undefined" ? fetch : null);
        if (!effectiveFetch) {
            return { success: false, code: "FETCH_UNAVAILABLE", message: "HTTP client is not available." };
        }

        try {
            const opts = {
                method: "POST",
                headers: { "Accept": "application/json" },
                body: formData
            };
            if (signal) opts.signal = signal;
            const resp = await effectiveFetch("/api/media/jobs", opts);
            let data = null;
            try { data = await resp.json(); } catch (_) {}

            if (!resp.ok) {
                return {
                    success: false,
                    statusCode: resp.status,
                    code: (data && data.error && data.error.code) || "UPLOAD_FAILED",
                    message: (data && data.error && data.error.message) || "Failed to submit media processing job."
                };
            }

            if (!data || !data.job || !isValidJobId(data.job.jobId) || typeof data.capabilityToken !== "string" || !data.capabilityToken) {
                return { success: false, code: "INVALID_RESPONSE", message: "Server returned an invalid job response." };
            }

            if (typeof onProgress === "function") onProgress(100);
            return { success: true, job: data.job, capabilityToken: data.capabilityToken };
        } catch (err) {
            if (err && (err.name === "AbortError" || err.code === 20)) {
                return { success: false, code: "ABORTED", message: "Upload cancelled." };
            }
            return { success: false, code: "NETWORK_ERROR", message: "Network error during upload." };
        }
    }

    async function getMediaJobStatus(jobId, capabilityToken, options = {}) {
        if (!isValidJobId(jobId) || !capabilityToken) {
            return { success: false, code: "INVALID_JOB", message: "Invalid job credentials." };
        }
        const effectiveFetch = options.fetchFn || (typeof fetch !== "undefined" ? fetch : null);
        if (!effectiveFetch) {
            return { success: false, code: "FETCH_UNAVAILABLE", message: "HTTP client is not available." };
        }

        try {
            const fetchOpts = {
                headers: {
                    "Accept": "application/json",
                    "Authorization": `Bearer ${capabilityToken}`
                }
            };
            if (options.signal) fetchOpts.signal = options.signal;

            const resp = await effectiveFetch(`/api/media/jobs/${encodeURIComponent(jobId)}`, fetchOpts);
            let data = null;
            try { data = await resp.json(); } catch (_) {}

            if (!resp.ok) {
                return {
                    success: false,
                    statusCode: resp.status,
                    code: (data && data.error && data.error.code) || "STATUS_ERROR",
                    message: (data && data.error && data.error.message) || "Failed to check job status."
                };
            }

            if (!data || !data.job || !isValidJobId(data.job.jobId)) {
                return { success: false, code: "INVALID_RESPONSE", message: "Invalid job status payload." };
            }

            return { success: true, job: data.job };
        } catch (err) {
            if (err && (err.name === "AbortError" || err.code === 20)) {
                return { success: false, code: "ABORTED", message: "Status check cancelled." };
            }
            return { success: false, code: "NETWORK_ERROR", message: "Network error checking job status." };
        }
    }

    async function cancelMediaJob(jobId, capabilityToken, options = {}) {
        if (!isValidJobId(jobId) || !capabilityToken) {
            return { success: false, code: "INVALID_JOB", message: "Invalid job credentials." };
        }
        const effectiveFetch = options.fetchFn || (typeof fetch !== "undefined" ? fetch : null);
        if (!effectiveFetch) {
            return { success: false, code: "FETCH_UNAVAILABLE", message: "HTTP client is not available." };
        }

        try {
            const resp = await effectiveFetch(`/api/media/jobs/${encodeURIComponent(jobId)}/cancel`, {
                method: "POST",
                headers: {
                    "Accept": "application/json",
                    "Authorization": `Bearer ${capabilityToken}`
                }
            });
            let data = null;
            try { data = await resp.json(); } catch (_) {}

            if (!resp.ok) {
                return {
                    success: false,
                    statusCode: resp.status,
                    code: (data && data.error && data.error.code) || "CANCEL_ERROR",
                    message: (data && data.error && data.error.message) || "Failed to cancel job."
                };
            }

            return { success: true, job: data && data.job };
        } catch (_) {
            return { success: false, code: "NETWORK_ERROR", message: "Network error cancelling job." };
        }
    }

    async function fetchMediaJobOutputBlob(jobId, capabilityToken, options = {}) {
        if (!isValidJobId(jobId) || !capabilityToken) {
            return { success: false, code: "INVALID_JOB", message: "Invalid job credentials." };
        }
        const effectiveFetch = options.fetchFn || (typeof fetch !== "undefined" ? fetch : null);
        if (!effectiveFetch) {
            return { success: false, code: "FETCH_UNAVAILABLE", message: "HTTP client is not available." };
        }

        try {
            const fetchOpts = {
                headers: {
                    "Authorization": `Bearer ${capabilityToken}`
                }
            };
            if (options.signal) fetchOpts.signal = options.signal;

            const resp = await effectiveFetch(`/api/media/jobs/${encodeURIComponent(jobId)}/output?download=1`, fetchOpts);
            if (!resp.ok) {
                let data = null;
                try { data = await resp.json(); } catch (_) {}
                return {
                    success: false,
                    statusCode: resp.status,
                    code: (data && data.error && data.error.code) || (resp.status === 410 ? "MEDIA_EXPIRED" : "DOWNLOAD_FAILED"),
                    message: (data && data.error && data.error.message) || (resp.status === 410 ? "Processed media has expired." : "Failed to download processed output.")
                };
            }

            const blob = await resp.blob();
            const disp = resp.headers && typeof resp.headers.get === "function"
                ? (resp.headers.get("content-disposition") || "")
                : "";
            const match = disp.match(/filename="([^"]+)"/i);
            const filename = match ? match[1] : "reeva_processed_media";

            return { success: true, blob, filename };
        } catch (err) {
            if (err && (err.name === "AbortError" || err.code === 20)) {
                return { success: false, code: "ABORTED", message: "Download cancelled." };
            }
            return { success: false, code: "NETWORK_ERROR", message: "Network error downloading output." };
        }
    }

    return {
        isValidMediaUrl,
        isValidEmbedUrl,
        isValidJobId,
        buildDownloadUrl,
        buildEmbedUrl,
        fetchMedia,
        fetchEmbed,
        buildMediaProfile,
        submitMediaJob,
        getMediaJobStatus,
        cancelMediaJob,
        fetchMediaJobOutputBlob
    };
});
