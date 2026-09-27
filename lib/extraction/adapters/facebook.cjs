// lib/extraction/adapters/facebook.cjs — Facebook Media Extraction Adapter
"use strict";

const { SUPPORTED_SOURCE_DOMAINS, ValidationError, validateMediaUrl } = require("../../url-validator.cjs");
const { SSRFError } = require("../../ssrf-filter.cjs");
const { SecurityHTTPError, secureFetchHtml, DEFAULT_MAX_HTML_BYTES } = require("../../http-client.cjs");
const { decodeUrl, extractFromMeta } = require("../strategies.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../types.cjs");

const FACEBOOK_MOBILE_USER_AGENT = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";

const FACEBOOK_REQUEST_HEADERS = Object.freeze({
    "User-Agent": FACEBOOK_MOBILE_USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1"
});

/**
 * Decodes HTML entity strings including decimal and hex entities.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeHtmlEntities(text) {
    if (!text || typeof text !== "string") return "";
    return text
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
            try { return String.fromCodePoint(parseInt(code, 16)); } catch { return _; }
        })
        .replace(/&#([0-9]+);/g, (_, code) => {
            try { return String.fromCodePoint(parseInt(code, 10)); } catch { return _; }
        });
}

/**
 * Extracts candidate video URL from Facebook HTML following the strict priority order:
 * 1. data-video-url attribute
 * 2. OpenGraph video meta tags (og:video, og:video:url, og:video:secure_url)
 * 3. Embedded Relay / state playable URLs (playable_url_quality_hd, playable_url)
 * 4. Browser-native video fields (browser_native_hd_url, browser_native_sd_url, hd_src, sd_src)
 *
 * @param {string} html
 * @returns {string|null} Unescaped candidate URL or null
 */
function extractFacebookVideoCandidate(html) {
    if (!html || typeof html !== "string") return null;

    // 1. data-video-url
    const dataVideoMatch = html.match(/data-video-url=["']([^"']+)["']/i);
    if (dataVideoMatch && dataVideoMatch[1]) {
        return decodeUrl(dataVideoMatch[1]);
    }

    // 2. OpenGraph video meta tags (order-independent)
    const ogVideo = extractFromMeta(html, [
        "og:video",
        "og:video:url",
        "og:video:secure_url"
    ]);
    if (ogVideo) {
        return ogVideo;
    }

    // 3. Embedded Relay / State: HD preferred, then SD
    const playableHdMatch = html.match(/["']?playable_url_quality_hd["']?\s*:\s*["']([^"']+)["']/i);
    if (playableHdMatch && playableHdMatch[1]) {
        return decodeUrl(playableHdMatch[1]);
    }

    const playableSdMatch = html.match(/["']?playable_url["']?\s*:\s*["']([^"']+)["']/i);
    if (playableSdMatch && playableSdMatch[1]) {
        return decodeUrl(playableSdMatch[1]);
    }

    // 4. Browser-native fields: HD preferred, then SD
    const nativeHdMatch = html.match(/["']?browser_native_hd_url["']?\s*:\s*["']([^"']+)["']/i);
    if (nativeHdMatch && nativeHdMatch[1]) {
        return decodeUrl(nativeHdMatch[1]);
    }

    const nativeSdMatch = html.match(/["']?browser_native_sd_url["']?\s*:\s*["']([^"']+)["']/i);
    if (nativeSdMatch && nativeSdMatch[1]) {
        return decodeUrl(nativeSdMatch[1]);
    }

    const hdSrcMatch = html.match(/["']?hd_src["']?\s*:\s*["']([^"']+)["']/i);
    if (hdSrcMatch && hdSrcMatch[1]) {
        return decodeUrl(hdSrcMatch[1]);
    }

    const sdSrcMatch = html.match(/["']?sd_src["']?\s*:\s*["']([^"']+)["']/i);
    if (sdSrcMatch && sdSrcMatch[1]) {
        return decodeUrl(sdSrcMatch[1]);
    }

    return null;
}

/**
 * Extracts post title from meta tags or title tag.
 *
 * @param {string} html
 * @returns {string|null}
 */
function extractFacebookTitle(html) {
    if (!html || typeof html !== "string") return null;

    const metaTitle = extractFromMeta(html, ["og:title", "twitter:title"]);
    if (metaTitle && metaTitle.trim()) {
        const decoded = decodeHtmlEntities(metaTitle).trim();
        if (!/^facebook\s*[–-]/i.test(decoded)) {
            return decoded.slice(0, 200);
        }
    }

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
        const titleText = decodeHtmlEntities(decodeUrl(titleMatch[1])).trim();
        if (
            !/^facebook\s*[–-]/i.test(titleText) &&
            !/^log in\b/i.test(titleText) &&
            !/^error facebook$/i.test(titleText)
        ) {
            return titleText.slice(0, 200);
        }
    }

    return null;
}

/**
 * Checks if HTML indicates a login wall, challenge, or auth barrier.
 *
 * @param {string} html
 * @returns {boolean}
 */
function isFacebookChallengeOrBarrier(html) {
    if (!html || typeof html !== "string") return false;

    if (
        html.includes("login_via/app") ||
        html.includes("login_form") ||
        html.includes("checkpoint") ||
        /<title>\s*Facebook\s*[–-]\s*log in or sign up/i.test(html) ||
        /<title>\s*Log In\s*\|\s*Facebook/i.test(html)
    ) {
        return true;
    }

    return false;
}

/**
 * Extracts media from a Facebook URL.
 * Strategy: Safe Reeva-controlled HTML metadata scraping via secureFetchHtml using
 * an isolated mobile browser request identity.
 *
 * @param {string} validatedUrl - HTTPS URL pre-validated against Facebook source domains
 * @param {object} [options] - Options (timeoutMs, requestId, fetchHtml, headers, etc.)
 * @returns {Promise<{ url: string, type: 'video'|'image', title?: string }>}
 */
async function extractFacebook(validatedUrl, options = {}) {
    const timeoutMs = options.timeoutMs || 10000;
    const fetchHtmlFn = options.fetchHtml || secureFetchHtml;
    const requestHeaders = options.headers || FACEBOOK_REQUEST_HEADERS;

    try {
        const html = await fetchHtmlFn(
            validatedUrl,
            SUPPORTED_SOURCE_DOMAINS.facebook,
            DEFAULT_MAX_HTML_BYTES,
            {
                headers: requestHeaders,
                timeoutMs
            }
        );

        if (html && typeof html === "string" && html.trim().length > 0) {
            const candidateUrl = extractFacebookVideoCandidate(html);
            const title = extractFacebookTitle(html) || "Facebook Video";

            if (candidateUrl) {
                // Must validate candidate URL against media allowlist
                validateMediaUrl(candidateUrl);
                return {
                    url: candidateUrl,
                    type: "video",
                    title
                };
            }

            // Video-first enforcement: if no video candidate found, inspect for challenge barrier
            if (isFacebookChallengeOrBarrier(html)) {
                throw new ExtractionError(
                    EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE,
                    "Facebook presented a login or challenge barrier for this content. Ensure the video is public.",
                    { statusCode: 403, isChallenge: true }
                );
            }
        }
    } catch (err) {
        // SECURITY VIOLATIONS: Halt immediately — NEVER fallback on security policy violation
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

        // Map HTTP status codes from secureFetchHtml
        if (err.statusCode === 401 || err.statusCode === 403 || err.statusCode === 429) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE,
                "Facebook returned an authentication challenge or access restriction for this post.",
                { statusCode: 403, originalStatus: err.statusCode }
            );
        } else if (err.statusCode === 404) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
                "The requested Facebook video was not found.",
                { statusCode: 404 }
            );
        } else if (err.code === "TIMEOUT" || err.statusCode === 504) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT,
                "Request timed out while contacting Facebook.",
                { timeoutMs }
            );
        } else if (err instanceof ExtractionError) {
            throw err;
        }

        // Generic error
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            "Could not retrieve media from this Facebook link. Ensure it is public.",
            { originalError: err.message }
        );
    }

    throw new ExtractionError(
        EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
        "Could not retrieve media from this Facebook link. Ensure it is public."
    );
}

module.exports = {
    extractFacebook,
    extractFacebookVideoCandidate,
    extractFacebookTitle,
    isFacebookChallengeOrBarrier,
    FACEBOOK_MOBILE_USER_AGENT,
    FACEBOOK_REQUEST_HEADERS
};
