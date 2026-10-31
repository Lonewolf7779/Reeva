// lib/embed/providers/tiktok.cjs — Official TikTok Sandboxed Embed Provider
"use strict";

const { URL } = require("url");
const { SUPPORTED_SOURCE_DOMAINS, validateSourceUrl } = require("../../url-validator.cjs");
const { secureFetch } = require("../../http-client.cjs");
const { EmbedError, EMBED_ERROR_CODES, escapeHtml, buildSandboxedIframe } = require("../types.cjs");

/**
 * Extracts the numerical video ID from a TikTok URL path.
 *
 * @param {string} urlStr
 * @returns {string|null}
 */
function extractTikTokVideoId(urlStr) {
    try {
        const parsed = new URL(urlStr);
        // /@username/video/1234567890123456789
        const videoMatch = parsed.pathname.match(/\/video\/(\d{15,25})/);
        if (videoMatch && videoMatch[1]) return videoMatch[1];

        // /v/1234567890123456789.html or /v/1234567890123456789
        const vMatch = parsed.pathname.match(/\/v\/(\d{15,25})/);
        if (vMatch && vMatch[1]) return vMatch[1];

        return null;
    } catch {
        return null;
    }
}

/**
 * Resolves TikTok embed details using official embed v2 player and optional oEmbed metadata.
 *
 * @param {string} validatedUrl - Validated TikTok HTTPS URL
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function resolveTikTokEmbed(validatedUrl, options = {}) {
    const fetchFn = options.fetch || secureFetch;
    let targetUrl = validatedUrl;
    const parsed = new URL(targetUrl);

    // Securely resolve vm.tiktok.com / vt.tiktok.com short links
    if (parsed.hostname.startsWith("vm.") || parsed.hostname.startsWith("vt.")) {
        try {
            const { finalUrl, clearTimeout: clearTimer } = await fetchFn(targetUrl, {
                allowedDomains: SUPPORTED_SOURCE_DOMAINS.tiktok,
                maxRedirects: 3,
                timeoutMs: options.timeoutMs || 8000
            });
            if (typeof clearTimer === "function") clearTimer();
            targetUrl = validateSourceUrl(finalUrl, "tiktok");
        } catch (e) {
            if (e.statusCode === 404) {
                throw new EmbedError("The requested TikTok video was not found or is private.", EMBED_ERROR_CODES.EMBED_NOT_FOUND, 404);
            }
            if (e.code === "TIMEOUT" || e.statusCode === 504) {
                throw new EmbedError("Upstream timeout resolving TikTok short link.", EMBED_ERROR_CODES.UPSTREAM_TIMEOUT, 504);
            }
            throw new EmbedError("Could not resolve TikTok short link.", EMBED_ERROR_CODES.UPSTREAM_COMMUNICATION_ERROR, 502);
        }
    }

    const videoId = extractTikTokVideoId(targetUrl);
    if (!videoId) {
        throw new EmbedError(
            "Could not extract a valid TikTok video ID from the provided URL.",
            EMBED_ERROR_CODES.INVALID_URL,
            400
        );
    }

    const embedUrl = `https://www.tiktok.com/embed/v2/${videoId}`;
    let title = "TikTok Video";
    let author = null;
    let thumbnail = null;

    // Optional metadata lookup via TikTok oEmbed endpoint if requested
    if (options.queryOEmbed) {
        try {
            const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(targetUrl)}`;
            const { response, clearTimeout: clearTimer } = await fetchFn(oembedUrl, {
                allowedDomains: SUPPORTED_SOURCE_DOMAINS.tiktok,
                maxRedirects: 2,
                timeoutMs: 4000
            });
            if (typeof clearTimer === "function") clearTimer();
            if (response && response.status === 200) {
                const body = await response.text();
                const json = JSON.parse(body);
                if (json.title) title = escapeHtml(json.title);
                if (json.author_name) author = escapeHtml(json.author_name);
                if (json.thumbnail_url) thumbnail = json.thumbnail_url;
            }
        } catch {
            // TikTok oEmbed is optional; if CDN blocks or times out, proceed with canonical embed
        }
    }

    const iframeHtml = buildSandboxedIframe(embedUrl, {
        width: 340,
        height: 700,
        title: title || "TikTok Video"
    });

    return {
        platform: "tiktok",
        type: "embed",
        downloadSupported: false,
        videoId,
        originalUrl: validatedUrl,
        canonicalUrl: targetUrl,
        embedUrl,
        iframeHtml,
        title,
        author,
        thumbnailUrl: thumbnail,
        notice: "Direct video file downloads are restricted by platform terms. An official embedded player is provided."
    };
}

module.exports = {
    extractTikTokVideoId,
    resolveTikTokEmbed
};
