// lib/embed/types.cjs — Embed Types and Sandboxing Utilities for Reeva
"use strict";

const EMBED_ERROR_CODES = Object.freeze({
    INVALID_URL: "INVALID_URL",
    UNSUPPORTED_PLATFORM: "UNSUPPORTED_PLATFORM",
    DISALLOWED_DOMAIN: "DISALLOWED_DOMAIN",
    EMBED_NOT_FOUND: "EMBED_NOT_FOUND",
    PRIVATE_CONTENT: "PRIVATE_CONTENT",
    PLATFORM_RESTRICTED: "PLATFORM_RESTRICTED",
    UPSTREAM_COMMUNICATION_ERROR: "UPSTREAM_COMMUNICATION_ERROR",
    MALFORMED_RESPONSE: "MALFORMED_RESPONSE",
    UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT"
});

class EmbedError extends Error {
    constructor(message, code = EMBED_ERROR_CODES.INVALID_URL, statusCode = 400, details = null) {
        super(message);
        this.name = "EmbedError";
        this.code = code;
        this.statusCode = statusCode;
        this.details = details;
    }
}

/**
 * Escapes arbitrary string to safe HTML entities.
 * Prevents XSS when rendering metadata into DOM or iframe attributes.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    if (!str || typeof str !== "string") return "";
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Builds a strictly sandboxed iframe element string.
 *
 * Security controls:
 * - sandbox="allow-scripts allow-same-origin allow-popups"
 * - Does NOT allow allow-top-navigation, allow-modals, or allow-forms.
 * - Enforces HTTPS URL with boundary check.
 * - Escapes all attributes.
 *
 * @param {string} src - The HTTPS embed URL
 * @param {object} options - Sizing and accessibility options
 * @returns {string}
 */
function buildSandboxedIframe(src, options = {}) {
    const {
        width = 400,
        height = 480,
        title = "Embedded Media Player",
        allow = "fullscreen; picture-in-picture"
    } = options;

    const safeSrc = escapeHtml(src);
    const safeTitle = escapeHtml(title);
    const safeAllow = escapeHtml(allow);
    const safeWidth = Number.isInteger(width) ? `${width}px` : escapeHtml(String(width));
    const safeHeight = Number.isInteger(height) ? `${height}px` : escapeHtml(String(height));

    return `<iframe src="${safeSrc}" width="${safeWidth}" height="${safeHeight}" frameborder="0" scrolling="no" allow="${safeAllow}" sandbox="allow-scripts allow-same-origin allow-popups" loading="lazy" title="${safeTitle}" style="border:none;max-width:100%;overflow:hidden"></iframe>`;
}

module.exports = {
    EMBED_ERROR_CODES,
    EmbedError,
    escapeHtml,
    buildSandboxedIframe
};
