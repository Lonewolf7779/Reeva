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
 * Strategy 1 (Primary): instagram-url-direct (Third-party library; non-cancellable promise)
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

    // 1. Primary Strategy: Third-party library
    if (directProvider) {
        try {
            // Distinguish between cancellable operation taking ({ signal }) vs direct function/promise
            const op = typeof directProvider === "function"
                ? (directProvider.length >= 2 ? ({ signal }) => directProvider(validatedUrl, { signal }) : directProvider(validatedUrl))
                : directProvider;

            const result = await withTimeout(op, timeoutMs, "instagram-url-direct");
            if (result && result.url) {
                return {
                    url: result.url,
                    type: "video",
                    title: "Instagram Video"
                };
            }
            if (result && Array.isArray(result.results) && result.results.length > 0 && result.results[0].url) {
                return {
                    url: result.results[0].url,
                    type: "video",
                    title: "Instagram Video"
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
