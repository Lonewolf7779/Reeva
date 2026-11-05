// lib/embed/providers/instagram.cjs — Official Instagram Sandboxed Embed Provider
"use strict";

const { URL } = require("url");
const { EmbedError, EMBED_ERROR_CODES, buildSandboxedIframe } = require("../types.cjs");

/**
 * Extracts the post/reel shortcode from an Instagram URL.
 *
 * @param {string} urlStr
 * @returns {string|null}
 */
function extractInstagramShortcode(urlStr) {
    try {
        const parsed = new URL(urlStr);
        // /p/{shortcode}/, /reel/{shortcode}/, /reels/{shortcode}/, /tv/{shortcode}/
        const match = parsed.pathname.match(/\/(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]{5,35})/i);
        if (match && match[1]) return match[1];
        return null;
    } catch {
        return null;
    }
}

/**
 * Resolves Instagram embed details using official iframe embed endpoint.
 *
 * @param {string} validatedUrl - Validated Instagram HTTPS URL
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function resolveInstagramEmbed(validatedUrl, options = {}) {
    const shortcode = extractInstagramShortcode(validatedUrl);
    if (!shortcode) {
        throw new EmbedError(
            "Could not extract a valid Instagram shortcode from the provided URL.",
            EMBED_ERROR_CODES.INVALID_URL,
            400
        );
    }

    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/`;
    const title = options.title || "Instagram Post";
    const iframeHtml = buildSandboxedIframe(embedUrl, {
        width: 400,
        height: 480,
        title
    });

    return {
        platform: "instagram",
        type: "embed",
        downloadSupported: false,
        shortcode,
        originalUrl: validatedUrl,
        canonicalUrl: `https://www.instagram.com/p/${shortcode}/`,
        embedUrl,
        iframeHtml,
        title,
        notice: "Direct video file downloads are restricted by platform terms. An official embedded player is provided."
    };
}

module.exports = {
    extractInstagramShortcode,
    resolveInstagramEmbed
};
