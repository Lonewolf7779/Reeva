// lib/http-client.cjs — Hardened HTTP Client with SSRF, Redirect, and Size Controls
"use strict";

const https = require("https");
const http = require("http");
const { URL } = require("url");
const { Transform } = require("stream");
const fetch = require("node-fetch");
const { safeLookup, SSRFError, isPrivateOrBlockedIP } = require("./ssrf-filter.cjs");
const { isAllowedDomain, ValidationError } = require("./url-validator.cjs");

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_HEADERS_TIMEOUT_MS = 5000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_MEDIA_BYTES = 250 * 1024 * 1024; // 250 MB
const DEFAULT_MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB

const PERMITTED_MEDIA_CONTENT_TYPES = Object.freeze([
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/x-m4v",
    "video/3gpp",
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
    "application/octet-stream"
]);

// Dedicated agents with DNS validation pinned at socket connection time
const secureHttpsAgent = new https.Agent({
    lookup: safeLookup,
    keepAlive: true,
    keepAliveMsecs: 5000,
    maxSockets: 50,
    timeout: DEFAULT_TIMEOUT_MS
});

const secureHttpAgent = new http.Agent({
    lookup: safeLookup,
    keepAlive: true,
    keepAliveMsecs: 5000,
    maxSockets: 50,
    timeout: DEFAULT_TIMEOUT_MS
});

class SecurityHTTPError extends Error {
    constructor(message, statusCode = 500, code = "SECURITY_HTTP_ERROR") {
        super(message);
        this.name = "SecurityHTTPError";
        this.statusCode = statusCode;
        this.code = code;
    }
}

class ResponseTooLargeError extends SecurityHTTPError {
    constructor(message = "Response size exceeds maximum permitted limit.") {
        super(message, 413, "RESPONSE_TOO_LARGE");
    }
}

/**
 * A Transform stream that counts bytes in transit and terminates
 * immediately if the byte limit is exceeded.
 */
class StreamMeter extends Transform {
    constructor(maxBytes, onLimitExceeded) {
        super();
        this.maxBytes = maxBytes;
        this.bytesRead = 0;
        this.onLimitExceeded = onLimitExceeded;
    }

    _transform(chunk, encoding, callback) {
        this.bytesRead += chunk.length;
        if (this.bytesRead > this.maxBytes) {
            const err = new ResponseTooLargeError(
                `Maximum streaming size of ${this.maxBytes} bytes exceeded.`
            );
            if (typeof this.onLimitExceeded === "function") {
                try { this.onLimitExceeded(); } catch { }
            }
            return callback(err);
        }
        callback(null, chunk);
    }
}

/**
 * Validates Content-Type header against expected media types.
 *
 * @param {string|null} contentTypeHeader
 * @returns {boolean}
 */
function isPermittedMediaContentType(contentTypeHeader) {
    if (!contentTypeHeader) return false;
    const cleanType = contentTypeHeader.split(";")[0].trim().toLowerCase();

    // Explicitly reject active executable/script types
    if (
        cleanType.includes("html") ||
        cleanType.includes("javascript") ||
        cleanType.includes("json") ||
        cleanType.includes("xml") ||
        cleanType.includes("script") ||
        cleanType.includes("php")
    ) {
        return false;
    }

    return PERMITTED_MEDIA_CONTENT_TYPES.includes(cleanType);
}

/**
 * Secure HTTP fetch wrapper.
 * Enforces:
 * 1. Strict URL validation
 * 2. DNS rebinding & private IP blocking on every hop
 * 3. Controlled redirects with domain re-validation
 * 4. Overall & connection timeouts via AbortController
 * 5. Pre-flight Content-Length check
 * 6. Streaming byte limit
 *
 * @param {string} initialUrl
 * @param {object} options
 * @returns {Promise<{ response: object, finalUrl: string, abort: Function }>}
 */
async function secureFetch(initialUrl, options = {}) {
    const {
        allowedDomains,
        maxRedirects = DEFAULT_MAX_REDIRECTS,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxSizeBytes = DEFAULT_MAX_MEDIA_BYTES,
        headers = {},
        method = "GET"
    } = options;

    if (!allowedDomains || !Array.isArray(allowedDomains) || allowedDomains.length === 0) {
        throw new SecurityHTTPError("Allowed domains must be explicitly defined.", 500, "MISSING_ALLOWLIST");
    }

    let currentUrl = initialUrl;
    let redirectCount = 0;

    while (redirectCount <= maxRedirects) {
        // Parse and validate current URL
        let parsed;
        try {
            parsed = new URL(currentUrl);
        } catch {
            throw new SecurityHTTPError("Malformed URL during request.", 400, "MALFORMED_URL");
        }

        if (parsed.protocol !== "https:") {
            throw new SecurityHTTPError(
                `Protocol '${parsed.protocol}' is forbidden. Only HTTPS is permitted.`,
                403,
                "FORBIDDEN_PROTOCOL"
            );
        }

        if (parsed.username || parsed.password) {
            throw new SecurityHTTPError("Credentials in request URLs are forbidden.", 403, "CREDENTIALS_FORBIDDEN");
        }

        if (parsed.port && parsed.port !== "443") {
            throw new SecurityHTTPError("Non-standard ports are forbidden.", 403, "FORBIDDEN_PORT");
        }

        // Domain allowlist check on EVERY hop
        if (!isAllowedDomain(parsed.hostname, allowedDomains)) {
            throw new SecurityHTTPError(
                `Destination host '${parsed.hostname}' is not in the approved allowlist.`,
                403,
                "DISALLOWED_DESTINATION"
            );
        }

        // Set up AbortController for total request timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        try {
            const agent = parsed.protocol === "https:" ? secureHttpsAgent : secureHttpAgent;

            const resp = await fetch(currentUrl, {
                method,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 (ReevaSecureBot)",
                    "Accept": "*/*",
                    ...headers
                },
                redirect: "manual", // ALWAYS handle redirects manually
                agent,
                signal: controller.signal
            });

            // Handle HTTP Redirects (301, 302, 303, 307, 308)
            if ([301, 302, 303, 307, 308].includes(resp.status)) {
                clearTimeout(timeoutId);
                redirectCount++;

                if (redirectCount > maxRedirects) {
                    throw new SecurityHTTPError(
                        `Maximum redirect limit (${maxRedirects}) exceeded.`,
                        400,
                        "TOO_MANY_REDIRECTS"
                    );
                }

                const locationHeader = resp.headers.get("location");
                if (!locationHeader) {
                    throw new SecurityHTTPError("Redirect response missing Location header.", 502, "BAD_REDIRECT");
                }

                // Resolve target relative to current URL
                let targetUrl;
                try {
                    targetUrl = new URL(locationHeader, currentUrl).href;
                } catch {
                    throw new SecurityHTTPError("Invalid redirect Location header.", 502, "BAD_REDIRECT_LOCATION");
                }

                currentUrl = targetUrl;
                continue; // Process next redirect hop
            }

            // Inspect Content-Length upfront
            const contentLengthHeader = resp.headers.get("content-length");
            if (contentLengthHeader) {
                const contentLength = parseInt(contentLengthHeader, 10);
                if (!isNaN(contentLength) && contentLength > maxSizeBytes) {
                    clearTimeout(timeoutId);
                    controller.abort();
                    throw new ResponseTooLargeError(
                        `Content length (${contentLength} bytes) exceeds maximum permitted limit (${maxSizeBytes} bytes).`
                    );
                }
            }

            // Success
            return {
                response: resp,
                finalUrl: currentUrl,
                abort: () => {
                    clearTimeout(timeoutId);
                    controller.abort();
                },
                clearTimeout: () => clearTimeout(timeoutId)
            };

        } catch (err) {
            clearTimeout(timeoutId);

            if (err.name === "AbortError" || controller.signal.aborted) {
                throw new SecurityHTTPError(`Request timed out after ${timeoutMs}ms.`, 504, "TIMEOUT");
            }
            if (err instanceof SecurityHTTPError || err instanceof SSRFError || err instanceof ValidationError) {
                throw err;
            }

            throw new SecurityHTTPError(
                "Upstream communication failure.",
                502,
                "UPSTREAM_COMMUNICATION_ERROR"
            );
        }
    }

    throw new SecurityHTTPError("Exceeded redirect attempts.", 400, "TOO_MANY_REDIRECTS");
}

/**
 * Reads a stream up to maxBytes. If exceeded, destroys stream, aborts upstream,
 * releases memory, and rejects with ResponseTooLargeError.
 *
 * @param {ReadableStream} stream
 * @param {number} maxBytes
 * @param {Function} [abortFn]
 * @returns {Promise<string>}
 */
function readStreamWithLimit(stream, maxBytes, abortFn) {
    return new Promise((resolve, reject) => {
        if (!stream) {
            return reject(new SecurityHTTPError("No response stream available to read.", 502));
        }

        let bytesRead = 0;
        const chunks = [];
        let destroyed = false;

        const cleanup = () => {
            stream.removeListener("data", onData);
            stream.removeListener("end", onEnd);
            stream.removeListener("error", onError);
        };

        const onData = (chunk) => {
            bytesRead += chunk.length;
            if (bytesRead > maxBytes) {
                destroyed = true;
                cleanup();
                if (typeof abortFn === "function") {
                    try { abortFn(); } catch { }
                }
                if (typeof stream.destroy === "function") {
                    try { stream.destroy(); } catch { }
                }
                chunks.length = 0; // Immediately release buffer memory
                return reject(new ResponseTooLargeError(
                    `HTML response exceeded maximum permitted size of ${maxBytes} bytes.`
                ));
            }
            chunks.push(chunk);
        };

        const onEnd = () => {
            if (destroyed) return;
            cleanup();
            resolve(Buffer.concat(chunks).toString("utf8"));
        };

        const onError = (err) => {
            if (destroyed) return;
            cleanup();
            chunks.length = 0;
            reject(err);
        };

        stream.on("data", onData);
        stream.on("end", onEnd);
        stream.on("error", onError);
    });
}

/**
 * Helper to securely fetch an HTML page (e.g. for metadata extraction).
 * Enforces:
 * 1. Pre-flight Content-Length check
 * 2. Real-time byte count during stream consumption (for chunked/absent/lying headers)
 * 3. Immediate upstream abort and memory release on threshold breach
 *
 * @param {string} url
 * @param {string[]} allowedDomains
 * @param {number} [maxBytes=DEFAULT_MAX_HTML_BYTES]
 * @returns {Promise<string>}
 */
async function secureFetchHtml(url, allowedDomains, maxBytes = DEFAULT_MAX_HTML_BYTES) {
    const { response, abort, clearTimeout: clearTimer } = await secureFetch(url, {
        allowedDomains,
        maxSizeBytes: maxBytes,
        maxRedirects: 2,
        timeoutMs: 8000
    });

    try {
        if (!response.ok) {
            throw new SecurityHTTPError(`Failed to load page (${response.status})`, response.status);
        }
        const text = await readStreamWithLimit(response.body, maxBytes, abort);
        return text;
    } finally {
        clearTimer();
    }
}

module.exports = {
    DEFAULT_MAX_MEDIA_BYTES,
    DEFAULT_MAX_HTML_BYTES,
    PERMITTED_MEDIA_CONTENT_TYPES,
    SecurityHTTPError,
    ResponseTooLargeError,
    StreamMeter,
    readStreamWithLimit,
    isPermittedMediaContentType,
    secureFetch,
    secureFetchHtml
};

