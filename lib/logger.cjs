// lib/logger.cjs — Privacy-Preserving Structured Logging and Request Correlation
"use strict";

const crypto = require("crypto");
const { URL } = require("url");

/**
 * Generates an opaque request correlation ID.
 * @returns {string}
 */
function generateRequestId() {
    return "req_" + crypto.randomBytes(8).toString("hex");
}

/**
 * Redacts query parameters and sensitive tokens from URLs before logging.
 *
 * @param {string|null} rawUrl
 * @returns {string} Safe redacted URL (e.g. "https://instagram.com/p/ABC1234/?<query-redacted>")
 */
function redactUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return "[none]";

    try {
        const parsed = new URL(rawUrl.trim());
        const hasQuery = parsed.search.length > 0;
        return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}${hasQuery ? "?[redacted]" : ""}`;
    } catch {
        return "[invalid-url]";
    }
}

/**
 * Formats a metadata object into a structured key=value log line.
 *
 * @param {string} level - INFO, WARN, ERROR
 * @param {object} meta
 * @returns {string}
 */
function formatLog(level, meta = {}) {
    const timestamp = new Date().toISOString();
    const parts = [`[${level}]`, timestamp];

    if (meta.requestId) parts.push(`requestId=${meta.requestId}`);
    if (meta.platform) parts.push(`platform=${meta.platform}`);
    if (meta.operation) parts.push(`operation=${meta.operation}`);
    if (meta.status) parts.push(`status=${meta.status}`);
    if (typeof meta.durationMs === "number") parts.push(`durationMs=${meta.durationMs}`);
    if (meta.url) parts.push(`url=${redactUrl(meta.url)}`);
    if (meta.message) parts.push(`message="${String(meta.message).replace(/"/g, '\\"')}"`);

    return parts.join(" ");
}

const logger = {
    info: (meta) => console.log(formatLog("INFO", meta)),
    warn: (meta) => console.warn(formatLog("WARN", meta)),
    error: (meta) => console.error(formatLog("ERROR", meta))
};

/**
 * Express middleware to attach and return a unique request ID.
 */
function requestIdMiddleware(req, res, next) {
    const incoming = req.headers["x-request-id"];
    // Sanitize incoming request ID to prevent header/log injection
    if (incoming && typeof incoming === "string" && /^[a-zA-Z0-9_\-]{8,64}$/.test(incoming)) {
        req.id = incoming;
    } else {
        req.id = generateRequestId();
    }

    res.setHeader("X-Request-Id", req.id);
    req._startTime = Date.now();
    next();
}

module.exports = {
    generateRequestId,
    redactUrl,
    formatLog,
    logger,
    requestIdMiddleware
};
