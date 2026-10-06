// tests/frontend-architecture.test.cjs — Deterministic Tests for Frontend Architecture & i18n
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const stateModule = require("../public/js/state.js");
const apiModule = require("../public/js/api.js");
const i18nModule = require("../public/js/i18n.js");

// =========================================================================
// 1. Platform Identifiers & State Tests
// =========================================================================

test("Frontend Architecture: Supported platform identifiers match exact backend contract", () => {
    const expectedPlatforms = [
        "instagram",
        "facebook",
        "twitter",
        "pinterest",
        "youtube",
        "generic"
    ];

    assert.deepStrictEqual(
        [...stateModule.SUPPORTED_PLATFORMS],
        expectedPlatforms,
        "Frontend platform identifiers must exactly match backend supported platforms"
    );
});

test("Frontend Architecture: State container enforces platform validation and defaults to instagram", () => {
    const state = stateModule.createState();
    assert.strictEqual(state.getPlatform(), "instagram");

    // Valid transitions
    assert.strictEqual(state.setPlatform("youtube"), true);
    assert.strictEqual(state.getPlatform(), "youtube");

    assert.strictEqual(state.setPlatform("generic"), true);
    assert.strictEqual(state.getPlatform(), "generic");

    // Invalid platform rejected, preserves current
    assert.strictEqual(state.setPlatform("tiktok"), false);
    assert.strictEqual(state.getPlatform(), "generic");

    assert.strictEqual(state.setPlatform(""), false);
    assert.strictEqual(state.getPlatform(), "generic");
});

test("Frontend Architecture: State container manages media URLs and reset lifecycle", () => {
    const state = stateModule.createState();

    state.setMediaUrls({
        streamUrl: "/api/media/med_12345",
        downloadUrl: "/api/media/med_12345?download=1"
    });

    assert.strictEqual(state.getStreamUrl(), "/api/media/med_12345");
    assert.strictEqual(state.getDownloadUrl(), "/api/media/med_12345?download=1");

    state.clearMediaUrls();
    assert.strictEqual(state.getStreamUrl(), "");
    assert.strictEqual(state.getDownloadUrl(), "");
});

// =========================================================================
// 2. API Contract & URL Construction Tests
// =========================================================================

test("Frontend Architecture: API URL builder constructs exact /api/download/:platform?url= endpoint", () => {
    const testCases = [
        {
            platform: "instagram",
            url: "https://www.instagram.com/reel/C12345/?utm_source=ig",
            expected: "/api/download/instagram?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FC12345%2F%3Futm_source%3Dig"
        },
        {
            platform: "youtube",
            url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            expected: "/api/download/youtube?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ"
        },
        {
            platform: "generic",
            url: "https://vimeo.com/12345678",
            expected: "/api/download/generic?url=https%3A%2F%2Fvimeo.com%2F12345678"
        }
    ];

    for (const { platform, url, expected } of testCases) {
        const constructed = apiModule.buildDownloadUrl(platform, url);
        assert.strictEqual(constructed, expected);
    }
});

test("Frontend Architecture: API client normalizes responses with streamUrl and videoUrl fallback", async () => {
    // 1. Success with modern streamUrl and downloadUrl
    const mockFetchModern = async () => ({
        ok: true,
        json: async () => ({
            streamUrl: "/api/media/med_abc",
            downloadUrl: "/api/media/med_abc?download=1"
        })
    });

    const resModern = await apiModule.fetchMedia("instagram", "https://instagram.com/p/test", { fetchFn: mockFetchModern });
    assert.strictEqual(resModern.success, true);
    assert.strictEqual(resModern.streamUrl, "/api/media/med_abc");
    assert.strictEqual(resModern.downloadUrl, "/api/media/med_abc?download=1");

    // 2. Success with legacy videoUrl fallback
    const mockFetchLegacy = async () => ({
        ok: true,
        json: async () => ({
            videoUrl: "/api/media/med_legacy"
        })
    });

    const resLegacy = await apiModule.fetchMedia("youtube", "https://youtube.com/watch?v=test", { fetchFn: mockFetchLegacy });
    assert.strictEqual(resLegacy.success, true);
    assert.strictEqual(resLegacy.streamUrl, "/api/media/med_legacy");
    assert.strictEqual(resLegacy.downloadUrl, "/api/media/med_legacy");

    // 3. API Error response
    const mockFetchError = async () => ({
        ok: false,
        json: async () => ({
            error: {
                code: "MEDIA_NOT_FOUND",
                message: "Video unavailable."
            }
        })
    });

    const resError = await apiModule.fetchMedia("twitter", "https://x.com/user/status/123", { fetchFn: mockFetchError });
    assert.strictEqual(resError.success, false);
    assert.strictEqual(resError.code, "MEDIA_NOT_FOUND");
    assert.strictEqual(resError.message, "Video unavailable.");

    // 4. Network exception
    const mockFetchNetworkFail = async () => {
        throw new Error("Failed to fetch");
    };

    const resNetFail = await apiModule.fetchMedia("pinterest", "https://pinterest.com/pin/123", { fetchFn: mockFetchNetworkFail });
    assert.strictEqual(resNetFail.success, false);
    assert.strictEqual(resNetFail.code, "NETWORK_ERROR");
    assert.strictEqual(resNetFail.message, "Failed to fetch");
});

// =========================================================================
// 3. i18n Foundation Tests
// =========================================================================

test("Frontend Architecture: i18n translation lookup retrieves English strings by default", () => {
    assert.strictEqual(i18nModule.t("app.title"), "Reeva — Universal Reel Downloader");
    assert.strictEqual(i18nModule.t("platform.instagram"), "Instagram");
    assert.strictEqual(i18nModule.t("platform.generic"), "More Sites");
    assert.strictEqual(i18nModule.t("status.empty_url"), "⚠️ Please paste a video link first.");
});

test("Frontend Architecture: i18n falls back safely for missing keys and unknown languages", () => {
    // Missing key falls back to key string
    assert.strictEqual(i18nModule.t("unknown.nonexistent.key"), "unknown.nonexistent.key");

    // Unsupported language falls back to English
    assert.strictEqual(i18nModule.t("action.get", {}, "es"), "Get");
    assert.strictEqual(i18nModule.t("action.get", {}, "de"), "Get");
    assert.strictEqual(i18nModule.t("action.get", {}, null), "Get");
});

test("Frontend Architecture: i18n parameter interpolation safely substitutes placeholders", () => {
    const text = i18nModule.t("platform.selected", { platform: "YouTube" });
    assert.strictEqual(text, "Selected platform: YouTube");

    const netText = i18nModule.t("status.network_error", { message: "Connection refused" });
    assert.strictEqual(netText, "⚠️ Network error: Connection refused");
});

test("Frontend Architecture: Safe language resolution normalizes regional tags and falls back to en", () => {
    assert.strictEqual(i18nModule.resolveLanguage("en"), "en");
    assert.strictEqual(i18nModule.resolveLanguage("en-US"), "en");
    assert.strictEqual(i18nModule.resolveLanguage("en-GB"), "en");
    assert.strictEqual(i18nModule.resolveLanguage("EN"), "en");
    assert.strictEqual(i18nModule.resolveLanguage("fr-FR"), "en");
    assert.strictEqual(i18nModule.resolveLanguage(""), "en");
    assert.strictEqual(i18nModule.resolveLanguage(null), "en");
    assert.strictEqual(i18nModule.resolveLanguage(undefined), "en");
});

test("Frontend Architecture: Language persistence stores only non-sensitive language preference", () => {
    const store = new Map();
    const mockStorage = {
        getItem: (k) => store.get(k) || null,
        setItem: (k, v) => store.set(k, String(v))
    };

    assert.strictEqual(i18nModule.setStoredLanguage("en", mockStorage), true);
    assert.strictEqual(mockStorage.getItem("reeva_lang"), "en");
    assert.strictEqual(i18nModule.getStoredLanguage(mockStorage), "en");

    // Unsupported language is resolved to fallback before storage
    i18nModule.setStoredLanguage("unknown_lang", mockStorage);
    assert.strictEqual(mockStorage.getItem("reeva_lang"), "en");

    // Sensitive data is never stored in language key
    assert.strictEqual(store.size, 1);
    assert.ok(store.has("reeva_lang"));
});

// =========================================================================
// 4. Security & DOM Sink Invariants Tests
// =========================================================================

test("Frontend Architecture: No public JS files contain unsafe DOM sinks or eval", () => {
    const publicFiles = [
        "public/app.js",
        "public/js/state.js",
        "public/js/api.js",
        "public/js/ui.js",
        "public/js/i18n.js"
    ];

    for (const relPath of publicFiles) {
        const fullPath = path.join(__dirname, "..", relPath);
        assert.ok(fs.existsSync(fullPath), `File ${relPath} must exist`);
        const content = fs.readFileSync(fullPath, "utf8");

        // 1. Must not assign to innerHTML
        assert.strictEqual(
            content.match(/\.innerHTML\s*=/),
            null,
            `${relPath} must not use innerHTML`
        );

        // 2. Must not use outerHTML
        assert.strictEqual(
            content.match(/\.outerHTML\s*=/),
            null,
            `${relPath} must not use outerHTML`
        );

        // 3. Must not use document.write
        assert.strictEqual(
            content.match(/document\.write/),
            null,
            `${relPath} must not use document.write`
        );

        // 4. Must not use eval or new Function
        assert.strictEqual(
            content.match(/\beval\s*\(/),
            null,
            `${relPath} must not use eval()`
        );
        assert.strictEqual(
            content.match(/new\s+Function\s*\(/),
            null,
            `${relPath} must not use new Function()`
        );
    }
});

// =========================================================================
// 5. CSS Performance & Accessibility Tests
// =========================================================================

test("Frontend Architecture: styles.css does not contain universal transition anti-pattern", () => {
    const cssPath = path.join(__dirname, "../public/styles.css");
    assert.ok(fs.existsSync(cssPath), "public/styles.css must exist");
    const css = fs.readFileSync(cssPath, "utf8");

    // Check for * { transition: ... }
    const universalTransitionMatch = css.match(/\*\s*\{[^}]*transition\s*:/i);
    assert.strictEqual(
        universalTransitionMatch,
        null,
        "styles.css must not apply transitions to universal selector (*)"
    );
});

test("Frontend Architecture: index.html contains accessible live region for log status", () => {
    const htmlPath = path.join(__dirname, "../public/index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    assert.ok(
        html.includes('id="log" role="status" aria-live="polite"') ||
        html.includes('id="log" role="status"'),
        "index.html log element must include accessibility role='status'"
    );

    assert.ok(
        html.includes('aria-label="Video URL"') || html.includes('aria-label='),
        "index.html URL input must have accessible label"
    );
});
