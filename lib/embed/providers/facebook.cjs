// lib/embed/providers/facebook.cjs — Official Facebook Sandboxed Video Embed Provider
"use strict";

const { URL } = require("url");
const { SUPPORTED_SOURCE_DOMAINS, validateSourceUrl } = require("../../url-validator.cjs");
const { secureFetch } = require("../../http-client.cjs");
const { EmbedError, EMBED_ERROR_CODES, buildSandboxedIframe } = require("../types.cjs");

/**
 * Validates and extracts video information from a Facebook URL.
 *
 * @param {string} urlStr
 * @returns {{ videoId?: string, isWatch: boolean, isReel: boolean }|null}
 */
function inspectFacebookUrl(urlStr) {
    try {
        const parsed = new URL(urlStr);
        const searchId = parsed.searchParams.get("v");
        if (searchId && /^\d+$/.test(searchId)) {
            return { videoId: searchId, isWatch: true, isReel: false };
        }

        const reelMatch = parsed.pathname.match(/\/(?:reel|reels)\/(\d+)/);
        if (reelMatch && reelMatch[1]) {
            return { videoId: reelMatch[1], isWatch: false, isReel: true };
        }

        const videoMatch = parsed.pathname.match(/\/videos\/(?:[^/]+\/)?(\d+)/);
        if (videoMatch && videoMatch[1]) {
            return { videoId: videoMatch[1], isWatch: false, isReel: false };
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Resolves Facebook embed details using official Facebook Video Player plugin iframe.
 *
 * @param {string} validatedUrl - Validated Facebook HTTPS URL
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function resolveFacebookEmbed(validatedUrl, options = {}) {
    const fetchFn = options.fetch || secureFetch;
    let targetUrl = validatedUrl;
    const parsed = new URL(targetUrl);

    // Securely resolve fb.watch short links
    if (parsed.hostname === "fb.watch" || parsed.hostname.endsWith(".fb.watch")) {
        try {
            const { finalUrl, clearTimeout: clearTimer } = await fetchFn(targetUrl, {
                allowedDomains: SUPPORTED_SOURCE_DOMAINS.facebook,
                maxRedirects: 3,
                timeoutMs: options.timeoutMs || 8000
            });
            if (typeof clearTimer === "function") clearTimer();
            targetUrl = validateSourceUrl(finalUrl, "facebook");
        } catch (e) {
            if (e.statusCode === 404) {
                throw new EmbedError("The requested Facebook video was not found or is private.", EMBED_ERROR_CODES.EMBED_NOT_FOUND, 404);
            }
            if (e.code === "TIMEOUT" || e.statusCode === 504) {
                throw new EmbedError("Upstream timeout resolving Facebook short link.", EMBED_ERROR_CODES.UPSTREAM_TIMEOUT, 504);
            }
            throw new EmbedError("Could not resolve Facebook short link.", EMBED_ERROR_CODES.UPSTREAM_COMMUNICATION_ERROR, 502);
        }
    }

    const info = inspectFacebookUrl(targetUrl);
    if (!info) {
        throw new EmbedError(
            "Could not parse valid Facebook video target URL.",
            EMBED_ERROR_CODES.INVALID_URL,
            400
        );
    }

    const embedUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(targetUrl)}&show_text=false&width=500`;
    const title = options.title || "Facebook Video";
    const iframeHtml = buildSandboxedIframe(embedUrl, {
        width: 500,
        height: 281,
        title,
        allow: "autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
    });

    return {
        platform: "facebook",
        type: "embed",
        downloadSupported: false,
        videoId: info.videoId || null,
        originalUrl: validatedUrl,
        canonicalUrl: targetUrl,
        embedUrl,
        iframeHtml,
        title,
        notice: "Direct video file downloads are restricted by platform terms. An official embedded player is provided."
    };
}

module.exports = {
    inspectFacebookUrl,
    resolveFacebookEmbed
};
