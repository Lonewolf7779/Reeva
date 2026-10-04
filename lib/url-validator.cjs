// lib/url-validator.cjs — Centralized URL and Platform Validation for Reeva
"use strict";

const { URL } = require("url");
const net = require("net");
const { assertSafeDestination } = require("./ssrf-filter.cjs");

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
    if (clean === "generic" || clean === "more_sites") {
        return "generic";
    }

    if (!Object.prototype.hasOwnProperty.call(SUPPORTED_SOURCE_DOMAINS, clean)) {
        throw new ValidationError(
            `Unsupported platform '${clean}'. Supported platforms: instagram, facebook, twitter, pinterest, youtube, generic.`,
            "UNSUPPORTED_PLATFORM"
        );
    }

    return clean;
}

/**
 * Dedicated source URL validation path for generic / More Sites extraction.
 *
 * Enforces:
 * 1. String presence & maximum length (2048 chars)
 * 2. Valid URL syntax
 * 3. HTTPS scheme only (strictly reject http, file, ftp, javascript, etc.)
 * 4. Default port 443 only (reject non-standard ports to prevent port scanning)
 * 5. Reject userinfo/credentials in URL
 * 6. Reject IP literals (both IPv4 and IPv6)
 * 7. Reject localhost and local/internal domain suffixes (.local, .internal, .localhost, .lan, etc.)
 * 8. Reject specialized Reeva platform domains (Instagram, Facebook, Twitter, Pinterest, YouTube)
 *    and direct users to use the specialized downloader
 * 9. DNS pre-flight verification via assertSafeDestination to reject private/loopback/metadata IPs
 *
 * @param {string} rawUrl - The input URL from the user
 * @returns {Promise<string>} Clean, normalized HTTPS URL string
 */
async function validateGenericSourceUrl(rawUrl) {
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

    if (/\s/.test(trimmed)) {
        throw new ValidationError("URLs cannot contain whitespace.", "MALFORMED_URL");
    }

    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new ValidationError("Invalid URL format.", "MALFORMED_URL");
    }

    if (parsed.protocol !== "https:") {
        throw new ValidationError(
            "Only secure HTTPS URLs are supported.",
            "UNSUPPORTED_PROTOCOL"
        );
    }

    if (parsed.username || parsed.password) {
        throw new ValidationError(
            "URLs containing credentials are not permitted.",
            "CREDENTIALS_IN_URL"
        );
    }

    if (parsed.port && parsed.port !== "443") {
        throw new ValidationError(
            "Non-standard ports are not allowed.",
            "INVALID_PORT"
        );
    }

    const hostname = parsed.hostname.toLowerCase().trim().replace(/\.$/, "");
    if (!hostname) {
        throw new ValidationError("Invalid hostname in URL.", "MALFORMED_URL");
    }

    // Strip square brackets for IPv6 literals before checking net.isIP
    const rawHost = hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(rawHost)) {
        throw new ValidationError(
            "Direct IP addresses are not permitted as generic source URLs.",
            "DISALLOWED_DOMAIN"
        );
    }

    // Reject localhost and local/internal top-level domains
    const forbiddenSuffixes = [
        ".localhost",
        ".local",
        ".internal",
        ".lan",
        ".home",
        ".corp",
        ".onion"
    ];
    if (hostname === "localhost" || forbiddenSuffixes.some(s => hostname.endsWith(s))) {
        throw new ValidationError(
            "Local or internal domain names are not permitted.",
            "DISALLOWED_DOMAIN"
        );
    }

    // Reject specialized platform domains and direct caller to the dedicated downloader
    const specializedPlatforms = ["instagram", "facebook", "twitter", "x", "pinterest", "youtube"];
    for (const p of specializedPlatforms) {
        if (isAllowedDomain(hostname, SUPPORTED_SOURCE_DOMAINS[p])) {
            let displayName = p.charAt(0).toUpperCase() + p.slice(1);
            if (p === "twitter" || p === "x") displayName = "Twitter (X)";
            if (p === "youtube") displayName = "YouTube";

            throw new ValidationError(
                `This URL belongs to ${displayName}. Please use the dedicated ${displayName} downloader.`,
                "USE_SPECIALIZED_PLATFORM"
            );
        }
    }

    // DNS Pre-flight check using authoritative SSRF filter
    await assertSafeDestination(hostname);

    return parsed.href;
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
    validateGenericSourceUrl,
    validateMediaUrl
};
