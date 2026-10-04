// lib/extraction/adapters/pinterest.cjs — Pinterest Media Extraction Adapter
"use strict";

const { SUPPORTED_SOURCE_DOMAINS, ValidationError, validateSourceUrl } = require("../../url-validator.cjs");
const { SSRFError } = require("../../ssrf-filter.cjs");
const { SecurityHTTPError, secureFetch, secureFetchHtml, DEFAULT_MAX_HTML_BYTES } = require("../../http-client.cjs");
const { extractMediaFromHtml, extractFromMeta, decodeUrl } = require("../strategies.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../types.cjs");

function decodeHtmlEntities(text) {
    if (!text || typeof text !== "string") return "";
    return text
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">");
}

function extractPinterestTitle(html) {
    if (!html || typeof html !== "string") return null;
    const metaTitle = extractFromMeta(html, ["og:title", "twitter:title"]);
    if (metaTitle && metaTitle.trim()) {
        const decoded = decodeHtmlEntities(decodeUrl(metaTitle)).trim();
        if (decoded && !/^pinterest\b/i.test(decoded)) {
            return decoded.slice(0, 200);
        }
    }
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
        const titleText = decodeHtmlEntities(decodeUrl(titleMatch[1])).trim();
        if (titleText && !/^pinterest\b/i.test(titleText)) {
            return titleText.slice(0, 200);
        }
    }
    return null;
}

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
    const timeoutMs = options.timeoutMs || 10000;
    const fetchHtmlFn = options.fetchHtml || secureFetchHtml;
    const fetchFn = options.fetch || secureFetch;
    let targetUrl = validatedUrl;

    // Securely resolve pin.it short links
    const parsed = new URL(targetUrl);
    if (parsed.hostname === "pin.it" || parsed.hostname.endsWith(".pin.it")) {
        try {
            const { finalUrl, clearTimeout: clearTimer } = await fetchFn(targetUrl, {
                allowedDomains: SUPPORTED_SOURCE_DOMAINS.pinterest,
                maxRedirects: 3,
                timeoutMs
            });
            if (typeof clearTimer === "function") clearTimer();
            targetUrl = validateSourceUrl(finalUrl, "pinterest");
        } catch (e) {
            if (
                e instanceof ValidationError ||
                e instanceof SSRFError ||
                (e instanceof SecurityHTTPError && (
                    e.code === "DISALLOWED_DESTINATION" ||
                    e.code === "FORBIDDEN_PROTOCOL" ||
                    e.code === "CREDENTIALS_FORBIDDEN" ||
                    e.code === "FORBIDDEN_PORT" ||
                    e.code === "MALFORMED_URL" ||
                    e.code === "TOO_MANY_REDIRECTS" ||
                    e.code === "RESPONSE_TOO_LARGE"
                ))
            ) {
                throw e;
            }

            if (e.statusCode === 401 || e.statusCode === 403 || e.statusCode === 429) {
                throw new ExtractionError(
                    EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE,
                    "Pinterest returned an authentication challenge or rate limit.",
                    { statusCode: 403, originalStatus: e.statusCode }
                );
            } else if (e.statusCode === 404) {
                throw new ExtractionError(
                    EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
                    "The requested Pinterest short link was not found.",
                    { statusCode: 404 }
                );
            } else if (e.code === "TIMEOUT" || e.statusCode === 504) {
                throw new ExtractionError(
                    EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT,
                    "Request timed out while resolving Pinterest short link.",
                    { timeoutMs }
                );
            }

            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                "Could not resolve Pinterest short link."
            );
        }
    }

    // Direct Reeva-controlled HTML metadata extraction
    try {
        const html = await fetchHtmlFn(
            targetUrl,
            SUPPORTED_SOURCE_DOMAINS.pinterest,
            DEFAULT_MAX_HTML_BYTES,
            { timeoutMs }
        );
        const extracted = extractMediaFromHtml(html);
        if (extracted && extracted.url) {
            const title = extractPinterestTitle(html) || "Pinterest Media";
            return {
                url: extracted.url,
                type: extracted.type || "image",
                title
            };
        }
    } catch (err) {
        if (
            err instanceof ValidationError ||
            err instanceof SSRFError ||
            (err instanceof SecurityHTTPError && (
                err.code === "DISALLOWED_DESTINATION" ||
                err.code === "FORBIDDEN_PROTOCOL" ||
                err.code === "CREDENTIALS_FORBIDDEN" ||
                err.code === "FORBIDDEN_PORT" ||
                err.code === "MALFORMED_URL" ||
                err.code === "TOO_MANY_REDIRECTS" ||
                err.code === "RESPONSE_TOO_LARGE"
            ))
        ) {
            throw err;
        }

        if (err.statusCode === 401 || err.statusCode === 403 || err.statusCode === 429) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE,
                "Pinterest returned an authentication challenge or access restriction for this post.",
                { statusCode: 403, originalStatus: err.statusCode }
            );
        } else if (err.statusCode === 404) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
                "The requested Pinterest content was not found.",
                { statusCode: 404 }
            );
        } else if (err.code === "TIMEOUT" || err.statusCode === 504) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT,
                "Request timed out while contacting Pinterest.",
                { timeoutMs }
            );
        } else if (err instanceof ExtractionError) {
            throw err;
        }

        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            "Could not find media for this Pinterest link. Ensure it is public.",
            { originalError: err.message }
        );
    }

    throw new ExtractionError(
        EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
        "Could not find media for this Pinterest link. Ensure it is public."
    );
}

module.exports = {
    extractPinterest,
    extractPinterestTitle
};
