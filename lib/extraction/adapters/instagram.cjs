// lib/extraction/adapters/instagram.cjs — Instagram Media Extraction Adapter
"use strict";

const { SUPPORTED_SOURCE_DOMAINS, ValidationError, validateMediaUrl } = require("../../url-validator.cjs");
const { SSRFError } = require("../../ssrf-filter.cjs");
const { SecurityHTTPError, secureFetch, secureFetchHtml, readStreamWithLimit, DEFAULT_MAX_HTML_BYTES } = require("../../http-client.cjs");
const { withTimeout, decodeUrl, extractFromMeta } = require("../strategies.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../types.cjs");

const INSTAGRAM_CRAWLER_USER_AGENT = "facebookexternalhit/1.1 (+https://www.facebook.com/externalhit_uatext.php)";
const INSTAGRAM_GRAPHQL_ENDPOINT = "https://www.instagram.com/graphql/query";
const INSTAGRAM_DOCUMENT_ID = "9510064595728286";
const MAX_GRAPHQL_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_CSRF_RESPONSE_BYTES = 512 * 1024; // 512 KB

/**
 * Extracts OpenGraph video URL from HTML supporting standard and reversed attribute orders.
 * Checks og:video, og:video:url, og:video:secure_url.
 *
 * @param {string} html
 * @returns {string|null}
 */
function extractInstagramVideo(html) {
    return extractFromMeta(html, [
        "og:video",
        "og:video:url",
        "og:video:secure_url"
    ]);
}

/**
 * Extracts OpenGraph image URL from HTML supporting standard and reversed attribute orders.
 * Checks og:image, og:image:url, og:image:secure_url.
 *
 * @param {string} html
 * @returns {string|null}
 */
function extractInstagramImage(html) {
    return extractFromMeta(html, [
        "og:image",
        "og:image:url",
        "og:image:secure_url"
    ]);
}

/**
 * Extracts video URL from embedded JSON scripts.
 *
 * @param {string} html
 * @returns {string|null}
 */
function extractEmbeddedVideo(html) {
    if (!html || typeof html !== "string") return null;

    const patterns = [
        /"video_versions":\[\{[^}]*"url":"([^"]+)"/i,
        /"video_url"\s*:\s*"([^"]+)"/i,
        /"url"\s*:\s*"([^"]+\.mp4[^"]*)"/i,
        /"src"\s*:\s*"([^"]+\.mp4[^"]*)"/i,
        /"contentUrl"\s*:\s*"([^"]+)"/i,
        /"playbackUrl"\s*:\s*"([^"]+)"/i
    ];

    for (const regex of patterns) {
        const match = html.match(regex);
        if (match && match[1]) {
            return decodeUrl(match[1]);
        }
    }
    return null;
}

/**
 * Extracts image URL from embedded JSON scripts.
 *
 * @param {string} html
 * @returns {string|null}
 */
function extractEmbeddedImage(html) {
    if (!html || typeof html !== "string") return null;

    const patterns = [
        /"display_resources":\[\{[^}]*"src":"([^"]+)"/i,
        /"display_url"\s*:\s*"([^"]+)"/i
    ];

    for (const regex of patterns) {
        const match = html.match(regex);
        if (match && match[1]) {
            return decodeUrl(match[1]);
        }
    }
    return null;
}

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
 * Extracts post title from meta tags or title tag.
 *
 * @param {string} html
 * @returns {string|null}
 */
function extractInstagramTitle(html) {
    if (!html || typeof html !== "string") return null;

    const metaTitle = extractFromMeta(html, ["og:title", "twitter:title"]);
    if (metaTitle && metaTitle.trim()) {
        return decodeHtmlEntities(metaTitle).trim().slice(0, 200);
    }

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
        const titleText = decodeHtmlEntities(decodeUrl(titleMatch[1])).trim();
        if (!/^login\b/i.test(titleText) && !/^instagram$/i.test(titleText)) {
            return titleText.slice(0, 200);
        }
    }

    return null;
}

/**
 * Determines whether a URL or HTML indicates the content is intended to be a video.
 *
 * @param {string} url
 * @param {string} [html]
 * @returns {boolean}
 */
function isVideoContent(url, html) {
    try {
        const parsed = new URL(url);
        const path = parsed.pathname.toLowerCase();
        if (path.includes("/reel/") || path.includes("/reels/") || path.includes("/tv/")) {
            return true;
        }
    } catch {
        // Pre-validated URL
    }

    if (html && typeof html === "string") {
        const ogType = extractFromMeta(html, ["og:type"]);
        if (ogType && (ogType.toLowerCase().includes("video") || ogType.toLowerCase().includes("instapp:video"))) {
            return true;
        }
    }

    return false;
}

/**
 * Checks if the HTML contains markers of an Instagram challenge, login wall, or empty auth shell.
 *
 * @param {string} html
 * @returns {boolean}
 */
function isChallengeOrAuthBarrier(html) {
    if (!html || typeof html !== "string") return false;

    if (
        html.includes("/accounts/login") ||
        html.includes("login_required") ||
        html.includes("checkpoint_required") ||
        html.includes('"is_challenge":true') ||
        html.includes("challenge_required") ||
        /<title>\s*Login\s*(?:•|&bull;|-|\|)\s*Instagram/i.test(html) ||
        (/<title>\s*Instagram\s*<\/title>/i.test(html) && !html.includes("og:video") && !html.includes("og:image"))
    ) {
        return true;
    }

    return false;
}

/**
 * Extracts Instagram shortcode from an Instagram URL.
 *
 * @param {string} rawUrl
 * @returns {string|null}
 */
function extractShortcode(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return null;
    try {
        const parsed = new URL(rawUrl);
        const match = parsed.pathname.match(/\/(?:p|reel|tv|reels)\/([a-zA-Z0-9_-]+)/i);
        if (match && match[1]) {
            return match[1];
        }
    } catch (_) {}
    return null;
}

/**
 * Resolves an Instagram /share/ redirect URL under Reeva-controlled HTTP boundaries.
 * Enforces Instagram domain allowlist, socket DNS pinning (safeLookup), and max 3 redirects.
 *
 * @param {string} shareUrl
 * @param {object} [options]
 * @returns {Promise<string>} Final destination URL
 */
async function resolveInstagramShareUrl(shareUrl, options = {}) {
    const fetchFn = options.fetchFn || secureFetch;
    const timeoutMs = options.timeoutMs || 8000;
    const { finalUrl, abort, clearTimeout: clearTimer } = await fetchFn(shareUrl, {
        allowedDomains: SUPPORTED_SOURCE_DOMAINS.instagram,
        maxRedirects: 3,
        timeoutMs,
        signal: options.signal,
        headers: {
            "User-Agent": INSTAGRAM_CRAWLER_USER_AGENT
        }
    });
    clearTimer();
    return finalUrl;
}

/**
 * Obtains an Instagram CSRF token from homepage headers under controlled HTTP boundaries.
 * Does not log tokens, cookies, or headers.
 *
 * @param {object} [options]
 * @returns {Promise<string>}
 */
async function fetchInstagramCsrfToken(options = {}) {
    const fetchFn = options.fetchFn || secureFetch;
    const timeoutMs = options.timeoutMs || 8000;
    const { response, abort, clearTimeout: clearTimer } = await fetchFn("https://www.instagram.com/", {
        allowedDomains: SUPPORTED_SOURCE_DOMAINS.instagram,
        maxRedirects: 2,
        timeoutMs,
        signal: options.signal,
        maxSizeBytes: MAX_CSRF_RESPONSE_BYTES,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        }
    });

    try {
        const cookies = (typeof response.headers?.raw === "function" && response.headers.raw()["set-cookie"]) ||
            (response.headers?.get && response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);
        for (const cookie of cookies) {
            const match = cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
            if (match && match[1]) {
                return match[1].trim();
            }
        }
        return "";
    } finally {
        clearTimer();
        abort();
    }
}

/**
 * Queries Instagram GraphQL endpoint under Reeva-controlled HTTP boundaries.
 * Bounded size, HTTPS-only, pinned DNS (safeLookup), cancellation-aware.
 *
 * @param {string} shortcode
 * @param {object} [options]
 * @returns {Promise<object|null>}
 */
async function fetchInstagramGraphQL(shortcode, options = {}) {
    if (!shortcode || !/^[a-zA-Z0-9_-]+$/.test(shortcode)) {
        return null;
    }

    const fetchFn = options.fetchFn || secureFetch;
    const timeoutMs = options.timeoutMs || 8000;
    const csrfToken = options.csrfToken || "";

    const params = new URLSearchParams();
    params.set("variables", JSON.stringify({
        shortcode,
        fetch_tagged_user_count: null,
        hoisted_comment_id: null,
        hoisted_reply_id: null
    }));
    params.set("doc_id", INSTAGRAM_DOCUMENT_ID);
    const requestBody = params.toString();

    const headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "*/*",
        "Referer": "https://www.instagram.com/",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    };
    if (csrfToken) {
        headers["X-CSRFToken"] = csrfToken;
    }

    const { response, abort, clearTimeout: clearTimer } = await fetchFn(INSTAGRAM_GRAPHQL_ENDPOINT, {
        method: "POST",
        body: requestBody,
        headers,
        allowedDomains: SUPPORTED_SOURCE_DOMAINS.instagram,
        maxRedirects: 2,
        timeoutMs,
        signal: options.signal,
        maxSizeBytes: MAX_GRAPHQL_RESPONSE_BYTES
    });

    try {
        if ([401, 403, 429].includes(response.status)) {
            throw new SecurityHTTPError(`Instagram returned HTTP ${response.status}`, response.status);
        }
        if (!response.ok) {
            throw new SecurityHTTPError(`Instagram GraphQL request failed (${response.status})`, response.status);
        }

        const rawText = await readStreamWithLimit(response.body, MAX_GRAPHQL_RESPONSE_BYTES, abort);
        let data;
        try {
            data = JSON.parse(rawText);
        } catch (_) {
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
                "Failed to parse Instagram GraphQL response."
            );
        }

        const media = data?.data?.xdt_shortcode_media;
        return media || null;
    } finally {
        clearTimer();
    }
}

/**
 * Native Reeva-controlled Instagram fallback extractor.
 * Replaces third-party instagram-url-direct with strict Reeva networking primitives.
 *
 * @param {string} validatedUrl - Pre-validated Instagram URL
 * @param {object} [options]
 * @returns {Promise<{ url: string, type: 'video'|'image', title?: string }>}
 */
async function extractInstagramNativeFallback(validatedUrl, options = {}) {
    const timeoutMs = options.timeoutMs || 8000;
    const signal = options.signal;

    if (signal && signal.aborted) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT,
            "Subprocess execution cancelled by client."
        );
    }

    let targetUrl = validatedUrl;
    let shortcode = extractShortcode(targetUrl);

    // If URL is a /share link or shortcode missing, resolve redirects under safe boundaries
    if (!shortcode || targetUrl.includes("/share")) {
        try {
            targetUrl = await resolveInstagramShareUrl(targetUrl, { timeoutMs, signal, fetchFn: options.fetchFn });
            shortcode = extractShortcode(targetUrl);
        } catch (err) {
            if (err instanceof SecurityHTTPError || err instanceof SSRFError || err instanceof ValidationError) {
                throw err;
            }
        }
    }

    if (!shortcode) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            "Could not parse Instagram post shortcode from URL."
        );
    }

    // Step 1: CSRF Token
    let csrfToken = "";
    try {
        csrfToken = await fetchInstagramCsrfToken({ timeoutMs, signal, fetchFn: options.fetchFn });
    } catch (err) {
        if (err instanceof SecurityHTTPError && (
            err.code === "DISALLOWED_DESTINATION" ||
            err.code === "FORBIDDEN_PROTOCOL" ||
            err.code === "CLIENT_ABORTED"
        )) {
            throw err;
        }
        // If CSRF fetch fails non-fatally, attempt GraphQL without token
    }

    // Step 2: GraphQL Request
    const media = await fetchInstagramGraphQL(shortcode, { csrfToken, timeoutMs, signal, fetchFn: options.fetchFn });
    if (!media) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            "The requested Instagram post was not found."
        );
    }

    // Step 3: Extract candidate URL and type
    let candidateUrl = null;
    let candidateType = "video";
    let title = "Instagram Video";

    if (media.edge_media_to_caption?.edges?.[0]?.node?.text) {
        title = media.edge_media_to_caption.edges[0].node.text.slice(0, 100);
    }

    if (media.__typename === "XDTGraphSidecar" && Array.isArray(media.edge_sidecar_to_children?.edges)) {
        const children = media.edge_sidecar_to_children.edges;
        const videoChild = children.find(c => c?.node?.is_video && typeof c.node.video_url === "string");
        if (videoChild) {
            candidateUrl = videoChild.node.video_url;
            candidateType = "video";
        } else {
            const imageChild = children.find(c => typeof c?.node?.display_url === "string");
            if (imageChild) {
                candidateUrl = imageChild.node.display_url;
                candidateType = "image";
                title = title || "Instagram Photo";
            }
        }
    } else if (media.is_video && typeof media.video_url === "string") {
        candidateUrl = media.video_url;
        candidateType = "video";
    } else if (typeof media.display_url === "string") {
        candidateUrl = media.display_url;
        candidateType = "image";
        title = title || "Instagram Photo";
    }

    if (!candidateUrl) {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            "No downloadable media found in Instagram post."
        );
    }

    // Step 4: Strict validation of candidate URL against approved media CDN allowlist
    validateMediaUrl(candidateUrl);

    return {
        url: candidateUrl,
        type: candidateType,
        title
    };
}

/**
 * Extracts media from an Instagram URL.
 *
 * Strategy 1 (Primary): OpenGraph crawler metadata extraction via facebookexternalhit/1.1
 * Strategy 2 (Secondary Fallback): Reeva-controlled native GraphQL fallback
 *
 * Security short-circuit: All security violations (SSRF, URL validation, unapproved CDN)
 * halt extraction immediately and never invoke fallback.
 *
 * @param {string} validatedUrl - HTTPS URL pre-validated against Instagram source domains
 * @param {object} [options] - Options (timeoutMs, requestId, provider, fetchHtml, fetchFn, signal, etc.)
 * @returns {Promise<{ url: string, type: 'video'|'image', title?: string }>}
 */
async function extractInstagram(validatedUrl, options = {}) {
    const timeoutMs = options.timeoutMs || 10000;
    const fetchHtmlFn = options.fetchHtml || secureFetchHtml;
    const directProvider = options.provider !== undefined ? options.provider : undefined;
    let primaryError = null;

    // Resolve directFn if test provider mock passed
    let directFn = null;
    if (typeof directProvider === "function") {
        directFn = directProvider;
    } else if (directProvider && typeof directProvider.instagramGetUrl === "function") {
        directFn = directProvider.instagramGetUrl;
    }

    // 1. PRIMARY STRATEGY: Crawler-Metadata Extraction
    try {
        const html = await fetchHtmlFn(
            validatedUrl,
            SUPPORTED_SOURCE_DOMAINS.instagram,
            DEFAULT_MAX_HTML_BYTES,
            {
                headers: {
                    "User-Agent": INSTAGRAM_CRAWLER_USER_AGENT
                },
                timeoutMs,
                signal: options.signal
            }
        );

        if (html && typeof html === "string" && html.trim().length > 0) {
            const isVideo = isVideoContent(validatedUrl, html);
            const videoUrl = extractInstagramVideo(html) || extractEmbeddedVideo(html);
            const title = extractInstagramTitle(html) || (isVideo ? "Instagram Video" : "Instagram Media");

            if (videoUrl) {
                // Validate media URL against approved media CDN allowlist
                validateMediaUrl(videoUrl);
                return {
                    url: videoUrl,
                    type: "video",
                    title
                };
            }

            // Video-first enforcement:
            // If the post is identified as video (Reel/TV or og:type=video), DO NOT return og:image as video!
            if (!isVideo) {
                const imageUrl = extractInstagramImage(html) || extractEmbeddedImage(html);
                if (imageUrl) {
                    validateMediaUrl(imageUrl);
                    return {
                        url: imageUrl,
                        type: "image",
                        title: title || "Instagram Photo"
                    };
                }
            }

            // If it's a video or photo post and no media URL was found, check for challenge/barrier
            if (isChallengeOrAuthBarrier(html)) {
                throw new ExtractionError(
                    EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE,
                    "Instagram returned a login or challenge barrier for this post. Make sure the content is publicly accessible.",
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
                err.code === "RESPONSE_TOO_LARGE" ||
                err.code === "CLIENT_ABORTED"
            ))
        ) {
            throw err;
        }

        // Map HTTP status codes from secureFetchHtml
        if (err.statusCode === 401 || err.statusCode === 403) {
            primaryError = new ExtractionError(
                EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE,
                "Instagram returned an authentication challenge or access restriction for this post.",
                { statusCode: 403, originalStatus: err.statusCode }
            );
        } else if (err.statusCode === 404) {
            primaryError = new ExtractionError(
                EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
                "The requested Instagram post was not found.",
                { statusCode: 404 }
            );
        } else if (err.code === "TIMEOUT" || err.statusCode === 504) {
            primaryError = new ExtractionError(
                EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT,
                "Request timed out while contacting Instagram.",
                { timeoutMs }
            );
        } else {
            primaryError = err;
        }
    }

    // 2. SECONDARY STRATEGY (Fallback): Native Reeva-controlled fallback or test provider mock
    if (directProvider !== null) {
        try {
            let result;
            if (directFn) {
                const op = typeof directFn === "function"
                    ? (directFn.length >= 2 ? ({ signal }) => directFn(validatedUrl, { signal }) : () => directFn(validatedUrl))
                    : directFn;
                result = await withTimeout(op, timeoutMs, "instagram-fallback-provider");
            } else {
                result = await extractInstagramNativeFallback(validatedUrl, {
                    timeoutMs,
                    signal: options.signal,
                    fetchFn: options.fetchFn
                });
            }

            let candidateUrl = null;
            let candidateType = "video";
            let title = "Instagram Video";

            if (result && typeof result === "object") {
                if (result.url && typeof result.url === "string") {
                    candidateUrl = result.url;
                    candidateType = result.type === "image" ? "image" : "video";
                    title = result.title || title;
                } else if (Array.isArray(result.media_details) && result.media_details.length > 0) {
                    const videoItem = result.media_details.find(m => m && m.type === "video" && typeof m.url === "string");
                    const selected = videoItem || result.media_details.find(m => m && typeof m.url === "string");
                    if (selected) {
                        candidateUrl = selected.url;
                        candidateType = selected.type === "image" ? "image" : "video";
                    }
                } else if (Array.isArray(result.url_list) && result.url_list.length > 0) {
                    const firstUrl = result.url_list.find(u => typeof u === "string" && u.trim().length > 0);
                    if (firstUrl) {
                        candidateUrl = firstUrl;
                        candidateType = firstUrl.includes(".mp4") ? "video" : "image";
                    }
                }

                if (result.post_info && typeof result.post_info.caption === "string" && result.post_info.caption.trim()) {
                    title = result.post_info.caption.slice(0, 100);
                }
            }

            if (candidateUrl) {
                // Must validate candidate URL against media allowlist
                validateMediaUrl(candidateUrl);

                return {
                    url: candidateUrl,
                    type: candidateType,
                    title
                };
            }
        } catch (err) {
            // Security violations must halt immediately
            if (err instanceof ValidationError || err instanceof SSRFError || err instanceof SecurityHTTPError) {
                throw err;
            }
            if (err instanceof ExtractionError && err.code === EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT) {
                throw err;
            }
            // Fallback error recorded, fall through
        }
    }

    // If primary error was a specific classified error (e.g. PLATFORM_CHALLENGE), rethrow it
    if (primaryError instanceof ExtractionError && (
        primaryError.code === EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE ||
        primaryError.code === EXTRACTION_ERROR_CODES.PRIVATE_CONTENT
    )) {
        throw primaryError;
    }

    // Default failure
    throw new ExtractionError(
        EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
        "Could not find downloadable media for this Instagram link. Ensure it is public and contains visible media.",
        { originalError: primaryError?.message }
    );
}

module.exports = {
    extractInstagram,
    extractInstagramVideo,
    extractInstagramImage,
    extractInstagramTitle,
    isVideoContent,
    isChallengeOrAuthBarrier,
    extractShortcode,
    resolveInstagramShareUrl,
    fetchInstagramCsrfToken,
    fetchInstagramGraphQL,
    extractInstagramNativeFallback,
    INSTAGRAM_CRAWLER_USER_AGENT
};
