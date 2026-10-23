// tests/platform-gates.test.cjs — Phase 4.2A Production Platform Feature Gates Regression Tests
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("express");

const {
    validateServerConfig,
    parseFeatureFlag,
    parseFeatureGates,
    isPlatformEnabled,
    isAudioOnlyEnabled,
    PLATFORM_GATE_MAP
} = require("../lib/config.cjs");
const { createExtractionOrchestrator } = require("../lib/extraction/index.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../lib/extraction/types.cjs");
const { ValidationError } = require("../lib/url-validator.cjs");
const { stopDefaultEgressProxy } = require("../lib/extraction/egress-proxy.cjs");
const { destroyHttpAgents } = require("../lib/http-client.cjs");

// Helper to close test HTTP server reliably
async function closeServer(server) {
    if (!server) return;
    if (server._sockets) {
        for (const s of server._sockets) {
            try { s.destroy(); } catch (_) {}
        }
        server._sockets.clear();
    }
    if (typeof server.closeAllConnections === "function") {
        try { server.closeAllConnections(); } catch (_) {}
    }
    await new Promise((resolve) => server.close(resolve));
}

function httpRequest({ port, path, headers = {} }) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: "127.0.0.1",
            port,
            path,
            method: "GET",
            headers
        }, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    text: () => Promise.resolve(data),
                    json: () => Promise.resolve(JSON.parse(data))
                });
            });
        });
        req.on("error", reject);
        req.end();
    });
}

// =========================================================================
// 1. Feature Flag & Gate Parsing in Production and Development
// =========================================================================

test("parseFeatureFlag: Strictly parses boolean tokens and fails closed on invalid input", () => {
    // Valid truthy
    assert.strictEqual(parseFeatureFlag("true"), true);
    assert.strictEqual(parseFeatureFlag("TRUE"), true);
    assert.strictEqual(parseFeatureFlag("1"), true);
    assert.strictEqual(parseFeatureFlag(true), true);
    assert.strictEqual(parseFeatureFlag(1), true);

    // Valid falsy
    assert.strictEqual(parseFeatureFlag("false"), false);
    assert.strictEqual(parseFeatureFlag("FALSE"), false);
    assert.strictEqual(parseFeatureFlag("0"), false);
    assert.strictEqual(parseFeatureFlag(false), false);
    assert.strictEqual(parseFeatureFlag(0), false);

    // Unspecified / empty falls back to default
    assert.strictEqual(parseFeatureFlag(undefined, false), false);
    assert.strictEqual(parseFeatureFlag(undefined, true), true);
    assert.strictEqual(parseFeatureFlag(null, false), false);
    assert.strictEqual(parseFeatureFlag(null, true), true);
    assert.strictEqual(parseFeatureFlag("", false), false);
    assert.strictEqual(parseFeatureFlag("   ", true), true);

    // Fail-closed on invalid values: MUST NOT resolve to true even if default was true
    assert.strictEqual(parseFeatureFlag("yes", true), false);
    assert.strictEqual(parseFeatureFlag("enable", true), false);
    assert.strictEqual(parseFeatureFlag("2", true), false);
    assert.strictEqual(parseFeatureFlag("invalid", true), false);
    assert.strictEqual(parseFeatureFlag("true1", true), false);
    assert.strictEqual(parseFeatureFlag("-1", true), false);
    assert.strictEqual(parseFeatureFlag({}, true), false);
    assert.strictEqual(parseFeatureFlag([], true), false);
});

test("parseFeatureGates: In production (NODE_ENV=production), unspecified flags default to disabled", () => {
    const gates = parseFeatureGates({ NODE_ENV: "production" });

    assert.strictEqual(gates.instagram, false);
    assert.strictEqual(gates.facebook, false);
    assert.strictEqual(gates.twitter, false);
    assert.strictEqual(gates.x, false);
    assert.strictEqual(gates.pinterest, false);
    assert.strictEqual(gates.youtube, false);
    assert.strictEqual(gates.tiktok, false);
    assert.strictEqual(gates.generic, false);
    assert.strictEqual(gates.more_sites, false);
    assert.strictEqual(gates.audioOnly, false);
});

test("parseFeatureGates: In production, explicit valid configuration enables only the target integration", () => {
    const gates = parseFeatureGates({
        NODE_ENV: "production",
        REEVA_ENABLE_INSTAGRAM: "true",
        REEVA_ENABLE_YOUTUBE: "1"
    });

    assert.strictEqual(gates.instagram, true);
    assert.strictEqual(gates.youtube, true);

    // All others remain disabled
    assert.strictEqual(gates.facebook, false);
    assert.strictEqual(gates.twitter, false);
    assert.strictEqual(gates.x, false);
    assert.strictEqual(gates.pinterest, false);
    assert.strictEqual(gates.tiktok, false);
    assert.strictEqual(gates.generic, false);
    assert.strictEqual(gates.more_sites, false);
    assert.strictEqual(gates.audioOnly, false);
});

test("parseFeatureGates: In production, invalid configuration cannot silently enable integrations", () => {
    const gates = parseFeatureGates({
        NODE_ENV: "production",
        REEVA_ENABLE_INSTAGRAM: "invalid_value",
        REEVA_ENABLE_FACEBOOK: "yes",
        REEVA_ENABLE_TIKTOK: "2",
        REEVA_ENABLE_GENERIC: "enabled",
        REEVA_ENABLE_AUDIO_ONLY: "positive"
    });

    assert.strictEqual(gates.instagram, false);
    assert.strictEqual(gates.facebook, false);
    assert.strictEqual(gates.tiktok, false);
    assert.strictEqual(gates.generic, false);
    assert.strictEqual(gates.more_sites, false);
    assert.strictEqual(gates.audioOnly, false);
});

test("parseFeatureGates: Platform aliases share identical configuration decisions", () => {
    // Twitter / X via REEVA_ENABLE_X
    const gatesViaX = parseFeatureGates({ NODE_ENV: "production", REEVA_ENABLE_X: "true" });
    assert.strictEqual(gatesViaX.x, true);
    assert.strictEqual(gatesViaX.twitter, true);

    // Twitter / X via REEVA_ENABLE_TWITTER
    const gatesViaTwitter = parseFeatureGates({ NODE_ENV: "production", REEVA_ENABLE_TWITTER: "1" });
    assert.strictEqual(gatesViaTwitter.x, true);
    assert.strictEqual(gatesViaTwitter.twitter, true);

    // Generic / More Sites via REEVA_ENABLE_GENERIC
    const gatesViaGeneric = parseFeatureGates({ NODE_ENV: "production", REEVA_ENABLE_GENERIC: "true" });
    assert.strictEqual(gatesViaGeneric.generic, true);
    assert.strictEqual(gatesViaGeneric.more_sites, true);

    // Generic / More Sites via REEVA_ENABLE_MORE_SITES
    const gatesViaMoreSites = parseFeatureGates({ NODE_ENV: "production", REEVA_ENABLE_MORE_SITES: "1" });
    assert.strictEqual(gatesViaMoreSites.generic, true);
    assert.strictEqual(gatesViaMoreSites.more_sites, true);
});

test("parseFeatureGates: Outside production (development/test), defaults to enabled unless explicitly disabled", () => {
    // Test environment default
    const testGates = parseFeatureGates({ NODE_ENV: "test" });
    assert.strictEqual(testGates.instagram, true);
    assert.strictEqual(testGates.youtube, true);
    assert.strictEqual(testGates.generic, true);
    assert.strictEqual(testGates.audioOnly, true);

    // Explicit disable in dev/test
    const devDisabled = parseFeatureGates({
        NODE_ENV: "development",
        REEVA_ENABLE_INSTAGRAM: "false",
        REEVA_ENABLE_TIKTOK: "0",
        REEVA_ENABLE_AUDIO_ONLY: "false"
    });
    assert.strictEqual(devDisabled.instagram, false);
    assert.strictEqual(devDisabled.tiktok, false);
    assert.strictEqual(devDisabled.audioOnly, false);
    assert.strictEqual(devDisabled.youtube, true); // unconfigured retains dev default
});

test("validateServerConfig: Attaches validated features dictionary to server configuration", () => {
    const config = validateServerConfig({
        NODE_ENV: "production",
        REEVA_ENABLE_PINTEREST: "true"
    });

    assert.ok(config.features);
    assert.strictEqual(config.features.pinterest, true);
    assert.strictEqual(config.features.youtube, false);
    assert.strictEqual(config.features.audioOnly, false);
});

// =========================================================================
// 2. Adapter Gating & Execution Prevention
// =========================================================================

test("Gating: Disabled platform throws PLATFORM_DISABLED and NEVER invokes adapter", async () => {
    let adapterCalled = false;
    const mockInstagramAdapter = async () => {
        adapterCalled = true;
        return { url: "https://scontent.cdninstagram.com/v/test.mp4", type: "video", title: "Test" };
    };

    const orchestrator = createExtractionOrchestrator({
        adapters: { instagram: mockInstagramAdapter },
        features: { instagram: false }
    });

    await assert.rejects(
        () => orchestrator.extractMedia({
            platform: "instagram",
            sourceUrl: "https://www.instagram.com/reel/C3456789abc/"
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.strictEqual(err.code, "PLATFORM_DISABLED");
            assert.strictEqual(err.statusCode, 503);
            assert.match(err.message, /This platform integration is currently disabled/);
            return true;
        }
    );

    // CRITICAL: Adapter must NEVER have been called
    assert.strictEqual(adapterCalled, false);
});

test("Gating: Disabled YouTube integration does NOT spawn runner or invoke adapter", async () => {
    let runnerCalled = false;
    const mockYouTubeAdapter = async () => {
        runnerCalled = true;
        return { url: "https://rr1---sn.googlevideo.com/videoplayback?id=123", type: "video", title: "Test" };
    };

    const orchestrator = createExtractionOrchestrator({
        adapters: { youtube: mockYouTubeAdapter },
        features: { youtube: false }
    });

    // Test VIDEO_AND_AUDIO
    await assert.rejects(
        () => orchestrator.extractMedia({
            platform: "youtube",
            sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            mode: "VIDEO_AND_AUDIO"
        }),
        (err) => {
            assert.strictEqual(err.code, "PLATFORM_DISABLED");
            assert.strictEqual(err.statusCode, 503);
            return true;
        }
    );

    // Test VIDEO_ONLY
    await assert.rejects(
        () => orchestrator.extractMedia({
            platform: "youtube",
            sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            mode: "VIDEO_ONLY"
        }),
        (err) => {
            assert.strictEqual(err.code, "PLATFORM_DISABLED");
            assert.strictEqual(err.statusCode, 503);
            return true;
        }
    );

    // Test AUDIO_ONLY
    await assert.rejects(
        () => orchestrator.extractMedia({
            platform: "youtube",
            sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            mode: "AUDIO_ONLY"
        }),
        (err) => {
            assert.strictEqual(err.code, "PLATFORM_DISABLED");
            assert.strictEqual(err.statusCode, 503);
            return true;
        }
    );

    assert.strictEqual(runnerCalled, false);
});

test("Gating: Audio-only extraction is rejected with MODE_DISABLED when audioOnly is disabled", async () => {
    let youtubeAdapterCalled = false;
    const mockYouTubeAdapter = async (url, opts) => {
        youtubeAdapterCalled = true;
        return { url: "https://rr1---sn.googlevideo.com/videoplayback?id=123", type: opts.mode === "AUDIO_ONLY" ? "audio" : "video", title: "Test" };
    };

    // YouTube is ENABLED, but audioOnly is DISABLED
    const orchestrator = createExtractionOrchestrator({
        adapters: { youtube: mockYouTubeAdapter },
        features: { youtube: true, audioOnly: false }
    });

    // 1. AUDIO_ONLY is rejected
    await assert.rejects(
        () => orchestrator.extractMedia({
            platform: "youtube",
            sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            mode: "AUDIO_ONLY"
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.strictEqual(err.code, "MODE_DISABLED");
            assert.strictEqual(err.statusCode, 503);
            assert.match(err.message, /Audio-only extraction is currently disabled/);
            return true;
        }
    );
    assert.strictEqual(youtubeAdapterCalled, false);

    // 2. VIDEO_AND_AUDIO succeeds on the same enabled platform
    const res = await orchestrator.extractMedia({
        platform: "youtube",
        sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        mode: "VIDEO_AND_AUDIO"
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(youtubeAdapterCalled, true);
});

test("Gating: Generic/More Sites audio-only obeys audioOnly feature gate", async () => {
    let genericAdapterCalled = false;
    const mockGenericAdapter = async () => {
        genericAdapterCalled = true;
        return { url: "https://example.com/stream.m4a", type: "audio", title: "Test Audio", localFilePath: "/tmp/fake.m4a" };
    };

    const orchestrator = createExtractionOrchestrator({
        adapters: { generic: mockGenericAdapter },
        features: { generic: true, audioOnly: false }
    });

    await assert.rejects(
        () => orchestrator.extractMedia({
            platform: "generic",
            sourceUrl: "https://example.com/audio-test",
            mode: "AUDIO_ONLY"
        }),
        (err) => {
            assert.strictEqual(err.code, "MODE_DISABLED");
            assert.strictEqual(err.statusCode, 503);
            return true;
        }
    );
    assert.strictEqual(genericAdapterCalled, false);
});

test("Gating: Disabled integrations bypass cache and in-flight operations", async () => {
    const mockCache = new Map();
    // Pre-populate cache with a valid-looking media entry
    mockCache.set("https://www.instagram.com/p/C3456789abc/", {
        url: "https://scontent.cdninstagram.com/v/cached.mp4",
        type: "video",
        title: "Cached Reel"
    });

    const orchestrator = createExtractionOrchestrator({
        cache: {
            get: (key) => mockCache.get(key),
            set: (key, val) => mockCache.set(key, val),
            delete: (key) => mockCache.delete(key)
        },
        features: { instagram: false }
    });

    // Requesting a disabled platform MUST fail closed even if cached
    await assert.rejects(
        () => orchestrator.extractMedia({
            platform: "instagram",
            sourceUrl: "https://www.instagram.com/p/C3456789abc/"
        }),
        (err) => {
            assert.strictEqual(err.code, "PLATFORM_DISABLED");
            assert.strictEqual(err.statusCode, 503);
            return true;
        }
    );
});

test("Gating: URL and platform validation errors take precedence over disabled gate", async () => {
    const orchestrator = createExtractionOrchestrator({
        features: { instagram: false, youtube: false }
    });

    // 1. Missing URL -> 400 MISSING_URL (not 503)
    await assert.rejects(
        () => orchestrator.extractMedia({ platform: "instagram", sourceUrl: "" }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.strictEqual(err.code, "MISSING_URL");
            return true;
        }
    );

    // 2. Unsupported protocol -> 400 UNSUPPORTED_PROTOCOL (not 503)
    await assert.rejects(
        () => orchestrator.extractMedia({ platform: "instagram", sourceUrl: "http://www.instagram.com/p/123/" }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.strictEqual(err.code, "UNSUPPORTED_PROTOCOL");
            return true;
        }
    );

    // 3. Disallowed domain -> 400 DISALLOWED_DOMAIN (not 503)
    await assert.rejects(
        () => orchestrator.extractMedia({ platform: "instagram", sourceUrl: "https://evil.com/video.mp4" }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.strictEqual(err.code, "DISALLOWED_DOMAIN");
            return true;
        }
    );

    // 4. Unsupported platform -> 400 UNSUPPORTED_PLATFORM
    await assert.rejects(
        () => orchestrator.extractMedia({ platform: "nonexistent", sourceUrl: "https://example.com" }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.strictEqual(err.code, "UNSUPPORTED_PLATFORM");
            return true;
        }
    );

    // 5. Invalid mode -> 400 UNSUPPORTED_MEDIA
    await assert.rejects(
        () => orchestrator.extractMedia({
            platform: "youtube",
            sourceUrl: "https://www.youtube.com/watch?v=123",
            mode: "INVALID_MODE"
        }),
        (err) => {
            assert.strictEqual(err.code, "UNSUPPORTED_MEDIA");
            return true;
        }
    );
});

// =========================================================================
// 3. Server HTTP Integration & Public Capabilities Endpoint Tests
// =========================================================================

test("HTTP Endpoint: Disabled platform returns clean, sanitized HTTP 503 response", async () => {
    // Spin up an isolated express app mirroring server.cjs error sanitization and gating
    const app = express();
    const mockGates = { instagram: false, youtube: true, audioOnly: false };

    app.get("/api/download/:platform", async (req, res) => {
        try {
            const orchestrator = createExtractionOrchestrator({
                features: mockGates
            });
            await orchestrator.extractMedia({
                platform: req.params.platform,
                sourceUrl: req.query.url,
                mode: req.query.mode,
                features: mockGates
            });
            res.json({ success: true });
        } catch (err) {
            // Error mapping identical to server.cjs
            const statusCode = err.statusCode || 500;
            const code = err.code || "INTERNAL_ERROR";
            res.status(statusCode).json({
                error: {
                    code,
                    message: err.message
                },
                requestId: "test_req_123"
            });
        }
    });

    const server = http.createServer(app);
    server._sockets = new Set();
    server.on("connection", (s) => {
        server._sockets.add(s);
        s.on("close", () => server._sockets.delete(s));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
        const res = await httpRequest({
            port,
            path: "/api/download/instagram?url=https://www.instagram.com/reel/C3456789abc/"
        });

        assert.strictEqual(res.status, 503);
        const data = await res.json();
        assert.strictEqual(data.error.code, "PLATFORM_DISABLED");
        assert.strictEqual(data.error.message, "This platform integration is currently disabled.");
        assert.strictEqual(data.requestId, "test_req_123");

        // Verify no stack trace or path leaked
        assert.strictEqual(data.stack, undefined);
        assert.strictEqual(data.details, undefined);
    } finally {
        await closeServer(server);
    }
});

test("HTTP Endpoint: GET /api/capabilities accurately surfaces public feature gate state", async () => {
    const serverApp = require("../server.cjs");
    const server = http.createServer(serverApp);
    server._sockets = new Set();
    server.on("connection", (s) => {
        server._sockets.add(s);
        s.on("close", () => server._sockets.delete(s));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
        const res = await httpRequest({ port, path: "/api/capabilities" });
        assert.strictEqual(res.status, 200);
        const data = await res.json();

        assert.ok(data.capabilities);
        assert.ok(data.capabilities.platforms);
        assert.strictEqual(typeof data.capabilities.platforms.instagram, "boolean");
        assert.strictEqual(typeof data.capabilities.platforms.facebook, "boolean");
        assert.strictEqual(typeof data.capabilities.platforms.twitter, "boolean");
        assert.strictEqual(typeof data.capabilities.platforms.pinterest, "boolean");
        assert.strictEqual(typeof data.capabilities.platforms.youtube, "boolean");
        assert.strictEqual(typeof data.capabilities.platforms.tiktok, "boolean");
        assert.strictEqual(typeof data.capabilities.platforms.generic, "boolean");
        assert.strictEqual(typeof data.capabilities.audioOnly, "boolean");

        // Asserts zero confidential configuration leaked
        assert.strictEqual(data.capabilities.env, undefined);
        assert.strictEqual(data.capabilities.trustProxy, undefined);
        assert.strictEqual(data.capabilities.paths, undefined);
    } finally {
        await closeServer(server);
    }
});

after(async () => {
    destroyHttpAgents();
    http.globalAgent.destroy();
    await stopDefaultEgressProxy();
});
