// lib/extraction/adapters/instagram.cjs — Instagram Media Extraction Adapter
"use strict";

const { SUPPORTED_SOURCE_DOMAINS, ValidationError } = require("../../url-validator.cjs");
const { SSRFError } = require("../../ssrf-filter.cjs");
const { SecurityHTTPError, secureFetchHtml } = require("../../http-client.cjs");
const { withTimeout, extractMediaFromHtml } = require("../strategies.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../types.cjs");

let instagramDirect = null;
try {
    instagramDirect = require("instagram-url-direct");
} catch (e) {
    // Module not available in this environment
}

/**
 * Extracts media from an Instagram URL.
 * Strategy 1 (Primary): instagram-url-direct (calling verified instagramGetUrl)
 * Strategy 2 (Fallback): secureFetchHtml + HTML meta/regex parsing
 *
 * @param {string} validatedUrl - HTTPS URL pre-validated against Instagram source domains
 * @param {object} [options] - Options (timeoutMs, requestId, provider, fetchHtml, etc.)
 * @returns {Promise<{ url: string, type: 'video'|'image', title?: string }>}
 */
async function extractInstagram(validatedUrl, options = {}) {
    const timeoutMs = options.timeoutMs || 10000;
    const directProvider = options.provider !== undefined ? options.provider : instagramDirect;
    const fetchHtmlFn = options.fetchHtml || secureFetchHtml;
    let primaryError = null;

    // Resolve the actual provider function from module exports or options
    let directFn = null;
    if (typeof directProvider === "function") {
        directFn = directProvider;
    } else if (directProvider && typeof directProvider.instagramGetUrl === "function") {
        directFn = directProvider.instagramGetUrl;
    }

    // 1. Primary Strategy: Third-party library
    if (directFn) {
        try {
            const op = typeof directFn === "function"
                ? (directFn.length >= 2 ? ({ signal }) => directFn(validatedUrl, { signal }) : directFn(validatedUrl))
                : directFn;

            const result = await withTimeout(op, timeoutMs, "instagram-url-direct");

            // Extract candidate from verified provider output structure: media_details or url_list
            let candidateUrl = null;
            let candidateType = "video";

            if (result && Array.isArray(result.media_details) && result.media_details.length > 0) {
                const videoItem = result.media_details.find(m => m && m.type === "video" && typeof m.url === "string");
                const selected = videoItem || result.media_details.find(m => m && typeof m.url === "string");
                if (selected) {
                    candidateUrl = selected.url;
                    candidateType = selected.type === "image" ? "image" : "video";
                }
            } else if (result && Array.isArray(result.url_list) && result.url_list.length > 0) {
                const firstUrl = result.url_list.find(u => typeof u === "string" && u.trim().length > 0);
                if (firstUrl) {
                    candidateUrl = firstUrl;
                    candidateType = firstUrl.includes(".mp4") ? "video" : "image";
                }
            } else if (result && typeof result.url === "string" && result.url.trim().length > 0) {
                // Compatibility mapping for fixtures
                candidateUrl = result.url;
                candidateType = result.type === "image" ? "image" : "video";
            }

            if (candidateUrl) {
                const title = (result?.post_info && typeof result.post_info.caption === "string" && result.post_info.caption.trim())
                    ? result.post_info.caption.slice(0, 100)
                    : "Instagram Video";

                return {
                    url: candidateUrl,
                    type: candidateType,
                    title
                };
            }
        } catch (err) {
            // Security errors must halt execution immediately — NEVER fallback on security policy violation
            if (err instanceof ValidationError || err instanceof SSRFError || err instanceof SecurityHTTPError) {
                throw err;
            }
            primaryError = err;
        }
    }

    // 2. Fallback Strategy: Controlled HTML scraping via secureFetchHtml
    try {
        const html = await fetchHtmlFn(validatedUrl, SUPPORTED_SOURCE_DOMAINS.instagram);
        const extracted = extractMediaFromHtml(html);

        if (extracted && extracted.url) {
            return {
                url: extracted.url,
                type: extracted.type || "video",
                title: "Instagram Media"
            };
        }
    } catch (err) {
        if (err instanceof ValidationError || err instanceof SSRFError || err instanceof SecurityHTTPError) {
            throw err;
        }
        // Fallback error recorded
    }

    // If both primary and fallback failed to find media
    throw new ExtractionError(
        EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
        "Could not find downloadable media for this Instagram link. Ensure it is public and contains visible media.",
        { originalError: primaryError?.message }
    );
}

module.exports = {
    extractInstagram
};
