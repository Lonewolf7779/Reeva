// server.cjs — Reeva Hardened Multi-Platform Media Downloader Backend
"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const {
    SUPPORTED_MEDIA_DOMAINS,
    ValidationError
} = require("./lib/url-validator.cjs");

const { SSRFError } = require("./lib/ssrf-filter.cjs");

const {
    DEFAULT_MAX_MEDIA_BYTES,
    SecurityHTTPError,
    StreamMeter,
    isPermittedMediaContentType,
    secureFetch,
    destroyHttpAgents
} = require("./lib/http-client.cjs");

const { defaultRegistry } = require("./lib/media-registry.cjs");
const { createConcurrencyLimiter } = require("./lib/concurrency-limiter.cjs");
const { logger, requestIdMiddleware } = require("./lib/logger.cjs");
const { extractMedia, ExtractionError } = require("./lib/extraction/index.cjs");
const { EXTRACTION_ERROR_CODES, DEFAULT_ERROR_MESSAGES } = require("./lib/extraction/types.cjs");
const { REEVA_TEMP_DIR, cleanStaleTempFiles } = require("./lib/extraction/adapters/youtube.cjs");
const { stopDefaultEgressProxy } = require("./lib/extraction/egress-proxy.cjs");

// Clean stale temporary media artifacts on server startup
cleanStaleTempFiles().catch((err) => {
    logger.error({ message: `Error cleaning temporary files on startup: ${err.message}` });
});
// Periodic sweep of stale temporary artifacts every 15 minutes
const staleCleanupInterval = setInterval(() => {
    cleanStaleTempFiles().catch((err) => {
        logger.error({ message: `Error cleaning temporary files during periodic sweep: ${err.message}` });
    });
}, 15 * 60 * 1000);
if (staleCleanupInterval && staleCleanupInterval.unref) {
    staleCleanupInterval.unref();
}

const { validateServerConfig, validateProductionPreflight, ConfigError } = require("./lib/config.cjs");

// Validate server configuration fail-fast on startup
const serverConfig = validateServerConfig(process.env);
const PORT = serverConfig.port;

// Server lifecycle tracking state
let isShuttingDown = false;
let isPreflightComplete = false;
let activeServer = null;
let shutdownPromise = null;
const activeExtractionControllers = new Set();
const activeStreamControllers = new Set();

const app = express();

// ================== PRODUCTION CONFIGURATION ==================
// Set strictly validated proxy trust setting (defaults to false)
app.set("trust proxy", serverConfig.trustProxy);

// Disable Express fingerprinting header
app.disable("x-powered-by");

// ================== SECURITY HEADERS ==================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "blob:"],
            mediaSrc: ["'self'", "blob:"],
            connectSrc: ["'self'"],
            frameAncestors: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    xContentTypeOptions: true,
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    }
}));

// Additional explicit security headers
app.use((req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    next();
});

// Request correlation ID middleware
app.use(requestIdMiddleware);

// ================== LIVENESS & READINESS PROBES ==================
// Mounted before rate limiters and static assets to ensure container orchestrator probes
// are never throttled or blocked by general rate limiters.
app.get("/health", (req, res) => {
    res.status(200).json({
        status: "ok",
        timestamp: new Date().toISOString()
    });
});

app.get("/ready", (req, res) => {
    if (isShuttingDown) {
        return res.status(503).json({
            status: "shutting_down",
            message: "Server is shutting down and not accepting new traffic."
        });
    }
    if (process.env.NODE_ENV === "production" && !isPreflightComplete) {
        return res.status(503).json({
            status: "initializing",
            message: "Server production preflight has not yet completed."
        });
    }
    return res.status(200).json({
        status: "ready"
    });
});

// Static assets
app.use(express.static("public", {
    maxAge: "1d",
    etag: true,
    dotfiles: "ignore"
}));

// ================== RATE LIMITERS ==================
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: serverConfig.rateLimitGeneralMax,
    standardHeaders: true,
    legacyHeaders: false,
    ipv6Subnet: 56,
    message: {
        error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many requests. Please wait a few minutes and try again."
        }
    }
});
app.use(generalLimiter);

const extractionLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    limit: serverConfig.rateLimitExtractionMax,
    standardHeaders: true,
    legacyHeaders: false,
    ipv6Subnet: 56,
    message: {
        error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many extraction requests. Please wait a minute and try again."
        }
    }
});

const mediaStreamLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    limit: serverConfig.rateLimitMediaMax,
    standardHeaders: true,
    legacyHeaders: false,
    ipv6Subnet: 56,
    message: {
        error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many media download requests. Please wait a few minutes."
        }
    }
});

// Concurrency limiter for expensive extraction operations
const extractionConcurrencyLimiter = createConcurrencyLimiter({
    maxGlobal: serverConfig.maxGlobalExtractionConcurrency,
    maxPerIp: serverConfig.maxIpExtractionConcurrency
});

// Dedicated concurrency limiter for media streaming operations to prevent streaming from starving extraction
const mediaStreamConcurrencyLimiter = createConcurrencyLimiter({
    maxGlobal: serverConfig.maxGlobalStreamConcurrency,
    maxPerIp: serverConfig.maxIpStreamConcurrency
});

// ================== METHOD ENFORCEMENT ==================
// Reject non-GET HTTP methods cleanly on API endpoints
app.use("/api", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
        return res.status(405).json({
            error: {
                code: "METHOD_NOT_ALLOWED",
                message: `HTTP method ${req.method} is not permitted.`
            },
            requestId: req.id
        });
    }
    next();
});

// ================== ERROR SANITIZATION ==================
const VALIDATION_ERROR_MESSAGES = Object.freeze({
    MISSING_URL: "Please paste a video link first.",
    INVALID_PLATFORM: "Platform is required.",
    UNSUPPORTED_PLATFORM: "Unsupported platform. Supported platforms: instagram, facebook, twitter, pinterest, youtube, tiktok, generic.",
    URL_TOO_LONG: "The supplied URL exceeds the maximum permitted length.",
    MALFORMED_URL: "Invalid URL format. Please provide a well-formed URL.",
    UNSUPPORTED_PROTOCOL: "Only secure HTTPS URLs are supported.",
    CREDENTIALS_IN_URL: "URLs containing credentials are not permitted.",
    INVALID_PORT: "Non-standard ports are not allowed.",
    DISALLOWED_DOMAIN: "The provided URL domain is not permitted or does not match the requested platform.",
    USE_SPECIALIZED_PLATFORM: "This URL belongs to a specialized platform (such as YouTube, Instagram, or TikTok). Please use the dedicated platform downloader.",
    MISSING_MEDIA_URL: "Media URL is required.",
    UNAPPROVED_MEDIA_DOMAIN: "The media destination is not an approved media CDN.",
    INVALID_INPUT: "Invalid request parameters.",
    VALIDATION_FAILED: "Invalid request parameters."
});

const SECURITY_ERROR_MESSAGES = Object.freeze({
    RESPONSE_TOO_LARGE: "Response size exceeds maximum permitted limit.",
    CLIENT_ABORTED: "Request aborted by client.",
    TIMEOUT: "Request timed out.",
    DISALLOWED_DESTINATION: "Destination is not permitted.",
    MALFORMED_URL: "Invalid request URL.",
    CREDENTIALS_FORBIDDEN: "Credentials in request URLs are forbidden.",
    FORBIDDEN_PORT: "Non-standard ports are forbidden.",
    FORBIDDEN_PROTOCOL: "Only secure HTTPS URLs are supported.",
    UPSTREAM_COMMUNICATION_ERROR: "Upstream communication failure.",
    TOO_MANY_REDIRECTS: "Too many redirects encountered.",
    BAD_REDIRECT: "Invalid redirect response.",
    BAD_REDIRECT_LOCATION: "Invalid redirect location.",
    SECURITY_HTTP_ERROR: "Security policy violation."
});

/**
 * Detects whether an error message or identifier contains sensitive diagnostics such as:
 * - Local filesystem paths (Windows drive letters, UNC shares, POSIX root paths, relative paths)
 * - Internal or literal IP addresses (IPv4 loopback/private/link-local/literals, IPv6 loopback/link-local/literals)
 * - Raw Node.js or OS system exception codes (ENOENT, EACCES, ECONNREFUSED, ENOTFOUND, etc.)
 * - Uncaught JavaScript type/reference errors (TypeError, ReferenceError) or stack trace frames
 * - URLs with sensitive query parameters, tokens, or credential signatures
 * - Unprintable control characters or embedded newlines
 *
 * @param {string} str
 * @returns {boolean}
 */
function containsSensitiveDiagnostic(str) {
    if (!str || typeof str !== "string") return false;

    // 1. Windows drive letters & UNC paths
    if (/[a-zA-Z]:[\\\/]/i.test(str)) return true;
    if (/(?:^|[\s"'`(<[])\\\\[a-zA-Z0-9._$-]+\\[a-zA-Z0-9._$-]+/i.test(str)) return true;

    // 2. POSIX root paths & common Linux/Unix directories & relative traversals
    if (/(?:^|[\s"'`(<[])[\\\/](?:root|app|opt|workspace|srv|home|var|tmp|etc|usr|bin|sbin|lib|lib64|proc|sys|dev|node_modules)(?:[\\\/]|$)/i.test(str)) return true;
    if (/(?:^|[\s"'`(<[])[\\\/](?:Users|Program Files|Windows)[\\\/]/i.test(str)) return true;
    if (/(?:^|[\s"'`(<[])(?:\.\.?[\\\/])/i.test(str)) return true;

    // 3. Raw Node.js / OS system error tokens
    if (/\b(?:ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|ENETDOWN|ENOTDIR|EISDIR|EBADF|EMFILE|ENFILE|EEXIST)\b/i.test(str)) return true;

    // 4. JavaScript runtime error types & stack trace indicators
    if (/\b(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError)\b/i.test(str)) return true;
    if (/\bat\s+[a-zA-Z0-9_$.<>]+\s+\(/i.test(str)) return true;
    if (/\bat\s+.*\b(?:\.cjs|\.js|\.mjs):\d+:\d+/i.test(str)) return true;

    // 5. Ported or portless IPv4 literals (including localhost)
    if (/\blocalhost\b/i.test(str)) return true;
    if (/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?::\d+)?\b/.test(str)) return true;

    // 6. Ported or portless IPv6 literals (loopback, link-local, unique local, standard IPv6, bracketed)
    if (/(?:^|[\s"'`(<[])(?:::1|::|\[::1\]|\[[0-9a-fA-F:]+\])(?::\d+)?(?:[\s"'`)>\]]|$)/.test(str)) return true;
    if (/(?:^|[\s"'`(<[])(?:fe80|fc00|fd00):[0-9a-fA-F:]*(?::\d+)?(?:[\s"'`)>\]]|$)/i.test(str)) return true;
    if (/\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}(?::\d+)?\b/i.test(str)) return true;

    // 7. Signed URLs or URLs with query strings/parameters
    if (/https?:\/\/[^\s"'<>]+\?[^\s"'<>]+/i.test(str)) return true;
    if (/[?&](?:token|sig|signature|key|auth|secret|expires|session|hmac)=[^\s"'<>]+/i.test(str)) return true;

    // 8. Unprintable control characters or embedded newlines
    if (/[\r\n\x00-\x1f]/.test(str)) return true;

    return false;
}

/**
 * Strips URLs, tokens, and internal paths from diagnostic messages for safe public presentation.
 */
function sanitizePublicMessage(raw, fallbackMessage) {
    if (!raw || typeof raw !== "string") return fallbackMessage;
    if (containsSensitiveDiagnostic(raw)) {
        return fallbackMessage;
    }
    return raw;
}

/**
 * Centralized error response sanitizer at the HTTP response boundary.
 * Maps application and system exceptions into deterministic, safe public error codes and messages,
 * ensuring internal paths, private proxies, signed URLs, and system codes never reach clients.
 *
 * @param {Error} err
 * @param {string} defaultCode
 * @param {string} defaultMessage
 * @param {number} defaultStatusCode
 * @returns {{ statusCode: number, errorCode: string, message: string }}
 */
function sanitizePublicError(err, defaultCode = "EXTRACTION_FAILED", defaultMessage = "We could not retrieve media from this link.", defaultStatusCode = 502) {
    let statusCode = defaultStatusCode;
    let errorCode = defaultCode;
    let publicMessage = defaultMessage;

    const hasOwn = (obj, key) => Boolean(obj && typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key));

    if (err instanceof ValidationError) {
        statusCode = err.statusCode || 400;
        const rawCode = (err.code && typeof err.code === "string") ? err.code.trim() : "";
        if (hasOwn(VALIDATION_ERROR_MESSAGES, rawCode) && typeof VALIDATION_ERROR_MESSAGES[rawCode] === "string") {
            errorCode = rawCode;
            publicMessage = VALIDATION_ERROR_MESSAGES[rawCode];
        } else {
            errorCode = "VALIDATION_FAILED";
            publicMessage = "Invalid request parameters.";
        }
    } else if (err instanceof SSRFError) {
        statusCode = err.statusCode || 400;
        const rawCode = (err.code && typeof err.code === "string") ? err.code.trim() : "";
        const safeCodePattern = /^[A-Z0-9_]{3,32}$/;
        const reservedProps = new Set(["constructor", "toString", "valueOf", "__proto__", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"]);
        if (rawCode && safeCodePattern.test(rawCode) && !reservedProps.has(rawCode) && !containsSensitiveDiagnostic(rawCode)) {
            errorCode = rawCode;
        } else {
            errorCode = "VALIDATION_FAILED";
        }
        publicMessage = "Destination is not permitted.";
    } else if (err instanceof SecurityHTTPError) {
        statusCode = err.statusCode || 400;
        const rawCode = (err.code && typeof err.code === "string") ? err.code.trim() : "";
        if (hasOwn(SECURITY_ERROR_MESSAGES, rawCode) && typeof SECURITY_ERROR_MESSAGES[rawCode] === "string") {
            errorCode = rawCode;
            publicMessage = SECURITY_ERROR_MESSAGES[rawCode];
        } else {
            errorCode = "SECURITY_ERROR";
            publicMessage = "Security policy violation.";
        }
    } else if (err instanceof ExtractionError) {
        statusCode = err.statusCode || 502;
        const rawCode = (err.code && typeof err.code === "string") ? err.code.trim() : "";
        if (
            hasOwn(EXTRACTION_ERROR_CODES, rawCode) &&
            hasOwn(DEFAULT_ERROR_MESSAGES, rawCode) &&
            typeof DEFAULT_ERROR_MESSAGES[rawCode] === "string"
        ) {
            errorCode = rawCode;
            publicMessage = DEFAULT_ERROR_MESSAGES[rawCode];
        } else {
            errorCode = defaultCode;
            publicMessage = defaultMessage;
        }
    } else {
        // Unknown internal or system exception (e.g. ENOENT, ECONNREFUSED, TypeError, ReferenceError)
        statusCode = (typeof err?.statusCode === "number" && err.statusCode >= 400 && err.statusCode <= 599)
            ? err.statusCode
            : defaultStatusCode;
        errorCode = defaultCode;
        publicMessage = defaultMessage;
    }

    if (typeof publicMessage !== "string" || !publicMessage) {
        publicMessage = defaultMessage;
    }
    if (typeof errorCode !== "string" || !errorCode) {
        errorCode = defaultCode;
    }

    return { statusCode, errorCode, message: publicMessage };
}

// ================== MAIN EXTRACTION ENDPOINT ==================
app.get("/api/download/:platform", extractionLimiter, extractionConcurrencyLimiter, async (req, res) => {
    if (isShuttingDown) {
        return res.status(503).json({
            error: {
                code: "SERVICE_UNAVAILABLE",
                message: "Server is shutting down. Please retry on another instance."
            },
            requestId: req.id
        });
    }

    const abortController = new AbortController();
    activeExtractionControllers.add(abortController);

    req.on("close", () => {
        if (!res.writableEnded && (req.destroyed || !req.complete || req.socket?.destroyed)) {
            abortController.abort();
        }
    });

    try {
        const extraction = await extractMedia({
            platform: req.params.platform,
            sourceUrl: req.query.url,
            mode: req.query.mode,
            requestId: req.id,
            signal: abortController.signal
        });

        const { media } = extraction;

        // Register the validated upstream URL or local file and generate an opaque media ID
        const registered = defaultRegistry.registerMedia({
            upstreamUrl: media.url,
            platform: media.platform,
            type: media.type || "video",
            title: media.title || "Media",
            localFilePath: media.localFilePath || null,
            mode: media.mode || null
        });

        // Return opaque media references (fully matching existing frontend expectations)
        res.json({
            media: registered,
            streamUrl: `/api/media/${registered.id}`,
            downloadUrl: `/api/media/${registered.id}?download=1`,
            // Backward-compatibility field
            videoUrl: `/api/media/${registered.id}`
        });

    } catch (err) {
        const sanitized = sanitizePublicError(err, "EXTRACTION_FAILED", "We could not retrieve media from this link.", 502);

        logger.error({
            requestId: req.id,
            platform: req.params.platform,
            operation: "extract",
            status: "error",
            code: sanitized.errorCode,
            message: sanitized.message
        });

        res.status(sanitized.statusCode).json({
            error: {
                code: sanitized.errorCode,
                message: sanitized.message
            },
            requestId: req.id
        });
    } finally {
        activeExtractionControllers.delete(abortController);
    }
});

// ================== AUTHORITATIVE SECURE MEDIA STREAMING ==================
/**
 * Authoritative handler for securely streaming a registered media entry.
 * Enforces:
 * 1. Approved media domain verification
 * 2. DNS/IP SSRF protection via safe socket lookup
 * 3. Controlled redirects (max 3, domain validated)
 * 4. Overall & connection timeouts (AbortController)
 * 5. Content-Type validation against approved media MIME types
 * 6. Hard response size limit via StreamMeter
 * 7. Client disconnect handling
 */
async function streamRegisteredMedia(req, res, mediaEntry, isDownload = false) {
    if (isShuttingDown) {
        return res.status(503).json({
            error: {
                code: "SERVICE_UNAVAILABLE",
                message: "Server is shutting down. Please retry on another instance."
            },
            requestId: req.id
        });
    }

    const streamStartTime = Date.now();
    const platform = mediaEntry && mediaEntry.platform ? mediaEntry.platform : undefined;

    // Operation start logging
    logger.info({
        requestId: req.id,
        platform,
        operation: "stream",
        status: "start"
    });

    let streamLogged = false;
    const logStreamTerminal = (status, code) => {
        if (streamLogged) return;
        streamLogged = true;
        const durationMs = Date.now() - streamStartTime;
        if (status === "success") {
            logger.info({
                requestId: req.id,
                platform,
                operation: "stream",
                status: "success",
                durationMs
            });
        } else {
            logger.error({
                requestId: req.id,
                platform,
                operation: "stream",
                status: "error",
                code: code || "STREAM_ERROR",
                durationMs
            });
        }
    };

    const abortController = new AbortController();
    activeStreamControllers.add(abortController);

    const cleanupController = () => {
        activeStreamControllers.delete(abortController);
    };
    res.on("finish", () => {
        cleanupController();
        if (res.statusCode >= 200 && res.statusCode < 400) {
            logStreamTerminal("success");
        } else {
            logStreamTerminal("error", `HTTP_${res.statusCode}`);
        }
    });
    res.on("close", () => {
        cleanupController();
        if (!res.writableEnded) {
            const abortCode = abortController.signal.aborted ? "STREAM_ABORTED" : "CLIENT_DISCONNECTED";
            logStreamTerminal("error", abortCode);
        }
    });
    res.on("error", () => {
        cleanupController();
        logStreamTerminal("error", "STREAM_ERROR");
    });

    let activeStream = null;
    let fetchHandle = null;

    const onAbort = () => {
        if (activeStream && typeof activeStream.destroy === "function") {
            try { activeStream.destroy(); } catch (_) {}
        }
        if (fetchHandle && typeof fetchHandle.abort === "function") {
            try { fetchHandle.abort(); } catch (_) {}
        }
        if (!res.destroyed) {
            try { res.destroy(); } catch (_) {}
        }
    };

    abortController.signal.addEventListener("abort", onAbort, { once: true });
    res.on("finish", () => abortController.signal.removeEventListener("abort", onAbort));
    res.on("close", () => abortController.signal.removeEventListener("abort", onAbort));

    req.on("close", () => {
        if (!res.writableEnded && (req.destroyed || !req.complete || req.socket?.destroyed)) {
            abortController.abort();
        }
    });

    const maxMediaSize = serverConfig.maxMediaSizeBytes;

    // If entry is backed by a local merged media file (e.g., YouTube VIDEO_AND_AUDIO)
    if (mediaEntry.localFilePath) {
        let releaseLease = () => {};
        try {
            const resolvedTempDir = path.resolve(process.env.REEVA_TEMP_DIR || REEVA_TEMP_DIR);
            const resolvedFilePath = path.resolve(mediaEntry.localFilePath);

            // Anti-traversal check: file must strictly reside within REEVA_TEMP_DIR
            if (!resolvedFilePath.startsWith(resolvedTempDir + path.sep)) {
                logStreamTerminal("error", "ACCESS_DENIED");
                return res.status(403).json({
                    error: {
                        code: "ACCESS_DENIED",
                        message: "Access to the requested file is prohibited."
                    },
                    requestId: req.id
                });
            }

            // Acquire active file stream lease before opening or checking file
            const leaseFn = defaultRegistry.acquireFileLease(resolvedFilePath);
            if (!leaseFn) {
                logStreamTerminal("error", "MEDIA_NOT_FOUND");
                return res.status(404).json({
                    error: {
                        code: "MEDIA_NOT_FOUND",
                        message: "The requested media file has expired or does not exist."
                    },
                    requestId: req.id
                });
            }
            releaseLease = leaseFn;

            if (abortController.signal.aborted || res.destroyed) {
                releaseLease();
                if (!res.destroyed) {
                    res.destroy();
                }
                return;
            }

            let stat;
            try {
                stat = await fs.promises.stat(resolvedFilePath);
            } catch (err) {
                if (abortController.signal.aborted || res.destroyed) {
                    releaseLease();
                    if (!res.destroyed) {
                        res.destroy();
                    }
                    return;
                }
                if (err.code === "ENOENT" || err.code === "ENOTDIR") {
                    releaseLease();
                    logStreamTerminal("error", "MEDIA_NOT_FOUND");
                    return res.status(404).json({
                        error: {
                            code: "MEDIA_NOT_FOUND",
                            message: "The requested media file has expired or does not exist."
                        },
                        requestId: req.id
                    });
                }
                throw err;
            }

            if (abortController.signal.aborted || res.destroyed) {
                releaseLease();
                if (!res.destroyed) {
                    res.destroy();
                }
                return;
            }

            if (stat.size > maxMediaSize) {
                releaseLease();
                logStreamTerminal("error", "PAYLOAD_TOO_LARGE");
                return res.status(413).json({
                    error: {
                        code: "PAYLOAD_TOO_LARGE",
                        message: "Media stream exceeded maximum permitted size."
                    },
                    requestId: req.id
                });
            }

            const fileExt = mediaEntry.type === "image" ? "jpg" : (mediaEntry.type === "audio" ? "m4a" : "mp4");
            const disposition = isDownload
                ? `attachment; filename="reeva_${mediaEntry.platform || "media"}.${fileExt}"`
                : "inline";
            const contentType = mediaEntry.type === "audio" ? "audio/mp4" : "video/mp4";

            res.setHeader("Content-Type", contentType);
            res.setHeader("Content-Disposition", disposition);
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Cache-Control", "private, no-transform, max-age=3600");
            res.setHeader("Content-Length", stat.size);

            const fileStream = fs.createReadStream(resolvedFilePath);
            activeStream = fileStream;

            // Wire lease release to all termination events
            fileStream.on("close", releaseLease);
            fileStream.on("error", releaseLease);
            res.on("finish", releaseLease);
            res.on("close", releaseLease);
            res.on("error", releaseLease);
            abortController.signal.addEventListener("abort", releaseLease, { once: true });

            const meter = new StreamMeter(maxMediaSize, () => {
                fileStream.destroy();
            });

            meter.on("error", () => {
                fileStream.destroy();
                releaseLease();
                logStreamTerminal("error", "PAYLOAD_TOO_LARGE");
                if (!res.headersSent) {
                    res.status(413).json({
                        error: {
                            code: "PAYLOAD_TOO_LARGE",
                            message: "Media stream exceeded maximum permitted size."
                        },
                        requestId: req.id
                    });
                } else {
                    res.destroy();
                }
            });

            fileStream.pipe(meter).pipe(res);
            return;
        } catch (err) {
            releaseLease();
            logStreamTerminal("error", "STREAM_ERROR");
            if (!res.headersSent) {
                res.status(500).json({
                    error: {
                        code: "STREAM_ERROR",
                        message: "Failed to stream local media file."
                    },
                    requestId: req.id
                });
            } else {
                res.destroy();
            }
            return;
        }
    }

    // Upstream streaming via secureFetch for remote media URLs
    // Strictly prohibited for generic platform (must always be local artifacts)
    if (mediaEntry.platform === "generic" || mediaEntry.platform === "more_sites") {
        logStreamTerminal("error", "ACCESS_DENIED");
        return res.status(403).json({
            error: {
                code: "ACCESS_DENIED",
                message: "Remote streaming is not permitted for generic platform media."
            },
            requestId: req.id
        });
    }

    try {
        const platformReferers = {
            instagram: "https://www.instagram.com/",
            facebook: "https://www.facebook.com/",
            twitter: "https://x.com/",
            x: "https://x.com/",
            pinterest: "https://www.pinterest.com/",
            youtube: "https://www.youtube.com/"
        };
        const referer = platformReferers[mediaEntry.platform] || "https://www.instagram.com/";

        fetchHandle = await secureFetch(mediaEntry.upstreamUrl, {
            allowedDomains: SUPPORTED_MEDIA_DOMAINS,
            maxSizeBytes: maxMediaSize,
            maxRedirects: 3,
            timeoutMs: 30000,
            headers: {
                "Referer": referer
            }
        });

        if (abortController.signal.aborted || res.destroyed) {
            fetchHandle.abort();
            return;
        }

        const { response } = fetchHandle;

        if (!response.ok) {
            fetchHandle.abort();
            logStreamTerminal("error", `UPSTREAM_HTTP_${response.status}`);
            return res.status(502).json({
                error: {
                    code: "UPSTREAM_FETCH_FAILED",
                    message: `Could not retrieve media from upstream provider (HTTP ${response.status}).`
                },
                requestId: req.id
            });
        }

        const rawContentType = response.headers.get("content-type") || (mediaEntry.type === "audio" ? "audio/mp4" : "video/mp4");

        // Validate upstream Content-Type
        if (!isPermittedMediaContentType(rawContentType)) {
            fetchHandle.abort();
            logStreamTerminal("error", "UNSAFE_CONTENT_TYPE");
            return res.status(502).json({
                error: {
                    code: "UNSAFE_CONTENT_TYPE",
                    message: "The upstream media stream returned an invalid or unsupported content type."
                },
                requestId: req.id
            });
        }

        // Set safe response headers
        const fileExt = mediaEntry.type === "image" ? "jpg" : (mediaEntry.type === "audio" ? "m4a" : "mp4");
        const disposition = isDownload
            ? `attachment; filename="reeva_${mediaEntry.platform || "media"}.${fileExt}"`
            : "inline";

        res.setHeader("Content-Type", rawContentType);
        res.setHeader("Content-Disposition", disposition);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "private, no-transform, max-age=3600");

        const contentLength = response.headers.get("content-length");
        if (contentLength) {
            res.setHeader("Content-Length", contentLength);
        }

        // Stream through byte meter to enforce hard maximum size limit
        const meter = new StreamMeter(maxMediaSize, () => {
            fetchHandle.abort();
        });

        meter.on("error", (err) => {
            fetchHandle.abort();
            logStreamTerminal("error", "PAYLOAD_TOO_LARGE");
            if (!res.headersSent) {
                res.status(413).json({
                    error: {
                        code: "PAYLOAD_TOO_LARGE",
                        message: "Media stream exceeded maximum permitted size."
                    },
                    requestId: req.id
                });
            } else {
                res.destroy();
            }
        });

        activeStream = response.body;
        response.body.pipe(meter).pipe(res);

    } catch (err) {
        if (fetchHandle) fetchHandle.abort();
        logStreamTerminal("error", err.code || "STREAM_ERROR");

        const sanitized = sanitizePublicError(err, "STREAM_ERROR", "Failed to retrieve media stream.", 500);

        logger.error({
            requestId: req.id,
            platform,
            operation: "stream",
            status: "error",
            code: sanitized.errorCode,
            message: sanitized.message
        });

        if (!res.headersSent) {
            res.status(sanitized.statusCode).json({
                error: {
                    code: sanitized.errorCode,
                    message: sanitized.message
                },
                requestId: req.id
            });
        } else {
            res.destroy();
        }
    }
}

// ================== SECURE MEDIA STREAMING ENDPOINT ==================
app.get("/api/media/:mediaId", mediaStreamLimiter, mediaStreamConcurrencyLimiter, async (req, res) => {
    if (isShuttingDown) {
        return res.status(503).json({
            error: {
                code: "SERVICE_UNAVAILABLE",
                message: "Server is shutting down. Please retry on another instance."
            },
            requestId: req.id
        });
    }

    const { mediaId } = req.params;
    const isDownload = req.query.download === "1";

    if (!mediaId || !/^[a-zA-Z0-9_\-]{8,64}$/.test(mediaId)) {
        return res.status(400).json({
            error: {
                code: "INVALID_MEDIA_ID",
                message: "Invalid media reference."
            },
            requestId: req.id
        });
    }

    const mediaEntry = defaultRegistry.getMedia(mediaId);
    if (!mediaEntry) {
        return res.status(404).json({
            error: {
                code: "MEDIA_NOT_FOUND",
                message: "The requested media link has expired or does not exist. Please extract again."
            },
            requestId: req.id
        });
    }

    return streamRegisteredMedia(req, res, mediaEntry, isDownload);
});

// ================== COMPATIBILITY PROXY ENDPOINT ==================
// Accepts only existing validated Reeva-generated media IDs or registered media URLs.
// Never creates new registry entries from arbitrary user-provided URLs.
app.get("/api/proxy", mediaStreamLimiter, mediaStreamConcurrencyLimiter, async (req, res) => {
    if (isShuttingDown) {
        return res.status(503).json({
            error: {
                code: "SERVICE_UNAVAILABLE",
                message: "Server is shutting down. Please retry on another instance."
            },
            requestId: req.id
        });
    }

    const { id, url, download } = req.query;
    const isDownload = download === "1";

    // 1. If opaque ID is supplied, resolve existing registry entry
    if (id) {
        if (typeof id !== "string" || !/^[a-zA-Z0-9_\-]{8,64}$/.test(id)) {
            return res.status(400).json({
                error: {
                    code: "INVALID_MEDIA_ID",
                    message: "Invalid media reference."
                },
                requestId: req.id
            });
        }

        const mediaEntry = defaultRegistry.getMedia(id);
        if (!mediaEntry) {
            return res.status(404).json({
                error: {
                    code: "MEDIA_NOT_FOUND",
                    message: "The requested media link has expired or does not exist. Please extract again."
                },
                requestId: req.id
            });
        }

        return streamRegisteredMedia(req, res, mediaEntry, isDownload);
    }

    // 2. If URL is supplied, ONLY permit if it corresponds to an ALREADY-REGISTERED media entry.
    // Never allow a user to register an arbitrary upstream URL directly via /api/proxy.
    if (url) {
        if (typeof url !== "string") {
            return res.status(400).json({
                error: {
                    code: "INVALID_URL",
                    message: "Invalid URL parameter."
                },
                requestId: req.id
            });
        }

        const existingEntry = defaultRegistry.findByUpstreamUrl(url.trim());
        if (existingEntry) {
            return streamRegisteredMedia(req, res, existingEntry, isDownload);
        }

        // Unregistered URL: reject strictly with 403 ARBITRARY_PROXY_FORBIDDEN
        return res.status(403).json({
            error: {
                code: "ARBITRARY_PROXY_FORBIDDEN",
                message: "Arbitrary URL proxying is forbidden. Only verified Reeva media streams are permitted."
            },
            requestId: req.id
        });
    }

    return res.status(400).json({
        error: {
            code: "MISSING_PARAMETER",
            message: "Missing media reference parameter."
        },
        requestId: req.id
    });
});

// ================== CONTROLLED 404 FOR UNKNOWN API ROUTES ==================
app.use("/api", (req, res) => {
    res.status(404).json({
        error: {
            code: "NOT_FOUND",
            message: "API endpoint not found."
        },
        requestId: req.id
    });
});

// ================== GLOBAL ERROR HANDLER ==================
app.use((err, req, res, next) => {
    logger.error({
        requestId: req.id,
        operation: "http",
        status: "error",
        code: err.code || "INTERNAL_SERVER_ERROR",
        message: err.message
    });

    res.status(err.statusCode || 500).json({
        error: {
            code: err.code || "INTERNAL_SERVER_ERROR",
            message: "An internal server error occurred."
        },
        requestId: req.id
    });
});

// ================== GRACEFUL SHUTDOWN & LIFECYCLE ==================
/**
 * Gracefully shuts down the server:
 * 1. Idempotent (calling multiple times returns the same in-progress promise).
 * 2. Marks server as not ready (isShuttingDown = true, /ready returns 503).
 * 3. Closes listening socket so no new TCP connections are accepted.
 * 4. Waits up to shutdownTimeoutMs for active extractions AND active streams to finish draining.
 * 5. If deadline expires, aborts all remaining active extraction and streaming controllers.
 * 6. Cleans up periodic background sweeps, temporary disk artifacts, and media registry.
 *
 * @param {string} [signal="SIGTERM"]
 * @param {object} [options={}]
 * @param {number} [options.timeoutMs]
 * @param {import("http").Server} [options.server]
 * @returns {Promise<void>}
 */
function gracefulShutdown(signal = "SIGTERM", options = {}) {
    if (shutdownPromise) {
        return shutdownPromise;
    }

    isShuttingDown = true;
    const timeoutMs = options.timeoutMs || serverConfig.shutdownTimeoutMs;
    const serverToClose = options.server || activeServer;

    logger.info({
        message: `Graceful shutdown initiated with signal ${signal}. Waiting up to ${timeoutMs}ms for ${activeExtractionControllers.size} in-flight extractions and ${activeStreamControllers.size} in-flight streams to complete.`
    });

    shutdownPromise = (async () => {
        // 1. Wait for active extractions AND active streams to drain or timeout
        const startTime = Date.now();
        while ((activeExtractionControllers.size > 0 || activeStreamControllers.size > 0) && (Date.now() - startTime) < timeoutMs) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        // 2. Force abort any remaining extraction or streaming controllers after timeout
        const lingeringExtractions = activeExtractionControllers.size;
        const lingeringStreams = activeStreamControllers.size;
        if (lingeringExtractions > 0 || lingeringStreams > 0) {
            logger.warn({
                message: `Shutdown grace period expired (${timeoutMs}ms). Aborting ${lingeringExtractions} active extractions and ${lingeringStreams} active streams.`
            });
            for (const controller of activeExtractionControllers) {
                try {
                    controller.abort();
                } catch (_) {
                    // Ignore already aborted
                }
            }
            activeExtractionControllers.clear();

            for (const controller of activeStreamControllers) {
                try {
                    controller.abort();
                } catch (_) {
                    // Ignore already aborted
                }
            }
            activeStreamControllers.clear();
        }

        let shutdownError = null;

        // 3. Stop accepting new HTTP connections and close socket
        if (serverToClose && serverToClose.listening) {
            // Close any idle keep-alive connections immediately
            if (typeof serverToClose.closeIdleConnections === "function") {
                try {
                    serverToClose.closeIdleConnections();
                } catch (_) {}
            }

            const serverCloseTimeoutMs = Number.isInteger(options.serverCloseTimeoutMs) && options.serverCloseTimeoutMs > 0
                ? options.serverCloseTimeoutMs
                : 3000;
            const forceCloseTimeoutMs = Math.min(1000, Math.max(10, Math.floor(serverCloseTimeoutMs / 2)));

            try {
                await new Promise((resolve, reject) => {
                    let forceCloseTimer = null;
                    let hardTimeoutTimer = null;
                    let isSettled = false;

                    const cleanupTimers = () => {
                        if (forceCloseTimer) {
                            clearTimeout(forceCloseTimer);
                            forceCloseTimer = null;
                        }
                        if (hardTimeoutTimer) {
                            clearTimeout(hardTimeoutTimer);
                            hardTimeoutTimer = null;
                        }
                    };

                    const onClose = (err) => {
                        if (isSettled) return;
                        isSettled = true;
                        cleanupTimers();

                        if (err) {
                            logger.error({ message: `Error closing HTTP server: ${err.message}` });
                            return reject(err);
                        }
                        resolve();
                    };

                    serverToClose.close(onClose);

                    // If active/paused connections delay server closure, forcefully terminate them
                    forceCloseTimer = setTimeout(() => {
                        if (isSettled) return;
                        if (typeof serverToClose.closeAllConnections === "function") {
                            try {
                                serverToClose.closeAllConnections();
                            } catch (closeAllErr) {
                                logger.error({ message: `Error calling closeAllConnections: ${closeAllErr.message}` });
                            }
                        }
                    }, forceCloseTimeoutMs);
                    if (forceCloseTimer.unref) forceCloseTimer.unref();

                    // Hard safety deadline: only the server close callback may confirm normal closure.
                    // If deadline expires before onClose callback completes, reject with clear timeout error.
                    hardTimeoutTimer = setTimeout(() => {
                        if (isSettled) return;
                        isSettled = true;
                        cleanupTimers();

                        const timeoutErr = new Error("HTTP server failed to close within shutdown deadline");
                        logger.error({ message: timeoutErr.message });
                        reject(timeoutErr);
                    }, serverCloseTimeoutMs);
                });
            } catch (closeErr) {
                shutdownError = closeErr;
            }
        }

        // 4. Clear periodic background sweeps (even if server closure timed out or failed)
        try {
            if (staleCleanupInterval) {
                clearInterval(staleCleanupInterval);
            }
        } catch (intervalErr) {
            logger.error({ message: `Error clearing stale-cleanup interval: ${intervalErr.message}` });
            if (!shutdownError) shutdownError = intervalErr;
        }

        // 5. Clean up temporary files, registry entries, and egress proxy safely
        try {
            await stopDefaultEgressProxy();
            destroyHttpAgents();
        } catch (proxyErr) {
            logger.error({ message: `Error stopping egress proxy during shutdown: ${proxyErr.message}` });
            if (!shutdownError) shutdownError = proxyErr;
        }

        try {
            defaultRegistry.clear();
        } catch (regErr) {
            logger.error({ message: `Error clearing media registry during shutdown: ${regErr.message}` });
            if (!shutdownError) shutdownError = regErr;
        }

        try {
            await cleanStaleTempFiles();
        } catch (tempErr) {
            logger.error({ message: `Error cleaning temporary files during shutdown: ${tempErr.message}` });
            if (!shutdownError) shutdownError = tempErr;
        }

        // If server closure timed out or any cleanup step failed, propagate the error without emitting success log
        if (shutdownError) {
            throw shutdownError;
        }

        logger.info({
            message: `Graceful shutdown completed successfully.`
        });
    })();

    return shutdownPromise;
}

// Attach lifecycle and diagnostic functions to app
app.serverConfig = serverConfig;
app.gracefulShutdown = gracefulShutdown;
app.getActiveExtractionControllers = () => activeExtractionControllers;
app.getActiveStreamControllers = () => activeStreamControllers;
app.getIsShuttingDown = () => isShuttingDown;
app.getIsPreflightComplete = () => isPreflightComplete;
app.setIsPreflightComplete = (val) => { isPreflightComplete = Boolean(val); };
app.resetShutdownState = () => {
    isShuttingDown = false;
    isPreflightComplete = false;
    activeServer = null;
    shutdownPromise = null;
    activeExtractionControllers.clear();
    activeStreamControllers.clear();
};

/**
 * Starts the HTTP server after completing the production preflight.
 *
 * @param {number} [port=PORT]
 * @param {object} [options={}]
 * @returns {Promise<import("http").Server>}
 */
async function startServer(port = PORT, options = {}) {
    await validateProductionPreflight(process.env, options);
    isPreflightComplete = true;

    return new Promise((resolve, reject) => {
        const server = app.listen(port, () => {
            activeServer = server;
            logger.info({
                message: `Reeva backend is live on port ${port} [NODE_ENV=${process.env.NODE_ENV || "development"}]`
            });
            resolve(server);
        });
        server.on("error", reject);
    });
}

app.startServer = startServer;

// ================== SERVER LIFECYCLE ==================
if (require.main === module) {
    startServer(PORT)
        .catch((err) => {
            logger.error({ message: `Fatal startup preflight failure: ${err.message}` });
            process.exit(1);
        });

    const handleSignal = (sig) => {
        logger.info({ message: `Received ${sig}. Starting graceful shutdown...` });
        gracefulShutdown(sig)
            .then(() => {
                process.exit(0);
            })
            .catch((err) => {
                logger.error({ message: `Fatal error during shutdown: ${err.message}` });
                process.exit(1);
            });
    };

    process.on("SIGTERM", () => handleSignal("SIGTERM"));
    process.on("SIGINT", () => handleSignal("SIGINT"));
}

app.VALIDATION_ERROR_MESSAGES = VALIDATION_ERROR_MESSAGES;
app.SECURITY_ERROR_MESSAGES = SECURITY_ERROR_MESSAGES;
app.sanitizePublicError = sanitizePublicError;
app.sanitizePublicMessage = sanitizePublicMessage;
app.containsSensitiveDiagnostic = containsSensitiveDiagnostic;

module.exports = app;
