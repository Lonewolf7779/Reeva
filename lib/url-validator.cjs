// lib/url-validator.cjs — Centralized URL and Platform Validation for Reeva
"use strict";

const { URL } = require("url");

/**
 * Explicit allowlist of supported source platforms and their permitted source hostnames.
 * Hostnames are validated strictly on boundary: exact match or subdomain.
 */
const SUPPORTED_SOURCE_DOMAINS = Object.freeze({
    instagram: Object.freeze([
        "instagram.com",
        "instagr.am"
    ]),
    facebook: Object.freeze([
        "facebook.com",
        "fb.watch",
        "fb.com"
    ]),
    twitter: Object.freeze([
        "twitter.com",
        "x.com"
    ]),
    x: Object.freeze([
        "twitter.com",
        "x.com"
    ]),
    pinterest: Object.freeze([
        "pinterest.com",
        "pin.it",
        "pinterest.co.uk",
        "pinterest.ca",
        "pinterest.fr",
        "pinterest.de",
        "pinterest.it",
        "pinterest.es",
        "pinterest.jp",
        "pinterest.com.au"
    ]),
    youtube: Object.freeze([
        "youtube.com",
        "youtu.be"
    ])
});

/**
 * Explicit allowlist of approved upstream CDN/media domains from which
 * Reeva is permitted to stream media.
 */
const SUPPORTED_MEDIA_DOMAINS = Object.freeze([
    // Instagram / Meta CDN
    "cdninstagram.com",
    "fbcdn.net",
    "instagram.com",
    // Facebook CDN
    "facebook.com",
    // Twitter / X CDN
    "twimg.com",
    // Pinterest CDN
    "pinimg.com",
    // YouTube CDN
    "googlevideo.com",
    "ytimg.com"
]);

const MAX_URL_LENGTH = 2048;
const MAX_MEDIA_URL_LENGTH = 4096;

class ValidationError extends Error {
    constructor(message, code = "INVALID_INPUT") {
        super(message);
        this.name = "ValidationError";
        this.code = code;
    }
}

/**
 * Checks if a hostname matches an allowed domain or is a subdomain of an allowed domain.
 * Strictly prevents prefix tricks (e.g. evilinstagram.com) or suffix tricks (e.g. instagram.com.evil.com).
 *
 * @param {string} hostname - The hostname to check
 * @param {readonly string[]} allowedList - The list of permitted base domains
 * @returns {boolean}
 */
function isAllowedDomain(hostname, allowedList) {
    if (!hostname || typeof hostname !== "string") return false;

    const host = hostname.toLowerCase().trim().replace(/\.$/, ""); // remove trailing dot if any

    for (const allowed of allowedList) {
        const allowedClean = allowed.toLowerCase().trim().replace(/^\./, "");
        if (host === allowedClean || host.endsWith("." + allowedClean)) {
            return true;
        }
    }
    return false;
}

/**
 * Validates and normalizes platform identifier.
 *
 * @param {string} platform
 * @returns {string} Canonical platform identifier
 */
function validatePlatform(platform) {
    if (!platform || typeof platform !== "string") {
        throw new ValidationError("Platform is required.", "INVALID_PLATFORM");
    }

    const clean = platform.toLowerCase().trim();
    if (!Object.prototype.hasOwnProperty.call(SUPPORTED_SOURCE_DOMAINS, clean)) {
        throw new ValidationError(
            `Unsupported platform '${clean}'. Supported platforms: instagram, facebook, twitter, pinterest, youtube.`,
            "UNSUPPORTED_PLATFORM"
        );
    }

    return clean;
}

/**
 * Validates a user-supplied source URL for a specific platform.
 *
 * @param {string} rawUrl - The input URL from the user
 * @param {string} platform - The platform identifier
 * @returns {string} Clean, normalized URL string
 */
function validateSourceUrl(rawUrl, platform) {
    if (!rawUrl || typeof rawUrl !== "string") {
        throw new ValidationError("A URL is required.", "MISSING_URL");
    }

    const trimmed = rawUrl.trim();
    if (trimmed.length > MAX_URL_LENGTH) {
        throw new ValidationError(
            `URL exceeds maximum allowed length of ${MAX_URL_LENGTH} characters.`,
            "URL_TOO_LONG"
        );
    }

    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new ValidationError("Invalid URL format.", "MALFORMED_URL");
    }

    // Strictly enforce HTTPS protocol (reject http, file, ftp, gopher, javascript, data, etc.)
    if (parsed.protocol !== "https:") {
        throw new ValidationError(
            "Only secure HTTPS URLs are supported.",
            "UNSUPPORTED_PROTOCOL"
        );
    }

    // Disallow userinfo (e.g., https://user:pass@evil.com)
    if (parsed.username || parsed.password) {
        throw new ValidationError(
            "URLs containing credentials are not permitted.",
            "CREDENTIALS_IN_URL"
        );
    }

    // Disallow non-standard ports
    if (parsed.port && parsed.port !== "443") {
        throw new ValidationError(
            "Non-standard ports are not allowed.",
            "INVALID_PORT"
        );
    }

    // Verify hostname matches platform source domains
    const canonicalPlatform = validatePlatform(platform);
    const allowedHosts = SUPPORTED_SOURCE_DOMAINS[canonicalPlatform];

    if (!isAllowedDomain(parsed.hostname, allowedHosts)) {
        throw new ValidationError(
            `The URL hostname '${parsed.hostname}' is not a valid ${canonicalPlatform} link.`,
            "DISALLOWED_DOMAIN"
        );
    }

    return parsed.href;
}

/**
 * Validates an upstream media URL against the approved media CDN allowlist.
 *
 * @param {string} rawUrl - The upstream media URL
 * @returns {URL} Parsed WHATWG URL object
 */
function validateMediaUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") {
        throw new ValidationError("Media URL is required.", "MISSING_MEDIA_URL");
    }

    const trimmed = rawUrl.trim();
    if (trimmed.length > MAX_MEDIA_URL_LENGTH) {
        throw new ValidationError("Media URL exceeds maximum allowed length.", "URL_TOO_LONG");
    }

    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new ValidationError("Malformed media URL.", "MALFORMED_URL");
    }

    if (parsed.protocol !== "https:") {
        throw new ValidationError("Only HTTPS media URLs are permitted.", "UNSUPPORTED_PROTOCOL");
    }

    if (parsed.username || parsed.password) {
        throw new ValidationError("Media URLs with credentials are not permitted.", "CREDENTIALS_IN_URL");
    }

    if (parsed.port && parsed.port !== "443") {
        throw new ValidationError("Media URLs with non-standard ports are not allowed.", "INVALID_PORT");
    }

    if (!isAllowedDomain(parsed.hostname, SUPPORTED_MEDIA_DOMAINS)) {
        throw new ValidationError(
            `Media destination '${parsed.hostname}' is not an approved media CDN.`,
            "UNAPPROVED_MEDIA_DOMAIN"
        );
    }

    return parsed;
}

module.exports = {
    SUPPORTED_SOURCE_DOMAINS,
    SUPPORTED_MEDIA_DOMAINS,
    ValidationError,
    isAllowedDomain,
    validatePlatform,
    validateSourceUrl,
    validateMediaUrl
};
