// server.cjs — Reeva Hardened Multi-Platform Media Downloader Backend
"use strict";

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const ytdl_exec = require("@distube/ytdl-core");
require("dotenv").config();

const {
    SUPPORTED_SOURCE_DOMAINS,
    SUPPORTED_MEDIA_DOMAINS,
    ValidationError,
    validatePlatform,
    validateSourceUrl,
    validateMediaUrl
} = require("./lib/url-validator.cjs");

const { SSRFError } = require("./lib/ssrf-filter.cjs");

const {
    DEFAULT_MAX_MEDIA_BYTES,
    SecurityHTTPError,
    ResponseTooLargeError,
    StreamMeter,
    isPermittedMediaContentType,
    secureFetch,
    secureFetchHtml
} = require("./lib/http-client.cjs");

const { defaultRegistry } = require("./lib/media-registry.cjs");
const { defaultCache } = require("./lib/cache.cjs");
const { createConcurrencyLimiter } = require("./lib/concurrency-limiter.cjs");
const { logger, requestIdMiddleware } = require("./lib/logger.cjs");

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

// ================== PRODUCTION CONFIGURATION ==================
// Do not blindly set trust proxy to true without deliberate configuration
if (process.env.TRUST_PROXY) {
    app.set("trust proxy", process.env.TRUST_PROXY);
} else {
    app.set("trust proxy", false);
}

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

// Static assets
app.use(express.static("public", {
    maxAge: "1d",
    etag: true,
    dotfiles: "ignore"
}));

// ================== RATE LIMITERS ==================
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_GENERAL_MAX || "100", 10),
    standardHeaders: true,
    legacyHeaders: false,
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
    max: parseInt(process.env.RATE_LIMIT_EXTRACTION_MAX || "15", 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many extraction requests. Please wait a minute and try again."
        }
    }
});

const mediaStreamLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: parseInt(process.env.RATE_LIMIT_MEDIA_MAX || "30", 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many media download requests. Please wait a few minutes."
        }
    }
});

// Concurrency limiter for expensive extraction and streaming operations
const extractionConcurrencyLimiter = createConcurrencyLimiter({
    maxGlobal: parseInt(process.env.MAX_GLOBAL_CONCURRENCY || "50", 10),
    maxPerIp: parseInt(process.env.MAX_IP_CONCURRENCY || "3", 10)
});

// ================== LOCAL MODULES ==================
const localModules = {};
try { localModules.instagramAlt = require("instagram-url-direct"); } catch (e) { }
try { localModules.twitter = require("twitter-downloader"); } catch (e) { }
try { localModules.pinterest = require("pinterest-dl"); } catch (e) { }
try { localModules.universal = require("@totallynodavid/downloader"); } catch (e) { }

// ================== EXTRACTION UTILITIES ==================
function extractFromMeta(html) {
    const match = html.match(/<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i);
    if (match && match[1]) return match[1];
    return null;
}

function extractMediaFromHtml(html) {
    const decode = s => s?.replace(/\\"/g, '"').replace(/\\u0026/g, "&");

    const patterns = [
        /"video_versions":\[\{[^}]*"url":"([^"]+)"/i,
        /"video_url"\s*:\s*"([^"]+)"/i,
        /"url"\s*:\s*"([^"]+\.mp4[^"]*)"/i,
        /"src"\s*:\s*"([^"]+\.mp4[^"]*)"/i,
        /"contentUrl"\s*:\s*"([^"]+)"/i,
        /"playbackUrl"\s*:\s*"([^"]+)"/i,
        /"display_resources":\[\{[^}]*"src":"([^"]+)"/i,
        /"display_url"\s*:\s*"([^"]+)"/i,
        /<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i,
        /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
            const rawUrl = decode(match[1]);
            const type = rawUrl.includes(".mp4") ? "video" : "image";
            return { url: rawUrl, type };
        }
    }

    return null;
}

// ================== PLATFORM HANDLERS ==================

// --- Instagram ---
async function getInstagramMedia(validatedUrl) {
    // Check in-memory cache
    const cached = defaultCache.get(validatedUrl);
    if (cached) return cached;

    // 1. Try local module
    if (localModules.instagramAlt) {
        try {
            const result = await localModules.instagramAlt(validatedUrl);
            if (result && result.url) {
                validateMediaUrl(result.url);
                const res = { url: result.url, type: "video" };
                defaultCache.set(validatedUrl, res);
                return res;
            }
        } catch (e) {
            // Fall through to HTML extraction
        }
    }

    // 2. Controlled HTML extraction
    try {
        const html = await secureFetchHtml(validatedUrl, SUPPORTED_SOURCE_DOMAINS.instagram);
        const decode = s => s?.replace(/\\"/g, '"').replace(/\\u0026/g, "&");

        const match1 = html.match(/"video_versions":\[\{[^}]*"url":"([^"]+)"/);
        if (match1 && match1[1]) {
            const link = decode(match1[1]);
            validateMediaUrl(link);
            const res = { url: link, type: "video" };
            defaultCache.set(validatedUrl, res);
            return res;
        }

        const match2 = html.match(/"display_resources":\[\{[^}]*"src":"([^"]+)"/);
        if (match2 && match2[1]) {
            const link = decode(match2[1]);
            validateMediaUrl(link);
            const res = { url: link, type: "image" };
            defaultCache.set(validatedUrl, res);
            return res;
        }

        const match3 = html.match(/<meta\s+property=["']og:video["']\s+content=["']([^"']+)["']/i);
        if (match3 && match3[1]) {
            const link = decode(match3[1]);
            validateMediaUrl(link);
            const res = { url: link, type: "video" };
            defaultCache.set(validatedUrl, res);
            return res;
        }

        const match4 = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
        if (match4 && match4[1]) {
            const link = decode(match4[1]);
            validateMediaUrl(link);
            const res = { url: link, type: "image" };
            defaultCache.set(validatedUrl, res);
            return res;
        }
    } catch (e) {
        if (e instanceof ValidationError || e instanceof SSRFError || e instanceof SecurityHTTPError) {
            throw e;
        }
    }

    throw new ValidationError(
        "Could not find downloadable media for this Instagram link. Ensure it is public and contains visible media.",
        "EXTRACTION_FAILED"
    );
}

// --- Facebook ---
async function getFacebookMedia(validatedUrl) {
    const cached = defaultCache.get(validatedUrl);
    if (cached) return cached;

    if (localModules.universal) {
        try {
            const out = await localModules.universal(validatedUrl);
            const vid = out?.url || out?.video || out?.downloadUrl;
            if (vid) {
                validateMediaUrl(vid);
                const res = { url: vid, type: "video" };
                defaultCache.set(validatedUrl, res);
                return res;
            }
        } catch (e) { }
    }

    try {
        const html = await secureFetchHtml(validatedUrl, SUPPORTED_SOURCE_DOMAINS.facebook);
        const meta = extractFromMeta(html);
        if (meta) {
            validateMediaUrl(meta);
            const res = { url: meta, type: "video" };
            defaultCache.set(validatedUrl, res);
            return res;
        }
    } catch (e) {
        if (e instanceof ValidationError || e instanceof SSRFError || e instanceof SecurityHTTPError) {
            throw e;
        }
    }

    throw new ValidationError(
        "Could not retrieve media from this Facebook link. Ensure it is public.",
        "EXTRACTION_FAILED"
    );
}

// --- Twitter / X ---
async function getTwitterMedia(validatedUrl) {
    const cached = defaultCache.get(validatedUrl);
    if (cached) return cached;

    if (localModules.twitter) {
        try {
            const result = await localModules.twitter(validatedUrl);
            const vid = result?.download?.[0]?.url || result?.url;
            if (vid) {
                validateMediaUrl(vid);
                const res = { url: vid, type: "video" };
                defaultCache.set(validatedUrl, res);
                return res;
            }
        } catch (e) { }
    }

    throw new ValidationError(
        "Could not retrieve media from this tweet. Ensure it is public and contains a video.",
        "EXTRACTION_FAILED"
    );
}

// --- Pinterest ---
async function getPinterestMedia(validatedUrl) {
    let targetUrl = validatedUrl;

    // Handle pin.it short links securely with redirect validation
    const parsed = new URL(targetUrl);
    if (parsed.hostname === "pin.it" || parsed.hostname.endsWith(".pin.it")) {
        try {
            const { finalUrl, clearTimeout: clearTimer } = await secureFetch(targetUrl, {
                allowedDomains: SUPPORTED_SOURCE_DOMAINS.pinterest,
                maxRedirects: 3,
                timeoutMs: 8000
            });
            clearTimer();
            targetUrl = validateSourceUrl(finalUrl, "pinterest");
        } catch (e) {
            throw new ValidationError("Could not resolve Pinterest short link.", "EXTRACTION_FAILED");
        }
    }

    const cached = defaultCache.get(targetUrl);
    if (cached) return cached;

    if (localModules.pinterest) {
        try {
            const result = await localModules.pinterest(targetUrl);
            const pin = result?.url || result?.[0]?.url;
            if (pin) {
                validateMediaUrl(pin);
                const res = { url: pin, type: pin.endsWith(".mp4") ? "video" : "image" };
                defaultCache.set(targetUrl, res);
                return res;
            }
        } catch (e) { }
    }

    try {
        const html = await secureFetchHtml(targetUrl, SUPPORTED_SOURCE_DOMAINS.pinterest);
        const extracted = extractMediaFromHtml(html);
        if (extracted && extracted.url) {
            validateMediaUrl(extracted.url);
            const res = { url: extracted.url, type: extracted.type };
            defaultCache.set(targetUrl, res);
            return res;
        }
    } catch (e) {
        if (e instanceof ValidationError || e instanceof SSRFError || e instanceof SecurityHTTPError) {
            throw e;
        }
    }

    throw new ValidationError(
        "Could not find media for this Pinterest link. Ensure it is public.",
        "EXTRACTION_FAILED"
    );
}

// --- YouTube ---
async function getYouTubeMedia(validatedUrl) {
    const cached = defaultCache.get(validatedUrl);
    if (cached) return cached;

    try {
        const info = await ytdl_exec.getInfo(validatedUrl);
        if (!info || !info.formats) {
            throw new ValidationError("Could not retrieve video stream details.", "EXTRACTION_FAILED");
        }

        const format =
            info.formats.find(f => f.hasVideo && f.hasAudio && f.container === "mp4") ||
            info.formats.find(f => f.hasVideo && f.container === "mp4") ||
            info.formats.find(f => f.mimeType && f.mimeType.includes("video"));

        if (!format || !format.url) {
            throw new ValidationError("No downloadable format available.", "EXTRACTION_FAILED");
        }

        validateMediaUrl(format.url);

        const result = {
            url: format.url,
            type: "video",
            title: info.videoDetails?.title || "Reeva YouTube Video"
        };

        defaultCache.set(validatedUrl, result);
        return result;

    } catch (err) {
        if (err instanceof ValidationError) throw err;
        throw new ValidationError("Could not retrieve media from YouTube.", "EXTRACTION_FAILED");
    }
}

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
    const startTime = Date.now();
    let platform = "unknown";

    try {
        platform = validatePlatform(req.params.platform);
        const { url } = req.query;

        if (!url) {
            return res.status(400).json({
                error: {
                    code: "MISSING_URL",
                    message: "Please paste a video link first."
                },
                requestId: req.id
            });
        }

        // Validate source URL strictly
        const validatedUrl = validateSourceUrl(url, platform);

        let result;
        switch (platform) {
            case "instagram":
                result = await getInstagramMedia(validatedUrl);
                break;
            case "facebook":
                result = await getFacebookMedia(validatedUrl);
                break;
            case "twitter":
            case "x":
                result = await getTwitterMedia(validatedUrl);
                break;
            case "pinterest":
                result = await getPinterestMedia(validatedUrl);
                break;
            case "youtube":
                result = await getYouTubeMedia(validatedUrl);
                break;
            default:
                return res.status(400).json({
                    error: {
                        code: "UNSUPPORTED_PLATFORM",
                        message: "This platform is not supported."
                    },
                    requestId: req.id
                });
        }

        if (!result || !result.url) {
            return res.status(404).json({
                error: {
                    code: "MEDIA_NOT_FOUND",
                    message: `Could not find downloadable media for this ${platform} post.`
                },
                requestId: req.id
            });
        }

        // Register the validated upstream URL and generate an opaque media ID
        const registered = defaultRegistry.registerMedia({
            upstreamUrl: result.url,
            platform,
            type: result.type || "video",
            title: result.title || "Media"
        });

        logger.info({
            requestId: req.id,
            platform,
            operation: "extract",
            status: "success",
            durationMs: Date.now() - startTime,
            url: validatedUrl
        });

        // Return opaque media references
        res.json({
            media: registered,
            streamUrl: `/api/media/${registered.id}`,
            downloadUrl: `/api/media/${registered.id}?download=1`,
            // Backward-compatibility field
            videoUrl: `/api/media/${registered.id}`
        });

    } catch (err) {
        logger.error({
            requestId: req.id,
            platform,
            operation: "extract",
            status: "error",
            durationMs: Date.now() - startTime,
            message: err.message
        });

        const statusCode = err instanceof ValidationError ? 400 : 502;
        const errorCode = err.code || "EXTRACTION_FAILED";

        res.status(statusCode).json({
            error: {
                code: errorCode,
                message: err.message || "We could not retrieve media from this link."
            },
            requestId: req.id
        });
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
    let fetchHandle;

    try {
        const maxMediaSize = parseInt(process.env.MAX_MEDIA_SIZE_BYTES || String(DEFAULT_MAX_MEDIA_BYTES), 10);

        // Secure fetch with SSRF, redirect, and size controls
        fetchHandle = await secureFetch(mediaEntry.upstreamUrl, {
            allowedDomains: SUPPORTED_MEDIA_DOMAINS,
            maxSizeBytes: maxMediaSize,
            maxRedirects: 3,
            timeoutMs: 30000,
            headers: {
                "Referer": "https://www.instagram.com/"
            }
        });

        const { response } = fetchHandle;

        if (!response.ok) {
            return res.status(502).json({
                error: {
                    code: "UPSTREAM_FETCH_FAILED",
                    message: `Could not retrieve media from upstream provider (HTTP ${response.status}).`
                },
                requestId: req.id
            });
        }

        const rawContentType = response.headers.get("content-type") || "video/mp4";

        // Validate upstream Content-Type
        if (!isPermittedMediaContentType(rawContentType)) {
            fetchHandle.abort();
            return res.status(502).json({
                error: {
                    code: "UNSAFE_CONTENT_TYPE",
                    message: "The upstream media stream returned an invalid or unsupported content type."
                },
                requestId: req.id
            });
        }

        // Set safe response headers
        const fileExt = mediaEntry.type === "image" ? "jpg" : "mp4";
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

        // Cancel upstream fetch if client disconnects
        req.on("close", () => {
            if (!res.writableEnded) {
                fetchHandle.abort();
            }
        });

        response.body.pipe(meter).pipe(res);

    } catch (err) {
        if (fetchHandle) fetchHandle.abort();

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
app.get("/api/media/:mediaId", mediaStreamLimiter, extractionConcurrencyLimiter, async (req, res) => {
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
app.get("/api/proxy", mediaStreamLimiter, extractionConcurrencyLimiter, async (req, res) => {
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
        message: err.message,
        stack: process.env.NODE_ENV === "development" ? err.stack : undefined
    });

    res.status(err.statusCode || 500).json({
        error: {
            code: err.code || "INTERNAL_SERVER_ERROR",
            message: "An internal server error occurred."
        },
        requestId: req.id
    });
});

// ================== SERVER LIFECYCLE ==================
if (require.main === module) {
    app.listen(PORT, () => {
        logger.info({
            message: `Reeva backend is live on port ${PORT} [NODE_ENV=${process.env.NODE_ENV || "development"}]`
        });
    });
}

module.exports = app;
