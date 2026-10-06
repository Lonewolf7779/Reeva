// lib/config.cjs — Centralized Server Configuration Parsing and Validation
"use strict";

const proxyaddr = require("proxy-addr");

class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = "ConfigError";
    }
}

/**
 * Strictly parses and validates the TRUST_PROXY configuration value.
 *
 * Supported values:
 * - unset / empty / undefined -> false (direct Internet traffic, no proxy trusted)
 * - "false" / false / "0" -> false
 * - "true" / true -> boolean true (trusted reverse proxy where all hops are trusted)
 * - positive integer string (e.g. "1", "2") -> parsed integer (exact number of trusted upstream proxy hops)
 * - valid Express subnet / CIDR / IP string (e.g. 'loopback', '10.0.0.0/8', 'linklocal') -> validated string
 *
 * @param {string|boolean|number|undefined} raw
 * @returns {boolean|number|string} Validated Express trust proxy setting
 * @throws {ConfigError} If an invalid or unparseable proxy configuration is supplied
 */
function parseTrustProxy(raw) {
    if (raw === undefined || raw === null || raw === "") {
        return false;
    }

    if (typeof raw === "boolean") {
        return raw;
    }

    if (typeof raw === "number") {
        if (Number.isInteger(raw) && raw >= 0) {
            return raw === 0 ? false : raw;
        }
        throw new ConfigError(`Invalid TRUST_PROXY numeric value: ${raw}. Must be a non-negative integer.`);
    }

    if (typeof raw !== "string") {
        throw new ConfigError("Invalid TRUST_PROXY configuration: value must be a string, number, or boolean.");
    }

    const trimmed = raw.trim();
    const lower = trimmed.toLowerCase();

    if (lower === "false" || lower === "0") {
        return false;
    }

    if (lower === "true") {
        return true;
    }

    // Positive integer string (hop count)
    if (/^\d+$/.test(trimmed)) {
        const hopCount = parseInt(trimmed, 10);
        if (hopCount === 0) return false;
        return hopCount;
    }

    // Subnet name, CIDR, or comma-separated IP/subnet list
    try {
        // proxyaddr.compile will throw if any entry is not a recognized built-in name or valid IP/CIDR
        proxyaddr.compile(trimmed);
        return trimmed;
    } catch (_) {
        throw new ConfigError(
            `Invalid TRUST_PROXY configuration: "${trimmed}". ` +
            `Accepted values are: false, 0, positive integer hop count (e.g. 1, 2), ` +
            `valid subnet/CIDR/IP (e.g. 'loopback', '10.0.0.0/8'), or true.`
        );
    }
}

/**
 * Validates a positive integer configuration value within an optional range.
 *
 * @param {string|undefined} raw
 * @param {number} defaultValue
 * @param {string} paramName
 * @param {number} [min=1]
 * @param {number} [max=Infinity]
 * @returns {number}
 */
function validatePositiveInteger(raw, defaultValue, paramName, min = 1, max = Infinity) {
    if (raw === undefined || raw === null || raw === "") {
        return defaultValue;
    }

    const val = Number(raw);
    if (!Number.isInteger(val) || !Number.isFinite(val) || val < min || val > max) {
        throw new ConfigError(
            `Invalid ${paramName}: "${raw}". Must be an integer between ${min} and ${max === Infinity ? "Infinity" : max}.`
        );
    }

    return val;
}

/**
 * Preflight validation of all server environment configuration.
 * Fails fast with clear operator-facing error messages on invalid input.
 *
 * @param {object} [env=process.env]
 * @returns {object} Validated configuration dictionary
 */
function validateServerConfig(env = process.env) {
    const port = validatePositiveInteger(env.PORT, 3000, "PORT", 1, 65535);
    const maxMediaSizeBytes = validatePositiveInteger(
        env.MAX_MEDIA_SIZE_BYTES,
        262144000, // 250 MB
        "MAX_MEDIA_SIZE_BYTES",
        1024, // 1 KB min
        1073741824 // 1 GB max
    );
    const shutdownTimeoutMs = validatePositiveInteger(
        env.SHUTDOWN_TIMEOUT_MS,
        10000, // 10s
        "SHUTDOWN_TIMEOUT_MS",
        1000, // 1s min
        60000 // 60s max
    );

    const trustProxy = parseTrustProxy(env.TRUST_PROXY);

    const rateLimitGeneralMax = validatePositiveInteger(env.RATE_LIMIT_GENERAL_MAX, 100, "RATE_LIMIT_GENERAL_MAX", 1);
    const rateLimitExtractionMax = validatePositiveInteger(env.RATE_LIMIT_EXTRACTION_MAX, 15, "RATE_LIMIT_EXTRACTION_MAX", 1);
    const rateLimitMediaMax = validatePositiveInteger(env.RATE_LIMIT_MEDIA_MAX, 30, "RATE_LIMIT_MEDIA_MAX", 1);

    const maxGlobalExtractionConcurrency = validatePositiveInteger(
        env.MAX_GLOBAL_EXTRACTION_CONCURRENCY || env.MAX_GLOBAL_CONCURRENCY,
        30,
        "MAX_GLOBAL_EXTRACTION_CONCURRENCY",
        1,
        1000
    );
    const maxIpExtractionConcurrency = validatePositiveInteger(
        env.MAX_IP_EXTRACTION_CONCURRENCY || env.MAX_IP_CONCURRENCY,
        3,
        "MAX_IP_EXTRACTION_CONCURRENCY",
        1,
        100
    );
    const maxGlobalStreamConcurrency = validatePositiveInteger(
        env.MAX_GLOBAL_STREAM_CONCURRENCY,
        50,
        "MAX_GLOBAL_STREAM_CONCURRENCY",
        1,
        1000
    );
    const maxIpStreamConcurrency = validatePositiveInteger(
        env.MAX_IP_STREAM_CONCURRENCY,
        5,
        "MAX_IP_STREAM_CONCURRENCY",
        1,
        100
    );

    return {
        port,
        maxMediaSizeBytes,
        shutdownTimeoutMs,
        trustProxy,
        rateLimitGeneralMax,
        rateLimitExtractionMax,
        rateLimitMediaMax,
        maxGlobalExtractionConcurrency,
        maxIpExtractionConcurrency,
        maxGlobalStreamConcurrency,
        maxIpStreamConcurrency
    };
}

module.exports = {
    ConfigError,
    parseTrustProxy,
    validatePositiveInteger,
    validateServerConfig
};
