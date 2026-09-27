// lib/extraction/adapters/twitter.cjs — Twitter / X Media Extraction Adapter
"use strict";

const { ValidationError } = require("../../url-validator.cjs");
const { SSRFError } = require("../../ssrf-filter.cjs");
const { withTimeout } = require("../strategies.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../types.cjs");

let twitterDownloader = null;
try {
    twitterDownloader = require("twitter-downloader");
} catch (e) {
    // Module not available
}

/**
 * Extracts media from a Twitter / X URL.
 * Strategy: twitter-downloader (No secondary fallback currently available)
 *
 * @param {string} validatedUrl - HTTPS URL pre-validated against Twitter source domains
 * @param {object} [options] - Options (timeoutMs, requestId, etc.)
 * @returns {Promise<{ url: string, type: 'video'|'image', title?: string }>}
 */
async function extractTwitter(validatedUrl, options = {}) {
    const timeoutMs = options.timeoutMs || 10000;

    if (!twitterDownloader) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.UPSTREAM_UNAVAILABLE,
            "Twitter extraction module is currently unavailable."
        );
    }

    try {
        const result = await withTimeout(twitterDownloader(validatedUrl), timeoutMs, "twitter-downloader");
        const vid = result?.download?.[0]?.url || result?.url;
        if (vid) {
            return {
                url: vid,
                type: "video",
                title: "Twitter / X Video"
            };
        }
    } catch (err) {
        if (err instanceof ValidationError || err instanceof SSRFError) {
            throw err;
        }
        if (err instanceof ExtractionError) {
            throw err;
        }
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "Could not retrieve media from this tweet. Ensure it is public and contains a video.",
            { originalError: err.message }
        );
    }

    throw new ExtractionError(
        EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
        "Could not retrieve media from this tweet. Ensure it is public and contains a video."
    );
}

module.exports = {
    extractTwitter
};
