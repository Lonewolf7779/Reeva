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
    secureFetch
} = require("./lib/http-client.cjs");

const { defaultRegistry } = require("./lib/media-registry.cjs");
const { createConcurrencyLimiter } = require("./lib/concurrency-limiter.cjs");
const { logger, requestIdMiddleware } = require("./lib/logger.cjs");
const { extractMedia, ExtractionError } = require("./lib/extraction/index.cjs");
const { REEVA_TEMP_DIR, cleanStaleTempFiles } = require("./lib/extraction/adapters/youtube.cjs");

// Clean stale temporary media artifacts on server startup
cleanStaleTempFiles();
// Periodic sweep of stale temporary artifacts every 15 minutes
const staleCleanupInterval = setInterval(() => cleanStaleTempFiles(), 15 * 60 * 1000);
if (staleCleanupInterval && staleCleanupInterval.unref) {
    staleCleanupInterval.unref();
}

const { validateServerConfig, ConfigError } = require("./lib/config.cjs");

// Validate server configuration fail-fast on startup
const serverConfig = validateServerConfig(process.env);
const PORT = serverConfig.port;

// Server lifecycle tracking state
let isShuttingDown = false;
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
            styleSrc: ["'self'", "'unsafe-inline'"], // permits internal style block in index.html
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
    max: serverConfig.rateLimitGeneralMax,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
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
    max: serverConfig.rateLimitExtractionMax,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    message: {
        error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many extraction requests. Please wait a minute and try again."
        }
    }
});

const mediaStreamLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: serverConfig.rateLimitMediaMax,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
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
        if (!res.writableEnded) {
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
        let statusCode = 502;
        let errorCode = "EXTRACTION_FAILED";

        if (err instanceof ValidationError || err instanceof SSRFError || err instanceof SecurityHTTPError) {
            statusCode = err.statusCode || 400;
            errorCode = err.code || "VALIDATION_FAILED";
        } else if (err instanceof ExtractionError) {
            statusCode = err.statusCode || 502;
            errorCode = err.code || "EXTRACTION_FAILED";
        }

        res.status(statusCode).json({
            error: {
                code: errorCode,
                message: err.message || "We could not retrieve media from this link."
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
        if (!res.writableEnded) {
            abortController.abort();
        }
    });

    const maxMediaSize = serverConfig.maxMediaSizeBytes;

    // If entry is backed by a local merged media file (e.g., YouTube VIDEO_AND_AUDIO)
    if (mediaEntry.localFilePath) {
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

            if (!fs.existsSync(resolvedFilePath)) {
                logStreamTerminal("error", "MEDIA_NOT_FOUND");
                return res.status(404).json({
                    error: {
                        code: "MEDIA_NOT_FOUND",
                        message: "The requested media file has expired or does not exist."
                    },
                    requestId: req.id
                });
            }

            const stat = fs.statSync(resolvedFilePath);
            if (stat.size > maxMediaSize) {
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

            const meter = new StreamMeter(maxMediaSize, () => {
                fileStream.destroy();
            });

            meter.on("error", () => {
                fileStream.destroy();
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

        const status = err instanceof SecurityHTTPError ? err.statusCode : 500;
        if (!res.headersSent) {
            res.status(status).json({
                error: {
                    code: err.code || "STREAM_ERROR",
                    message: err.message || "Failed to retrieve media stream."
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

        // 3. Stop accepting new HTTP connections and close socket
        if (serverToClose && serverToClose.listening) {
            // Close any idle keep-alive connections immediately
            if (typeof serverToClose.closeIdleConnections === "function") {
                serverToClose.closeIdleConnections();
            }

            await new Promise((resolve) => {
                let forceCloseTimer = null;
                const onClose = (err) => {
                    if (forceCloseTimer) clearTimeout(forceCloseTimer);
                    if (err) {
                        logger.error({ message: `Error closing HTTP server: ${err.message}` });
                    }
                    resolve();
                };

                serverToClose.close(onClose);

                // Ensure server.close() cannot hang indefinitely if a stubborn connection exists
                forceCloseTimer = setTimeout(() => {
                    if (typeof serverToClose.closeAllConnections === "function") {
                        serverToClose.closeAllConnections();
                    }
                }, 1000);
                if (forceCloseTimer.unref) forceCloseTimer.unref();
            });
        }

        // 4. Clear periodic background sweeps
        if (staleCleanupInterval) {
            clearInterval(staleCleanupInterval);
        }

        // 5. Clean up temporary files and registry entries safely
        try {
            defaultRegistry.clear();
        } catch (_) {}

        try {
            cleanStaleTempFiles();
        } catch (err) {
            logger.error({ message: `Error cleaning temporary files during shutdown: ${err.message}` });
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
app.resetShutdownState = () => {
    isShuttingDown = false;
    shutdownPromise = null;
    activeExtractionControllers.clear();
    activeStreamControllers.clear();
};

// ================== SERVER LIFECYCLE ==================
if (require.main === module) {
    activeServer = app.listen(PORT, () => {
        logger.info({
            message: `Reeva backend is live on port ${PORT} [NODE_ENV=${process.env.NODE_ENV || "development"}]`
        });
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

module.exports = app;
