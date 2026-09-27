// lib/extraction/strategies.cjs — Common Extraction Strategies and Execution Controls
"use strict";

const { ExtractionError, EXTRACTION_ERROR_CODES } = require("./types.cjs");

const DEFAULT_PROVIDER_TIMEOUT_MS = 10000;

/**
 * Decodes escaped URLs extracted from HTML attributes or script JSON,
 * unescaping &amp; entities, escaped quotes, and unicode ampersands.
 *
 * @param {string} raw - Raw URL string from HTML or script tag
 * @returns {string} Clean decoded URL
 */
function decodeUrl(raw) {
    if (!raw || typeof raw !== "string") return "";
    return raw
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/\\"/g, '"')
        .replace(/\\u0026/g, "&")
        .replace(/\\\//g, "/");
}

/**
 * Bounds the execution time of an asynchronous provider strategy.
 *
 * Supports two distinct execution models:
 * 1. Cancellable Operations: function ({ signal }) => Promise<any>
 *    When a timeout occurs, the AbortController triggers signal.abort(),
 *    notifying cooperative providers or network clients to cancel pending requests.
 * 2. Non-cancellable Third-Party Promises: Promise<any> or function () => Promise<any>
 *    When third-party libraries do not expose an AbortSignal, Reeva bounds its own
 *    waiting time and returns PROVIDER_TIMEOUT. We do NOT falsely claim that the
 *    underlying third-party promise was cancelled; it will continue in the background
 *    until its own network or library lifecycle terminates.
 *
 * @param {Function|Promise<any>} operationOrPromise - Function taking ({ signal }) or raw Promise
 * @param {number} [timeoutMs=DEFAULT_PROVIDER_TIMEOUT_MS] - Timeout duration in milliseconds
 * @param {string} [providerName="provider"] - Identifier for error reporting
 * @returns {Promise<any>}
 */
async function withTimeout(operationOrPromise, timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS, providerName = "provider") {
    const isCancellableFunction = typeof operationOrPromise === "function";
    const controller = isCancellableFunction ? new AbortController() : null;

    let timer;
    let timedOutError = null;

    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            timedOutError = new ExtractionError(
                EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT,
                `Extraction timed out after ${timeoutMs}ms while contacting ${providerName}.`,
                {
                    provider: providerName,
                    timeoutMs,
                    cancellable: isCancellableFunction,
                    cancelled: isCancellableFunction
                }
            );

            if (controller) {
                try {
                    controller.abort();
                } catch {
                    // Suppress any synchronous abort handler errors
                }
            }

            reject(timedOutError);
        }, timeoutMs);
    });

    try {
        let workPromise;
        if (isCancellableFunction) {
            workPromise = operationOrPromise({ signal: controller.signal });
        } else {
            workPromise = operationOrPromise;
        }

        // Attach safe error handler on workPromise to prevent unhandled rejections
        // if an operation rejects after the timeout has fired
        if (workPromise && typeof workPromise.catch === "function") {
            workPromise.catch(() => {});
        }

        const result = await Promise.race([workPromise, timeoutPromise]);
        if (timedOutError) {
            throw timedOutError;
        }
        return result;
    } catch (err) {
        if (timedOutError) {
            throw timedOutError;
        }
        throw err;
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

/**
 * Extracts video/media URLs from HTML og:video / og:image meta tags.
 * Supports standard and reversed attribute orders (property/name and content).
 * Decodes HTML entities such as &amp; before returning.
 *
 * @param {string} html - Raw HTML string
 * @param {string|string[]} [propertyNames=["og:video", "og:video:url", "og:video:secure_url"]]
 * @returns {string|null} Discovered URL or null
 */
function extractFromMeta(html, propertyNames = ["og:video", "og:video:url", "og:video:secure_url"]) {
    if (!html || typeof html !== "string") return null;
    const names = Array.isArray(propertyNames) ? propertyNames : [propertyNames];

    for (const name of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Order 1: property or name before content
        const p1 = new RegExp(`<meta\\s+[^>]*?(?:property|name)=["']${escaped}["'][^>]*?content=["']([^"']+)["']`, "i");
        const m1 = html.match(p1);
        if (m1 && m1[1]) {
            return decodeUrl(m1[1]);
        }

        // Order 2: content before property or name
        const p2 = new RegExp(`<meta\\s+[^>]*?content=["']([^"']+)["'][^>]*?(?:property|name)=["']${escaped}["']`, "i");
        const m2 = html.match(p2);
        if (m2 && m2[1]) {
            return decodeUrl(m2[1]);
        }
    }
    return null;
}

/**
 * Robust regex-based extraction from raw social media HTML pages.
 * Supports Instagram, Pinterest, and generic OpenGraph metadata.
 * Decodes &amp;, \\", and \\u0026 entities.
 *
 * @param {string} html - Raw HTML string
 * @returns {{ url: string, type: 'video' | 'image' } | null}
 */
function extractMediaFromHtml(html) {
    if (!html || typeof html !== "string") return null;

    // 1. Meta video tags (order-independent)
    const videoMeta = extractFromMeta(html, ["og:video", "og:video:url", "og:video:secure_url"]);
    if (videoMeta) {
        return { url: videoMeta, type: "video" };
    }

    // 2. Embedded video JSON
    const videoPatterns = [
        /"video_versions":\[\{[^}]*"url":"([^"]+)"/i,
        /"video_url"\s*:\s*"([^"]+)"/i,
        /"url"\s*:\s*"([^"]+\.mp4[^"]*)"/i,
        /"src"\s*:\s*"([^"]+\.mp4[^"]*)"/i,
        /"contentUrl"\s*:\s*"([^"]+)"/i,
        /"playbackUrl"\s*:\s*"([^"]+)"/i
    ];
    for (const regex of videoPatterns) {
        const match = html.match(regex);
        if (match && match[1]) {
            const rawUrl = decodeUrl(match[1]);
            return { url: rawUrl, type: "video" };
        }
    }

    // 3. Meta image tags (order-independent)
    const imageMeta = extractFromMeta(html, ["og:image", "og:image:url", "og:image:secure_url"]);
    if (imageMeta) {
        return { url: imageMeta, type: "image" };
    }

    // 4. Embedded image JSON
    const imagePatterns = [
        /"display_resources":\[\{[^}]*"src":"([^"]+)"/i,
        /"display_url"\s*:\s*"([^"]+)"/i
    ];
    for (const regex of imagePatterns) {
        const match = html.match(regex);
        if (match && match[1]) {
            const rawUrl = decodeUrl(match[1]);
            return { url: rawUrl, type: "image" };
        }
    }

    return null;
}

module.exports = {
    DEFAULT_PROVIDER_TIMEOUT_MS,
    decodeUrl,
    withTimeout,
    extractFromMeta,
    extractMediaFromHtml
};
