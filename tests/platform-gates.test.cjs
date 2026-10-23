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

const { createAppController } = require("../public/app.js");
const stateModule = require("../public/js/state.js");
const apiModule = require("../public/js/api.js");
const uiModule = require("../public/js/ui.js");
const i18nModule = require("../public/js/i18n.js");

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

test("parseFeatureGates: Only development and test default to enabled; staging, preview, and unset fail closed", () => {
    // 1. Explicit development and test default to enabled
    const testGates = parseFeatureGates({ NODE_ENV: "test" });
    assert.strictEqual(testGates.instagram, true);
    assert.strictEqual(testGates.youtube, true);
    assert.strictEqual(testGates.generic, true);
    assert.strictEqual(testGates.audioOnly, true);

    const devGates = parseFeatureGates({ NODE_ENV: "development" });
    assert.strictEqual(devGates.instagram, true);
    assert.strictEqual(devGates.youtube, true);
    assert.strictEqual(devGates.audioOnly, true);

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

    // 2. Strict fail-closed environments: staging, preview, empty string, undefined, unrecognized
    const failClosedEnvs = [
        { NODE_ENV: "staging" },
        { NODE_ENV: "preview" },
        { NODE_ENV: "qa" },
        { NODE_ENV: "production" },
        { NODE_ENV: "" },
        { NODE_ENV: "   " },
        {},
        { NODE_ENV: "unknown_custom_env" }
    ];

    for (const envObj of failClosedEnvs) {
        const gates = parseFeatureGates(envObj);
        assert.strictEqual(gates.instagram, false, `instagram must be false for ${JSON.stringify(envObj)}`);
        assert.strictEqual(gates.facebook, false, `facebook must be false for ${JSON.stringify(envObj)}`);
        assert.strictEqual(gates.twitter, false, `twitter must be false for ${JSON.stringify(envObj)}`);
        assert.strictEqual(gates.x, false, `x must be false for ${JSON.stringify(envObj)}`);
        assert.strictEqual(gates.pinterest, false, `pinterest must be false for ${JSON.stringify(envObj)}`);
        assert.strictEqual(gates.youtube, false, `youtube must be false for ${JSON.stringify(envObj)}`);
        assert.strictEqual(gates.tiktok, false, `tiktok must be false for ${JSON.stringify(envObj)}`);
        assert.strictEqual(gates.generic, false, `generic must be false for ${JSON.stringify(envObj)}`);
        assert.strictEqual(gates.more_sites, false, `more_sites must be false for ${JSON.stringify(envObj)}`);
        assert.strictEqual(gates.audioOnly, false, `audioOnly must be false for ${JSON.stringify(envObj)}`);
    }

    // 3. Staging / preview with explicit valid configuration enables only configured target
    const stagingConfigured = parseFeatureGates({
        NODE_ENV: "staging",
        REEVA_ENABLE_TIKTOK: "true",
        REEVA_ENABLE_AUDIO_ONLY: "1"
    });
    assert.strictEqual(stagingConfigured.tiktok, true);
    assert.strictEqual(stagingConfigured.audioOnly, true);
    assert.strictEqual(stagingConfigured.instagram, false);
    assert.strictEqual(stagingConfigured.youtube, false);
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
// 3. Frontend Capability Safety & Availability-State Tests
// =========================================================================

function createMockDOM(initialValues = {}) {
    const createEl = (id, tag = "div", extra = {}) => {
        const attrs = new Map();
        const classes = new Set(extra.classes || []);
        const elListeners = new Map();
        return {
            id,
            tagName: tag.toUpperCase(),
            disabled: extra.disabled !== undefined ? extra.disabled : false,
            value: extra.value !== undefined ? extra.value : "",
            checked: extra.checked !== undefined ? extra.checked : false,
            textContent: "",
            style: {},
            dataset: extra.dataset || {},
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                contains: (c) => classes.has(c)
            },
            setAttribute: (k, v) => attrs.set(k, String(v)),
            getAttribute: (k) => attrs.get(k) || null,
            removeAttribute: (k) => attrs.delete(k),
            addEventListener: (evt, handler) => {
                if (!elListeners.has(evt)) elListeners.set(evt, []);
                elListeners.get(evt).push(handler);
            },
            dispatchEvent: (evt) => {
                const handlers = elListeners.get(evt.type) || [];
                handlers.forEach((h) => h(evt));
            }
        };
    };

    const platformBtns = ["instagram", "facebook", "twitter", "pinterest", "youtube", "tiktok", "generic"].map((plat) => {
        return createEl(`btn-${plat}`, "button", {
            classes: ["platform-btn"],
            dataset: { platform: plat }
        });
    });

    const elementsById = {
        "app-heading": createEl("app-heading"),
        "app-subtitle": createEl("app-subtitle"),
        "input-instruction": createEl("input-instruction"),
        "lang-label": createEl("lang-label"),
        "lang-select": createEl("lang-select", "select", { value: "en" }),
        "get": createEl("get", "button", { classes: ["action"], disabled: true }),
        "download": createEl("download", "button", { classes: ["action", "hidden"] }),
        "url": createEl("url", "input", { value: initialValues.url !== undefined ? initialValues.url : "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
        "log": createEl("log", "div"),
        "preview": createEl("preview", "video", { classes: ["hidden"] }),
        "consent": createEl("consent", "input", { checked: initialValues.consent !== undefined ? initialValues.consent : true }),
        "consent-text": createEl("consent-text"),
        "why-consent": createEl("why-consent", "a"),
        "footer-disclaimer": createEl("footer-disclaimer"),
        "footer-copyright": createEl("footer-copyright")
    };

    const doc = {
        getElementById: (id) => elementsById[id] || null,
        querySelectorAll: (selector) => {
            if (selector === ".platform-btn") return platformBtns;
            return [];
        },
        elementsById,
        platformBtns
    };

    return { doc, elementsById, platformBtns };
}

test("Frontend Capability Safety: Platform buttons and Get button initialize disabled", () => {
    const { doc, elementsById, platformBtns } = createMockDOM();
    const state = stateModule.createState();

    const app = createAppController({
        document: doc,
        state,
        api: apiModule,
        uiModule,
        i18n: i18nModule,
        fetchFn: () => new Promise(() => {}) // pending
    });

    assert.strictEqual(app.getCapabilitiesLoaded(), false);
    assert.strictEqual(elementsById.get.disabled, true);
    assert.strictEqual(elementsById.get.getAttribute("aria-disabled"), "true");

    platformBtns.forEach((btn) => {
        assert.strictEqual(btn.disabled, true);
        assert.strictEqual(btn.getAttribute("aria-disabled"), "true");
        assert.strictEqual(btn.classList.contains("disabled"), true);
        assert.strictEqual(btn.classList.contains("active"), false);
    });
});

test("Frontend Capability Safety: No extraction request occurs before capabilities are successfully loaded", async () => {
    const { doc, elementsById } = createMockDOM();
    const state = stateModule.createState();
    let fetchMediaCalls = 0;
    const mockApi = {
        ...apiModule,
        fetchMedia: async () => {
            fetchMediaCalls++;
            return { success: true };
        }
    };

    const mockFetch = () => new Promise(() => {}); // never resolves during check

    const app = createAppController({
        document: doc,
        state,
        api: mockApi,
        uiModule,
        i18n: i18nModule,
        fetchFn: mockFetch
    });

    assert.strictEqual(app.getCapabilitiesLoaded(), false);
    assert.strictEqual(elementsById.get.disabled, true);

    await app.handleGetMedia();

    assert.strictEqual(fetchMediaCalls, 0, "fetchMedia must not be invoked before capabilities load");
    assert.match(elementsById.log.textContent, /Unable to verify available services/);
    assert.strictEqual(state.getStatus(), "idle");
});

test("Frontend Capability Safety: No extraction request occurs after capability request fails", async () => {
    const { doc, elementsById } = createMockDOM();
    const state = stateModule.createState();
    let fetchMediaCalls = 0;
    const mockApi = {
        ...apiModule,
        fetchMedia: async () => {
            fetchMediaCalls++;
            return { success: true };
        }
    };

    const mockFetch = async () => ({ ok: false, status: 500 });

    const app = createAppController({
        document: doc,
        state,
        api: mockApi,
        uiModule,
        i18n: i18nModule,
        fetchFn: mockFetch
    });

    await app.capabilitiesPromise;

    assert.strictEqual(app.getCapabilitiesLoaded(), false);
    assert.strictEqual(app.getVerifiedPlatforms(), null);
    assert.strictEqual(elementsById.get.disabled, true);

    await app.handleGetMedia();

    assert.strictEqual(fetchMediaCalls, 0, "fetchMedia must not be invoked after capabilities failure");
    assert.match(elementsById.log.textContent, /Unable to verify available services/);
});

test("Frontend Capability Safety: Selected platform cannot silently fall back to default Instagram when availability is unknown", async () => {
    const { doc, elementsById } = createMockDOM({ url: "https://www.instagram.com/reel/C3456789abc/" });
    const state = stateModule.createState();
    assert.strictEqual(state.getPlatform(), "instagram");

    let attemptedPlatform = null;
    const mockApi = {
        ...apiModule,
        fetchMedia: async (plat) => {
            attemptedPlatform = plat;
            return { success: true };
        }
    };

    const mockFetch = async () => ({ ok: false, status: 503 });

    const app = createAppController({
        document: doc,
        state,
        api: mockApi,
        uiModule,
        i18n: i18nModule,
        fetchFn: mockFetch
    });

    await app.capabilitiesPromise;

    // Platform must be cleared and not silently left at instagram
    assert.strictEqual(state.getPlatform(), null);
    assert.strictEqual(elementsById.get.disabled, true);

    await app.handleGetMedia();

    assert.strictEqual(attemptedPlatform, null, "Instagram extraction must not be dispatched as silent fallback");
    assert.match(elementsById.log.textContent, /Unable to verify available services/);
});

test("Frontend Capability Safety: No extraction request occurs when all platforms are disabled", async () => {
    const { doc, elementsById } = createMockDOM();
    const state = stateModule.createState();
    let fetchMediaCalls = 0;
    const mockApi = {
        ...apiModule,
        fetchMedia: async () => {
            fetchMediaCalls++;
            return { success: true };
        }
    };

    const mockFetch = async () => ({
        ok: true,
        json: async () => ({
            capabilities: {
                platforms: {
                    instagram: false,
                    facebook: false,
                    twitter: false,
                    pinterest: false,
                    youtube: false,
                    tiktok: false,
                    generic: false
                },
                audioOnly: false
            }
        })
    });

    const app = createAppController({
        document: doc,
        state,
        api: mockApi,
        uiModule,
        i18n: i18nModule,
        fetchFn: mockFetch
    });

    await app.capabilitiesPromise;

    assert.strictEqual(app.getCapabilitiesLoaded(), true);
    assert.strictEqual(state.getPlatform(), null);
    assert.strictEqual(elementsById.get.disabled, true);
    assert.match(elementsById.log.textContent, /All platform integrations are currently disabled/);

    await app.handleGetMedia();

    assert.strictEqual(fetchMediaCalls, 0, "No extraction can occur when all platforms are disabled");
});

test("Frontend Capability Safety: A platform explicitly reported as disabled cannot be submitted", async () => {
    const { doc, elementsById, platformBtns } = createMockDOM();
    const state = stateModule.createState();
    let fetchMediaCalls = 0;
    const mockApi = {
        ...apiModule,
        fetchMedia: async () => {
            fetchMediaCalls++;
            return { success: true };
        }
    };

    const mockFetch = async () => ({
        ok: true,
        json: async () => ({
            capabilities: {
                platforms: {
                    instagram: false,
                    facebook: false,
                    twitter: false,
                    pinterest: false,
                    youtube: true,
                    tiktok: false,
                    generic: false
                },
                audioOnly: false
            }
        })
    });

    const app = createAppController({
        document: doc,
        state,
        api: mockApi,
        uiModule,
        i18n: i18nModule,
        fetchFn: mockFetch
    });

    await app.capabilitiesPromise;

    assert.strictEqual(state.getPlatform(), "youtube");

    // Disabled instagram button cannot be clicked
    const igBtn = platformBtns.find((b) => b.dataset.platform === "instagram");
    assert.strictEqual(igBtn.disabled, true);
    igBtn.dispatchEvent({ type: "click" });
    assert.strictEqual(state.getPlatform(), "youtube", "Clicking disabled instagram button must not select it");

    // Forced state modification is still blocked by handleGetMedia
    state.setPlatform("instagram");
    await app.handleGetMedia();

    assert.strictEqual(fetchMediaCalls, 0, "Disabled platform must not be submitted");
    assert.match(elementsById.log.textContent, /This platform is currently disabled/);
});

test("Frontend Capability Safety: A platform explicitly reported as enabled can be submitted after successful initialization", async () => {
    const { doc, elementsById } = createMockDOM({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", consent: true });
    const state = stateModule.createState();
    let dispatchedPlatform = null;
    let dispatchedUrl = null;
    const mockApi = {
        ...apiModule,
        fetchMedia: async (plat, url) => {
            dispatchedPlatform = plat;
            dispatchedUrl = url;
            return {
                success: true,
                streamUrl: "/api/media/med_12345678abcdef",
                downloadUrl: "/api/media/med_12345678abcdef?download=1"
            };
        }
    };

    const mockFetch = async () => ({
        ok: true,
        json: async () => ({
            capabilities: {
                platforms: {
                    instagram: false,
                    facebook: false,
                    twitter: false,
                    pinterest: false,
                    youtube: true,
                    tiktok: false,
                    generic: false
                },
                audioOnly: false
            }
        })
    });

    const app = createAppController({
        document: doc,
        state,
        api: mockApi,
        uiModule,
        i18n: i18nModule,
        fetchFn: mockFetch
    });

    await app.capabilitiesPromise;

    assert.strictEqual(state.getPlatform(), "youtube");
    assert.strictEqual(elementsById.get.disabled, false);

    await app.handleGetMedia();

    assert.strictEqual(dispatchedPlatform, "youtube");
    assert.strictEqual(dispatchedUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    assert.strictEqual(state.getStatus(), "success");
    assert.strictEqual(elementsById.download.classList.contains("hidden"), false);
    assert.strictEqual(elementsById.preview.classList.contains("hidden"), false);
});

test("Frontend Capability Safety: Consent validation, empty URL check, and cancellation guards remain intact", async () => {
    // 1. Consent validation
    const { doc: docNoConsent, elementsById: elNoConsent } = createMockDOM({ consent: false, url: "https://youtube.com/watch?v=123" });
    const state1 = stateModule.createState();
    let fetchCalls = 0;
    let alerted = null;
    const mockApi = {
        ...apiModule,
        fetchMedia: async () => { fetchCalls++; return { success: true }; }
    };
    const mockFetch = async () => ({
        ok: true,
        json: async () => ({ capabilities: { platforms: { youtube: true } } })
    });

    const app1 = createAppController({
        document: docNoConsent,
        state: state1,
        api: mockApi,
        uiModule,
        i18n: i18nModule,
        fetchFn: mockFetch,
        window: { alert: (msg) => { alerted = msg; } }
    });
    await app1.capabilitiesPromise;
    await app1.handleGetMedia();
    assert.strictEqual(fetchCalls, 0, "No request without consent");
    assert.ok(alerted);

    // 2. Empty URL validation
    const { doc: docEmptyUrl, elementsById: elEmptyUrl } = createMockDOM({ consent: true, url: "" });
    const state2 = stateModule.createState();
    const app2 = createAppController({
        document: docEmptyUrl,
        state: state2,
        api: mockApi,
        uiModule,
        i18n: i18nModule,
        fetchFn: mockFetch
    });
    await app2.capabilitiesPromise;
    await app2.handleGetMedia();
    assert.strictEqual(fetchCalls, 0, "No request with empty URL");
    assert.match(elEmptyUrl.log.textContent, /Please paste a video link first/i);
});

// =========================================================================
// 4. Server HTTP Integration & Public Capabilities Endpoint Tests
// =========================================================================

test("HTTP Integration: Real exported server.cjs under isolated NODE_ENV=production rejects disabled platforms with HTTP 503", async () => {
    const cp = require("child_process");
    const path = require("path");

    const reevaDir = path.resolve(__dirname, "..");
    const childScript = `
process.env.NODE_ENV = "production";
for (const k of Object.keys(process.env)) {
    if (k.startsWith("REEVA_ENABLE_")) delete process.env[k];
}
const http = require("http");
const app = require("./server.cjs");
const server = http.createServer(app);
server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    if (process.send) {
        process.send({ type: "ready", port });
    }
});
process.on("message", (msg) => {
    if (msg === "shutdown" || (msg && msg.type === "shutdown")) {
        server.close(() => process.exit(0));
    }
});
`;

    const child = cp.spawn(process.execPath, ["-e", childScript], {
        cwd: reevaDir,
        env: { ...process.env, NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "pipe", "ipc"]
    });

    try {
        const port = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("Timed out waiting for production child server ready message"));
            }, 8000);

            child.on("message", (msg) => {
                if (msg && msg.type === "ready") {
                    clearTimeout(timeout);
                    resolve(msg.port);
                }
            });

            child.on("error", (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            child.on("exit", (code) => {
                clearTimeout(timeout);
                reject(new Error(`Production child server exited unexpectedly with code ${code}`));
            });
        });

        // 1. Verify GET /api/download/instagram returns HTTP 503 PLATFORM_DISABLED
        const resInstagram = await httpRequest({
            port,
            path: "/api/download/instagram?url=https://www.instagram.com/reel/C3456789abc/"
        });
        assert.strictEqual(resInstagram.status, 503);
        const dataInstagram = await resInstagram.json();
        assert.strictEqual(dataInstagram.error.code, "PLATFORM_DISABLED");
        assert.strictEqual(dataInstagram.error.message, "This platform integration is currently disabled.");
        assert.ok(dataInstagram.requestId);
        assert.strictEqual(dataInstagram.stack, undefined);
        assert.strictEqual(dataInstagram.details, undefined);

        // 2. Verify GET /api/download/youtube returns HTTP 503 PLATFORM_DISABLED without running subprocess
        const resYouTube = await httpRequest({
            port,
            path: "/api/download/youtube?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        });
        assert.strictEqual(resYouTube.status, 503);
        const dataYouTube = await resYouTube.json();
        assert.strictEqual(dataYouTube.error.code, "PLATFORM_DISABLED");
        assert.strictEqual(dataYouTube.error.message, "This platform integration is currently disabled.");
        assert.ok(dataYouTube.requestId);

        // 3. Verify GET /api/capabilities surfaces all platforms disabled in production by default
        const resCaps = await httpRequest({ port, path: "/api/capabilities" });
        assert.strictEqual(resCaps.status, 200);
        const dataCaps = await resCaps.json();
        assert.ok(dataCaps.capabilities);
        assert.ok(dataCaps.capabilities.platforms);
        assert.strictEqual(dataCaps.capabilities.platforms.instagram, false);
        assert.strictEqual(dataCaps.capabilities.platforms.facebook, false);
        assert.strictEqual(dataCaps.capabilities.platforms.twitter, false);
        assert.strictEqual(dataCaps.capabilities.platforms.pinterest, false);
        assert.strictEqual(dataCaps.capabilities.platforms.youtube, false);
        assert.strictEqual(dataCaps.capabilities.platforms.tiktok, false);
        assert.strictEqual(dataCaps.capabilities.platforms.generic, false);
        assert.strictEqual(dataCaps.capabilities.audioOnly, false);
        assert.strictEqual(dataCaps.capabilities.env, undefined);
        assert.strictEqual(dataCaps.capabilities.trustProxy, undefined);
        assert.strictEqual(dataCaps.capabilities.paths, undefined);

    } finally {
        const exitPromise = new Promise((resolve) => {
            child.on("exit", resolve);
        });
        try {
            child.send("shutdown");
        } catch (_) {
            child.kill("SIGTERM");
        }
        await Promise.race([
            exitPromise,
            new Promise((resolve) => setTimeout(() => {
                try { child.kill("SIGKILL"); } catch (_) {}
                resolve();
            }, 3000))
        ]);
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
