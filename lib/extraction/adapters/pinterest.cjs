// lib/extraction/adapters/pinterest.cjs — Pinterest Media Extraction Adapter
"use strict";

const { SUPPORTED_SOURCE_DOMAINS, ValidationError, validateSourceUrl } = require("../../url-validator.cjs");
const { SSRFError } = require("../../ssrf-filter.cjs");
const { SecurityHTTPError, secureFetch, secureFetchHtml } = require("../../http-client.cjs");
const { withTimeout, extractMediaFromHtml } = require("../strategies.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../types.cjs");

let pinterestDl = null;
try {
    pinterestDl = require("pinterest-dl");
} catch (e) {
    // Module not available
}

/**
 * Extracts media from a Pinterest URL or pin.it short link.
 * Strategy 1 (Primary): pinterest-dl
 * Strategy 2 (Fallback): secureFetchHtml + HTML meta/regex parsing
 *
 * @param {string} validatedUrl - HTTPS URL pre-validated against Pinterest source domains
 * @param {object} [options] - Options (timeoutMs, requestId, etc.)
 * @returns {Promise<{ url: string, type: 'video'|'image', title?: string }>}
 */
async function extractPinterest(validatedUrl, options = {}) {
    const timeoutMs = options.timeoutMs || 10000;
    let targetUrl = validatedUrl;

    // Securely resolve pin.it short links
    const parsed = new URL(targetUrl);
    if (parsed.hostname === "pin.it" || parsed.hostname.endsWith(".pin.it")) {
        try {
            const { finalUrl, clearTimeout: clearTimer } = await secureFetch(targetUrl, {
                allowedDomains: SUPPORTED_SOURCE_DOMAINS.pinterest,
                maxRedirects: 3,
                timeoutMs: 8000
            });
            clearTimer();
            targetUrl = validateSourceUrl(finalUrl, "pinterest");
        } catch (e) {
            if (e instanceof ValidationError || e instanceof SSRFError || e instanceof SecurityHTTPError) {
                throw e;
            }
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                "Could not resolve Pinterest short link."
            );
        }
    }

    let primaryError = null;

    // 1. Primary Strategy: pinterest-dl
    if (pinterestDl) {
        try {
            const result = await withTimeout(pinterestDl(targetUrl), timeoutMs, "pinterest-dl");
            const pin = result?.url || (Array.isArray(result) && result[0]?.url);
            if (pin) {
                return {
                    url: pin,
                    type: pin.includes(".mp4") ? "video" : "image",
                    title: "Pinterest Media"
                };
            }
        } catch (err) {
            if (err instanceof ValidationError || err instanceof SSRFError || err instanceof SecurityHTTPError) {
                throw err;
            }
            primaryError = err;
        }
    }

    // 2. Fallback Strategy: HTML scraping via secureFetchHtml
    try {
        const html = await secureFetchHtml(targetUrl, SUPPORTED_SOURCE_DOMAINS.pinterest);
        const extracted = extractMediaFromHtml(html);
        if (extracted && extracted.url) {
            return {
                url: extracted.url,
                type: extracted.type || "image",
                title: "Pinterest Media"
            };
        }
    } catch (err) {
        if (err instanceof ValidationError || err instanceof SSRFError || err instanceof SecurityHTTPError) {
            throw err;
        }
    }

    throw new ExtractionError(
        EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
        "Could not find media for this Pinterest link. Ensure it is public.",
        { originalError: primaryError?.message }
    );
}

module.exports = {
    extractPinterest
};
