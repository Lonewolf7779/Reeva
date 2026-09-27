// lib/extraction/strategies.cjs — Common Extraction Strategies and Execution Controls
"use strict";

const { ExtractionError, EXTRACTION_ERROR_CODES } = require("./types.cjs");

const DEFAULT_PROVIDER_TIMEOUT_MS = 10000;

/**
 * Bounds the execution time of an asynchronous provider strategy.
 *
 * @param {Promise<any>} promise - Promise executing the provider operation
 * @param {number} timeoutMs - Max execution time in ms
 * @param {string} providerName - Identifier for logging and error reporting
 * @returns {Promise<any>}
 */
async function withTimeout(promise, timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS, providerName = "provider") {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new ExtractionError(
                EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT,
                `Extraction timed out after ${timeoutMs}ms while contacting ${providerName}.`,
                { provider: providerName, timeoutMs }
            ));
        }, timeoutMs);
    });

    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Extracts video/media URLs from HTML og:video / og:image meta tags.
 *
 * @param {string} html - Raw HTML string
 * @returns {string|null} Discovered URL or null
 */
function extractFromMeta(html) {
    if (!html || typeof html !== "string") return null;
    const match = html.match(/<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i);
    if (match && match[1]) return match[1];
    return null;
}

/**
 * Robust regex-based extraction from raw social media HTML pages.
 * Supports Instagram, Pinterest, and generic OpenGraph metadata.
 *
 * @param {string} html - Raw HTML string
 * @returns {{ url: string, type: 'video' | 'image' } | null}
 */
function extractMediaFromHtml(html) {
    if (!html || typeof html !== "string") return null;

    const decode = s => s?.replace(/\\"/g, '"').replace(/\\u0026/g, "&");

    const patterns = [
        { regex: /"video_versions":\[\{[^}]*"url":"([^"]+)"/i, type: "video" },
        { regex: /"video_url"\s*:\s*"([^"]+)"/i, type: "video" },
        { regex: /"url"\s*:\s*"([^"]+\.mp4[^"]*)"/i, type: "video" },
        { regex: /"src"\s*:\s*"([^"]+\.mp4[^"]*)"/i, type: "video" },
        { regex: /"contentUrl"\s*:\s*"([^"]+)"/i, type: "video" },
        { regex: /"playbackUrl"\s*:\s*"([^"]+)"/i, type: "video" },
        { regex: /"display_resources":\[\{[^}]*"src":"([^"]+)"/i, type: "image" },
        { regex: /"display_url"\s*:\s*"([^"]+)"/i, type: "image" },
        { regex: /<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i, type: "video" },
        { regex: /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i, type: "image" }
    ];

    for (const { regex, type } of patterns) {
        const match = html.match(regex);
        if (match && match[1]) {
            const rawUrl = decode(match[1]);
            const actualType = (type === "video" || rawUrl.includes(".mp4")) ? "video" : "image";
            return { url: rawUrl, type: actualType };
        }
    }

    return null;
}

module.exports = {
    DEFAULT_PROVIDER_TIMEOUT_MS,
    withTimeout,
    extractFromMeta,
    extractMediaFromHtml
};
