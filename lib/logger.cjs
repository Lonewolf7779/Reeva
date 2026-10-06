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
 * Redacts query parameters, user credentials, and hash fragments from URLs before logging.
 *
 * @param {string|null} rawUrl
 * @returns {string} Safe redacted URL (e.g. "https://instagram.com/p/ABC1234/?<query-redacted>")
 */
function redactUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return "[none]";

    const trimmed = rawUrl.trim();
    // Reject URLs with control characters or newlines
    if (/[\x00-\x1F\x7F-\x9F]/.test(trimmed)) {
        return "[invalid-url]";
    }

    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return "[invalid-url]";
        }
        const hasQuery = parsed.search.length > 0;
        // parsed.host preserves hostname and non-standard port, while omitting username/password
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}${hasQuery ? "?[redacted]" : ""}`;
    } catch {
        return "[invalid-url]";
    }
}

/**
 * Sanitizes and bounds an error/status code for safe structured logging.
 *
 * @param {any} rawCode
 * @param {number} [maxLength=64]
 * @returns {string|null}
 */
function sanitizeCode(rawCode, maxLength = 64) {
    if (rawCode === null || rawCode === undefined) return null;
    let str = "";
    if (typeof rawCode === "string") {
        str = rawCode.trim();
    } else if (typeof rawCode === "number") {
        str = String(rawCode);
    } else if (rawCode instanceof Error) {
        str = String(rawCode.code || rawCode.name || "ERROR").trim();
    } else {
        return "UNKNOWN_ERROR";
    }

    // Replace unapproved characters, control chars, and whitespace with underscore
    const sanitized = str.replace(/[^a-zA-Z0-9_\-.]/g, "_");
    if (!sanitized) return "UNKNOWN_ERROR";

    return sanitized.length > maxLength ? sanitized.slice(0, maxLength) : sanitized;
}

/**
 * Sanitizes an identifier (platform, operation, status).
 *
 * @param {any} val
 * @param {number} [maxLength=32]
 * @returns {string|null}
 */
function sanitizeIdentifier(val, maxLength = 32) {
    if (typeof val !== "string" && typeof val !== "number") return null;
    const str = String(val).trim().replace(/[^a-zA-Z0-9_\-]/g, "");
    if (!str) return null;
    return str.slice(0, maxLength);
}

/**
 * Sanitizes a request correlation ID.
 *
 * @param {any} val
 * @returns {string|null}
 */
function sanitizeRequestId(val) {
    if (typeof val !== "string") return null;
    const str = val.trim();
    if (/^[a-zA-Z0-9_\-]{8,64}$/.test(str)) {
        return str;
    }
    return null;
}

/**
 * Sanitizes and bounds a log message to prevent log injection and credential leakage.
 *
 * @param {any} rawMessage
 * @param {number} [maxLength=256]
 * @returns {string}
 */
function sanitizeMessage(rawMessage, maxLength = 256) {
    if (rawMessage === null || rawMessage === undefined) return "";
    let str = "";
    if (typeof rawMessage === "string") {
        str = rawMessage;
    } else if (typeof rawMessage === "number" || typeof rawMessage === "boolean") {
        str = String(rawMessage);
    } else if (rawMessage instanceof Error) {
        str = rawMessage.message || rawMessage.name || "Error";
    } else {
        return "[object]";
    }

    // Redact embedded URLs with query parameters
    str = str.replace(/https?:\/\/[^\s"'<>]+/gi, (matchedUrl) => redactUrl(matchedUrl));

    // Normalize newlines, carriage returns, and tabs to single spaces
    str = str.replace(/[\r\n\t]+/g, " ");

    // Remove non-printable control characters (\x00-\x1F, \x7F-\x9F)
    str = str.replace(/[\x00-\x1F\x7F-\x9F]/g, "");

    // Collapse multiple consecutive spaces and trim
    str = str.replace(/\s{2,}/g, " ").trim();

    // Bound maximum length
    if (str.length > maxLength) {
        str = str.slice(0, maxLength) + "...[truncated]";
    }

    // Escape double quotes for structured string format
    return str.replace(/"/g, '\\"');
}

/**
 * Formats a metadata object into a structured key=value log line.
 * Uses strict key whitelisting and sanitization to prevent arbitrary object serialization.
 *
 * @param {string} level - INFO, WARN, ERROR
 * @param {object} meta
 * @returns {string}
 */
function formatLog(level, meta = {}) {
    const safeLevel = ["INFO", "WARN", "ERROR"].includes(level) ? level : "INFO";
    const timestamp = new Date().toISOString();
    const parts = [`[${safeLevel}]`, timestamp];

    if (meta && typeof meta === "object") {
        const safeReqId = sanitizeRequestId(meta.requestId);
        if (safeReqId) parts.push(`requestId=${safeReqId}`);

        const safePlatform = sanitizeIdentifier(meta.platform, 32);
        if (safePlatform) parts.push(`platform=${safePlatform}`);

        const safeOperation = sanitizeIdentifier(meta.operation, 32);
        if (safeOperation) parts.push(`operation=${safeOperation}`);

        const safeStatus = sanitizeIdentifier(meta.status, 32);
        if (safeStatus) parts.push(`status=${safeStatus}`);

        const safeCode = sanitizeCode(meta.code);
        if (safeCode) parts.push(`code=${safeCode}`);

        if (typeof meta.durationMs === "number" && Number.isFinite(meta.durationMs)) {
            parts.push(`durationMs=${Math.max(0, Math.round(meta.durationMs))}`);
        }

        if (meta.clientIp) {
            const safeIp = String(meta.clientIp).replace(/[^a-fA-F0-9:.]/g, "").slice(0, 45);
            if (safeIp) parts.push(`clientIp=${safeIp}`);
        }

        if (meta.url) {
            parts.push(`url=${redactUrl(meta.url)}`);
        }

        if (meta.message !== undefined && meta.message !== null) {
            const sanitizedMsg = sanitizeMessage(meta.message);
            if (sanitizedMsg.length > 0) {
                parts.push(`message="${sanitizedMsg}"`);
            }
        }
    }

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
    if (incoming && typeof incoming === "string" && /^[a-zA-Z0-9_\-]{8,64}$/.test(incoming.trim())) {
        req.id = incoming.trim();
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
    sanitizeCode,
    sanitizeIdentifier,
    sanitizeRequestId,
    sanitizeMessage,
    formatLog,
    logger,
    requestIdMiddleware
};
