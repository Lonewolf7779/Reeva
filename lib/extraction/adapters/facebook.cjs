// lib/extraction/adapters/facebook.cjs — Facebook Media Extraction Adapter
"use strict";

const { SUPPORTED_SOURCE_DOMAINS, ValidationError } = require("../../url-validator.cjs");
const { SSRFError } = require("../../ssrf-filter.cjs");
const { SecurityHTTPError, secureFetchHtml } = require("../../http-client.cjs");
const { extractFromMeta } = require("../strategies.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../types.cjs");

/**
 * Extracts media from a Facebook URL.
 * Strategy: Safe Reeva-controlled HTML metadata scraping via secureFetchHtml.
 * (@totallynodavid/downloader removed due to sending user URLs to an unverified third-party IP intermediary).
 *
 * @param {string} validatedUrl - HTTPS URL pre-validated against Facebook source domains
 * @param {object} [options] - Options (timeoutMs, requestId, fetchHtml, etc.)
 * @returns {Promise<{ url: string, type: 'video'|'image', title?: string }>}
 */
async function extractFacebook(validatedUrl, options = {}) {
    const fetchHtmlFn = options.fetchHtml || secureFetchHtml;

    try {
        const html = await fetchHtmlFn(validatedUrl, SUPPORTED_SOURCE_DOMAINS.facebook);
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
        "Could not retrieve media from this Facebook link. Ensure it is public."
    );
}

module.exports = {
    extractFacebook
};
