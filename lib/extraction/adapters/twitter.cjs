// lib/extraction/adapters/twitter.cjs — Native X / Twitter Syndication Extraction Adapter
"use strict";

const { validateMediaUrl, ValidationError } = require("../../url-validator.cjs");
const { SSRFError } = require("../../ssrf-filter.cjs");
const { SecurityHTTPError, secureFetchHtml, DEFAULT_MAX_HTML_BYTES } = require("../../http-client.cjs");
const { decodeUrl } = require("../strategies.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../types.cjs");

const TWITTER_SYNDICATION_HOST = "cdn.syndication.twimg.com";
const TWITTER_ALLOWED_DOMAINS = Object.freeze(["cdn.syndication.twimg.com", "twimg.com"]);

/**
 * Extracts numeric Tweet Snowflake ID strictly from a validated Twitter/X URL.
 * Supported formats:
 * - https://twitter.com/<user>/status/<id>
 * - https://x.com/<user>/status/<id>
 * - https://twitter.com/i/web/status/<id>
 *
 * Rejects arbitrary paths or non-status numeric URLs.
 *
 * @param {string} url - Validated Twitter/X URL
 * @returns {string|null} Tweet ID or null
 */
function extractTweetId(url) {
    if (!url || typeof url !== "string") return null;
    try {
        const parsed = new URL(url);
        const match = parsed.pathname.match(/^\/(?:[a-zA-Z0-9_]+|i\/web)\/status(?:es)?\/(\d+)(?:\/.*)?$/i);
        if (match && match[1]) {
            return match[1];
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * Computes syndication token according to the standard syndication formula:
 * ((Number(statusId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
 *
 * @param {string} statusId - Numeric tweet status ID
 * @returns {string} Calculated token
 */
function calculateSyndicationToken(statusId) {
    if (!statusId || (typeof statusId !== "string" && typeof statusId !== "number")) return "0";
    const num = Number(statusId);
    if (isNaN(num)) return "0";
    return ((num / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

/**
 * Selects candidate media from parsed syndication JSON.
 * Prioritizes video/animated_gif progressive MP4 variants (highest bitrate),
 * falling back to highest-resolution photo if no video exists.
 *
 * @param {object} data - Parsed tweet result object
 * @returns {{ url: string, type: 'video' | 'image' } | null}
 */
function extractSyndicationMediaCandidate(data) {
    if (!data || typeof data !== "object") return null;

    // 1. Inspect mediaDetails for video or animated_gif
    if (Array.isArray(data.mediaDetails) && data.mediaDetails.length > 0) {
        for (const item of data.mediaDetails) {
            if ((item.type === "video" || item.type === "animated_gif") && item.video_info && Array.isArray(item.video_info.variants)) {
                // Filter strictly for progressive video/mp4 variants (exclude HLS/m3u8)
                const mp4Variants = item.video_info.variants
                    .filter(v => v && v.content_type === "video/mp4" && typeof v.url === "string" && v.url.trim().length > 0)
                    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

                if (mp4Variants.length > 0) {
                    return {
                        url: decodeUrl(mp4Variants[0].url),
                        type: "video"
                    };
                }
            }
        }

        // 2. If no video/gif found, look for photos in mediaDetails
        for (const item of data.mediaDetails) {
            if (item.type === "photo" && typeof item.media_url_https === "string" && item.media_url_https.trim().length > 0) {
                return {
                    url: decodeUrl(item.media_url_https),
                    type: "image"
                };
            }
        }
    }

    // 3. Check data.photos fallback
    if (Array.isArray(data.photos) && data.photos.length > 0) {
        for (const photo of data.photos) {
            const photoUrl = photo.url || photo.media_url_https;
            if (typeof photoUrl === "string" && photoUrl.trim().length > 0) {
                return {
                    url: decodeUrl(photoUrl),
                    type: "image"
                };
            }
        }
    }

    return null;
}

/**
 * Safely derives display title from tweet text and/or author information.
 *
 * @param {object} data - Parsed tweet result object
 * @param {'video'|'image'} type - Media type
 * @returns {string} Safe title
 */
function extractTweetTitle(data, type) {
    if (!data || typeof data !== "object") return type === "video" ? "Twitter / X Video" : "Twitter / X Image";

    if (typeof data.text === "string" && data.text.trim()) {
        // Strip trailing t.co shortlinks
        const cleaned = data.text.replace(/https:\/\/t\.co\/[a-zA-Z0-9]+$/i, "").trim();
        if (cleaned) {
            return cleaned.slice(0, 200);
        }
    }

    if (data.user && typeof data.user.screen_name === "string") {
        return `Post by @${data.user.screen_name}`;
    }

    return type === "video" ? "Twitter / X Video" : "Twitter / X Image";
}

/**
 * Extracts media from a Twitter / X URL using the official public syndication endpoint.
 *
 * Flow:
 * source URL -> validated URL -> tweet ID extraction -> calculated token ->
 * cdn.syndication.twimg.com/tweet-result -> media candidate extraction ->
 * validateMediaUrl() -> normalized extraction result
 *
 * @param {string} validatedUrl - HTTPS URL pre-validated against Twitter source domains
 * @param {object} [options] - Options (timeoutMs, requestId, fetchHtml)
 * @returns {Promise<{ url: string, type: 'video'|'image', title: string }>}
 */
async function extractTwitter(validatedUrl, options = {}) {
    const timeoutMs = options.timeoutMs || 10000;
    const fetchHtmlFn = options.fetchHtml || secureFetchHtml;

    // 1. Extract tweet status ID strictly from validated source URL
    const statusId = extractTweetId(validatedUrl);
    if (!statusId) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            "Could not extract a valid tweet status ID from this URL."
        );
    }

    // 2. Primary request with calculated token
    const primaryToken = calculateSyndicationToken(statusId);
    const primarySyndicationUrl = `https://${TWITTER_SYNDICATION_HOST}/tweet-result?id=${statusId}&lang=en&token=${primaryToken}`;

    let jsonString = null;
    let primaryFailedRecoverable = false;

    try {
        jsonString = await fetchHtmlFn(
            primarySyndicationUrl,
            TWITTER_ALLOWED_DOMAINS,
            DEFAULT_MAX_HTML_BYTES,
            { timeoutMs }
        );
    } catch (err) {
        // Security violations MUST halt immediately — never fallback
        if (err instanceof ValidationError || err instanceof SSRFError) {
            throw err;
        }
        if (err instanceof SecurityHTTPError && (
            err.code === "DISALLOWED_DESTINATION" ||
            err.code === "FORBIDDEN_PROTOCOL" ||
            err.code === "CREDENTIALS_FORBIDDEN" ||
            err.code === "FORBIDDEN_PORT" ||
            err.code === "MALFORMED_URL" ||
            err.code === "TOO_MANY_REDIRECTS" ||
            err.code === "RESPONSE_TOO_LARGE"
        )) {
            throw err;
        }

        // Recoverable HTTP 404 (or 400) from syndication endpoint allows ONE fallback to token=0
        if (err.statusCode === 404 || err.statusCode === 400) {
            primaryFailedRecoverable = true;
        } else if (err.statusCode === 401 || err.statusCode === 403 || err.statusCode === 429) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE,
                "Twitter / X presented an authentication challenge or rate limit.",
                { statusCode: 403, originalStatus: err.statusCode }
            );
        } else if (err.code === "TIMEOUT" || err.statusCode === 504) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT,
                "Request timed out while contacting Twitter / X syndication upstream.",
                { timeoutMs }
            );
        } else {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                "Failed to retrieve tweet information from Twitter / X.",
                { originalError: err.message }
            );
        }
    }

    // If primary returned empty or whitespace or empty object `{}`
    if (!primaryFailedRecoverable && jsonString) {
        const trimmed = jsonString.trim();
        if (trimmed === "{}" || trimmed === "") {
            primaryFailedRecoverable = true;
        }
    }

    // Controlled fallback to token=0 only if primary failed in a recoverable way
    if (primaryFailedRecoverable) {
        const fallbackSyndicationUrl = `https://${TWITTER_SYNDICATION_HOST}/tweet-result?id=${statusId}&lang=en&token=0`;
        try {
            jsonString = await fetchHtmlFn(
                fallbackSyndicationUrl,
                TWITTER_ALLOWED_DOMAINS,
                DEFAULT_MAX_HTML_BYTES,
                { timeoutMs }
            );
        } catch (err) {
            if (err instanceof ValidationError || err instanceof SSRFError) throw err;
            if (err.statusCode === 404) {
                throw new ExtractionError(
                    EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
                    "The requested tweet was not found or is unavailable.",
                    { statusCode: 404 }
                );
            }
            if (err.statusCode === 401 || err.statusCode === 403 || err.statusCode === 429) {
                throw new ExtractionError(
                    EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE,
                    "Twitter / X presented an authentication challenge or rate limit.",
                    { statusCode: 403, originalStatus: err.statusCode }
                );
            }
            if (err.code === "TIMEOUT" || err.statusCode === 504) {
                throw new ExtractionError(
                    EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT,
                    "Request timed out while contacting Twitter / X syndication upstream.",
                    { timeoutMs }
                );
            }
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
                "Could not retrieve media from this tweet. Ensure it is public and available."
            );
        }
    }

    // Parse JSON
    let data;
    try {
        data = JSON.parse(jsonString);
    } catch {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
            "Failed to parse upstream Twitter / X syndication response."
        );
    }

    // Check tombstone / deleted / restricted
    if (data.tombstone || data.__typename === "TweetTombstone") {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            "This tweet is unavailable, deleted, or restricted.",
            { isTombstone: true }
        );
    }

    // Check empty payload
    if (Object.keys(data).length === 0) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            "No tweet data found for this status ID."
        );
    }

    // Extract media candidate
    const candidate = extractSyndicationMediaCandidate(data);
    if (!candidate || !candidate.url) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            "No downloadable video or image was found in this tweet."
        );
    }

    // Security validation of candidate URL: must pass Reeva's media allowlist and protocol checks
    validateMediaUrl(candidate.url);

    const title = extractTweetTitle(data, candidate.type);

    return {
        url: candidate.url,
        type: candidate.type,
        title
    };
}

module.exports = {
    extractTwitter,
    extractTweetId,
    calculateSyndicationToken,
    extractSyndicationMediaCandidate,
    extractTweetTitle,
    TWITTER_SYNDICATION_HOST,
    TWITTER_ALLOWED_DOMAINS
};
