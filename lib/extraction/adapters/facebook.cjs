// lib/extraction/adapters/facebook.cjs — Facebook Media Extraction Adapter
"use strict";

const { SUPPORTED_SOURCE_DOMAINS, ValidationError } = require("../../url-validator.cjs");
const { SSRFError } = require("../../ssrf-filter.cjs");
const { SecurityHTTPError, secureFetchHtml } = require("../../http-client.cjs");
const { withTimeout, extractFromMeta } = require("../strategies.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../types.cjs");

let universalDownloader = null;
try {
    universalDownloader = require("@totallynodavid/downloader");
} catch (e) {
    // Module not available
}

/**
 * Extracts media from a Facebook URL.
 * Strategy 1 (Primary): @totallynodavid/downloader
 * Strategy 2 (Fallback): secureFetchHtml + meta tag extraction
 *
 * @param {string} validatedUrl - HTTPS URL pre-validated against Facebook source domains
 * @param {object} [options] - Options (timeoutMs, requestId, etc.)
 * @returns {Promise<{ url: string, type: 'video'|'image', title?: string }>}
 */
async function extractFacebook(validatedUrl, options = {}) {
    const timeoutMs = options.timeoutMs || 10000;
    let primaryError = null;

    // 1. Primary Strategy
    if (universalDownloader) {
        try {
            const out = await withTimeout(universalDownloader(validatedUrl), timeoutMs, "@totallynodavid/downloader");
            const vid = out?.url || out?.video || out?.downloadUrl;
            if (vid) {
                return {
                    url: vid,
                    type: "video",
                    title: "Facebook Video"
                };
            }
        } catch (err) {
            if (err instanceof ValidationError || err instanceof SSRFError || err instanceof SecurityHTTPError) {
                throw err;
            }
            primaryError = err;
        }
    }

    // 2. Fallback Strategy: HTML meta tags
    try {
        const html = await secureFetchHtml(validatedUrl, SUPPORTED_SOURCE_DOMAINS.facebook);
        const meta = extractFromMeta(html);
        if (meta) {
            return {
                url: meta,
                type: "video",
                title: "Facebook Video"
            };
        }
    } catch (err) {
        if (err instanceof ValidationError || err instanceof SSRFError || err instanceof SecurityHTTPError) {
            throw err;
        }
    }

    throw new ExtractionError(
        EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
        "Could not retrieve media from this Facebook link. Ensure it is public.",
        { originalError: primaryError?.message }
    );
}

module.exports = {
    extractFacebook
};
