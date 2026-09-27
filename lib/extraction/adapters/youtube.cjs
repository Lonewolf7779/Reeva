// lib/extraction/adapters/youtube.cjs — YouTube Media Extraction Adapter
"use strict";

const { ValidationError } = require("../../url-validator.cjs");
const { SSRFError } = require("../../ssrf-filter.cjs");
const { withTimeout } = require("../strategies.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../types.cjs");

let ytdl_exec = null;
try {
    ytdl_exec = require("@distube/ytdl-core");
} catch (e) {
    // Module not available
}

/**
 * Extracts media from a YouTube URL.
 * Strategy: @distube/ytdl-core (Third-party library; non-cancellable promise. No secondary fallback currently available)
 *
 * @param {string} validatedUrl - HTTPS URL pre-validated against YouTube source domains
 * @param {object} [options] - Options (timeoutMs, requestId, provider, etc.)
 * @returns {Promise<{ url: string, type: 'video'|'image', title?: string }>}
 */
async function extractYouTube(validatedUrl, options = {}) {
    const timeoutMs = options.timeoutMs || 15000;
    const ytdlExecFn = options.provider !== undefined ? options.provider : ytdl_exec;

    if (!ytdlExecFn) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.UPSTREAM_UNAVAILABLE,
            "YouTube extraction module is currently unavailable."
        );
    }

    try {
        const op = typeof ytdlExecFn === "function"
            ? (ytdlExecFn.length >= 2 ? ({ signal }) => ytdlExecFn(validatedUrl, { signal }) : ytdlExecFn(validatedUrl))
            : (ytdlExecFn.getInfo ? ytdlExecFn.getInfo(validatedUrl) : ytdlExecFn);

        const info = await withTimeout(op, timeoutMs, "@distube/ytdl-core");
        if (!info || !info.formats || !Array.isArray(info.formats)) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
                "Could not retrieve video stream details from YouTube."
            );
        }

        const format =
            info.formats.find(f => f.hasVideo && f.hasAudio && f.container === "mp4") ||
            info.formats.find(f => f.hasVideo && f.container === "mp4") ||
            info.formats.find(f => f.mimeType && f.mimeType.includes("video"));

        if (!format || !format.url) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA,
                "No downloadable video format available for this YouTube video."
            );
        }

        return {
            url: format.url,
            type: "video",
            title: info.videoDetails?.title || "Reeva YouTube Video"
        };

    } catch (err) {
        if (err instanceof ValidationError || err instanceof SSRFError) {
            throw err;
        }
        if (err instanceof ExtractionError) {
            throw err;
        }
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "Could not retrieve media from YouTube.",
            { originalError: err.message }
        );
    }
}

module.exports = {
    extractYouTube
};
