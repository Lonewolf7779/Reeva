// lib/embed/index.cjs — Centralized Official Embed Provider for Reeva
"use strict";

const { validateSourceUrl, ValidationError } = require("../url-validator.cjs");
const { SSRFError } = require("../ssrf-filter.cjs");
const { SecurityHTTPError } = require("../http-client.cjs");
const { EmbedError, EMBED_ERROR_CODES, escapeHtml, buildSandboxedIframe } = require("./types.cjs");
const { resolveTikTokEmbed } = require("./providers/tiktok.cjs");
const { resolveInstagramEmbed } = require("./providers/instagram.cjs");
const { resolveFacebookEmbed } = require("./providers/facebook.cjs");

const SUPPORTED_EMBED_PLATFORMS = Object.freeze(["tiktok", "instagram", "facebook"]);

/**
 * Resolves an official sandboxed embed for the given platform and input URL.
 *
 * @param {string} platform - "tiktok" | "instagram" | "facebook"
 * @param {string} rawUrl - Untrusted input URL
 * @param {object} [options] - Additional provider options
 * @returns {Promise<object>} Structured embed metadata
 */
async function resolveEmbed(platform, rawUrl, options = {}) {
    if (!platform || typeof platform !== "string") {
        throw new EmbedError("Missing platform parameter.", EMBED_ERROR_CODES.INVALID_URL, 400);
    }

    const normPlatform = platform.toLowerCase().trim();
    if (!SUPPORTED_EMBED_PLATFORMS.includes(normPlatform)) {
        throw new EmbedError(
            `Unsupported embed platform '${platform}'. Supported platforms: ${SUPPORTED_EMBED_PLATFORMS.join(", ")}.`,
            EMBED_ERROR_CODES.UNSUPPORTED_PLATFORM,
            400
        );
    }

    if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim()) {
        throw new EmbedError("Missing video URL parameter.", EMBED_ERROR_CODES.INVALID_URL, 400);
    }

    // Strict URL validation and domain boundary verification
    let validatedUrl;
    try {
        validatedUrl = validateSourceUrl(rawUrl.trim(), normPlatform);
    } catch (err) {
        if (err instanceof ValidationError) {
            throw new EmbedError(err.message, EMBED_ERROR_CODES.DISALLOWED_DOMAIN, 400, { originalCode: err.code });
        }
        throw new EmbedError("Invalid URL format.", EMBED_ERROR_CODES.INVALID_URL, 400);
    }

    try {
        switch (normPlatform) {
            case "tiktok":
                return await resolveTikTokEmbed(validatedUrl, options);
            case "instagram":
                return await resolveInstagramEmbed(validatedUrl, options);
            case "facebook":
                return await resolveFacebookEmbed(validatedUrl, options);
            default:
                throw new EmbedError(`Unsupported embed platform '${normPlatform}'.`, EMBED_ERROR_CODES.UNSUPPORTED_PLATFORM, 400);
        }
    } catch (err) {
        if (err instanceof EmbedError) {
            throw err;
        }
        if (err instanceof SSRFError) {
            throw new EmbedError("Request blocked by SSRF defense.", EMBED_ERROR_CODES.DISALLOWED_DOMAIN, 400);
        }
        if (err instanceof SecurityHTTPError) {
            if (err.statusCode === 404) {
                throw new EmbedError("The requested media content was not found or is private.", EMBED_ERROR_CODES.EMBED_NOT_FOUND, 404);
            }
            if (err.statusCode === 401 || err.statusCode === 403) {
                throw new EmbedError("Access to this content is restricted by the platform.", EMBED_ERROR_CODES.PLATFORM_RESTRICTED, 403);
            }
            if (err.code === "TIMEOUT" || err.statusCode === 504) {
                throw new EmbedError("Upstream timeout connecting to platform.", EMBED_ERROR_CODES.UPSTREAM_TIMEOUT, 504);
            }
            throw new EmbedError("Upstream communication failure.", EMBED_ERROR_CODES.UPSTREAM_COMMUNICATION_ERROR, 502);
        }

        throw new EmbedError(
            err.message || "Failed to resolve embed.",
            EMBED_ERROR_CODES.MALFORMED_RESPONSE,
            502,
            { originalError: err.message }
        );
    }
}

module.exports = {
    SUPPORTED_EMBED_PLATFORMS,
    resolveEmbed,
    EmbedError,
    EMBED_ERROR_CODES,
    escapeHtml,
    buildSandboxedIframe
};
