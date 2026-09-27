// lib/extraction/adapters/pinterest.cjs — Pinterest Media Extraction Adapter
"use strict";

const { SUPPORTED_SOURCE_DOMAINS, ValidationError, validateSourceUrl } = require("../../url-validator.cjs");
const { SSRFError } = require("../../ssrf-filter.cjs");
const { SecurityHTTPError, secureFetch, secureFetchHtml } = require("../../http-client.cjs");
const { extractMediaFromHtml } = require("../strategies.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../types.cjs");

/**
 * Extracts media from a Pinterest URL or pin.it short link.
 * Primary Strategy: Secure Reeva-controlled HTML metadata scraping via secureFetchHtml
 * (pinterest-dl dependency removed as it was an image keyword search tool, not a post downloader).
 *
 * @param {string} validatedUrl - HTTPS URL pre-validated against Pinterest source domains
 * @param {object} [options] - Options (timeoutMs, requestId, fetchHtml, etc.)
 * @returns {Promise<{ url: string, type: 'video'|'image', title?: string }>}
 */
async function extractPinterest(validatedUrl, options = {}) {
    const fetchHtmlFn = options.fetchHtml || secureFetchHtml;
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

    // Direct Reeva-controlled HTML metadata extraction
    try {
        const html = await fetchHtmlFn(targetUrl, SUPPORTED_SOURCE_DOMAINS.pinterest);
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
        "Could not find media for this Pinterest link. Ensure it is public."
    );
}

module.exports = {
    extractPinterest
};
