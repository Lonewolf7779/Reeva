// tests/frontend-architecture.test.cjs — Deterministic Tests for Frontend Architecture, i18n, and Hardening
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const stateModule = require("../public/js/state.js");
const apiModule = require("../public/js/api.js");
const i18nModule = require("../public/js/i18n.js");
const uiModule = require("../public/js/ui.js");

// =========================================================================
// 1. Platform Identifiers & State Management Tests
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

test("Frontend Architecture: Request race condition tracking ignores stale completed responses", () => {
    const state = stateModule.createState();

    // Request A starts
    const tokenA = state.startRequest();
    assert.strictEqual(tokenA, 1);
    assert.strictEqual(state.isCurrentRequest(tokenA), true);

    // Request B starts before A finishes
    const tokenB = state.startRequest();
    assert.strictEqual(tokenB, 2);
    assert.strictEqual(state.isCurrentRequest(tokenB), true);
    assert.strictEqual(state.isCurrentRequest(tokenA), false, "Request A is now stale and must not match active token");

    // Request B finishes first
    state.setMediaUrls({ streamUrl: "/api/media/med_B", downloadUrl: "/api/media/med_B?download=1" });

    // Request A finishes later: its token is stale, so caller logic discards it
    if (state.isCurrentRequest(tokenA)) {
        state.setMediaUrls({ streamUrl: "/api/media/med_A", downloadUrl: "/api/media/med_A" });
    }

    // Media URLs must remain those of Request B
    assert.strictEqual(state.getStreamUrl(), "/api/media/med_B");
});

// =========================================================================
// 2. Media URL Safety & API Client Tests
// =========================================================================

test("Frontend Architecture: Media URL validator strictly enforces canonical /api/media contract", () => {
    // Valid canonical Reeva media paths
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med_1234567890abcdef"), true);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med_1234567890abcdef?download=1"), true);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/12345678"), true, "Minimum 8-char media ID is allowed");
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/" + "a".repeat(64)), true, "Maximum 64-char media ID is allowed");
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/" + "a".repeat(64) + "?download=1"), true);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/media-id_12345-ok"), true, "Hyphens and underscores in ID are allowed");

    // Reject arbitrary/invalid query strings
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med_1234567890abcdef?download=1&format=mp4"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med_1234567890abcdef?download=2"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med_1234567890abcdef?download=0"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med_1234567890abcdef?download=true"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med_1234567890abcdef?arbitrary=value"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med_1234567890abcdef?url=https://evil.com"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med_1234567890abcdef?download=1&evil=value"), false);

    // Reject path traversal and extra subpaths
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/../../anything"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/foo/bar"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media"), false);

    // Reject media IDs shorter than 8 chars or longer than 64 chars
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/1234567"), false, "Under 8 chars must be rejected");
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/" + "a".repeat(65)), false, "Over 64 chars must be rejected");

    // Reject invalid characters in media ID
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med!@#$1234"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med 12345678"), false);

    // Reject hash fragments
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med_1234567890abcdef#fragment"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med_1234567890abcdef?download=1#fragment"), false);

    // Block dangerous schemes
    assert.strictEqual(apiModule.isValidMediaUrl("javascript:alert(1)"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("data:text/html,<script>alert(1)</script>"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("file:///etc/passwd"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("vbscript:msgbox(1)"), false);

    // Block arbitrary external domains and protocol-relative URLs
    assert.strictEqual(apiModule.isValidMediaUrl("https://evil.com/malicious.mp4"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("http://localhost:3000/api/media/med_12345678"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("//evil.com/video.mp4"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("//localhost/api/media/med_12345678"), false);

    // Block whitespace / newlines / control characters
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med_12345678\nnewline"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med_12345678\r\n"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med_12345678\x00null"), false);
    assert.strictEqual(apiModule.isValidMediaUrl(" /api/media/med_12345678"), false);
    assert.strictEqual(apiModule.isValidMediaUrl("/api/media/med_12345678 "), false);

    // Block empty / non-string inputs
    assert.strictEqual(apiModule.isValidMediaUrl(""), false);
    assert.strictEqual(apiModule.isValidMediaUrl(null), false);
    assert.strictEqual(apiModule.isValidMediaUrl(undefined), false);
    assert.strictEqual(apiModule.isValidMediaUrl(12345678), false);
    assert.strictEqual(apiModule.isValidMediaUrl({}), false);
});

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

test("Frontend Architecture: API client normalizes responses and validates media URLs", async () => {
    // 1. Success with valid media URLs
    const mockFetchModern = async () => ({
        ok: true,
        json: async () => ({
            streamUrl: "/api/media/med_abcdef1234567890",
            downloadUrl: "/api/media/med_abcdef1234567890?download=1"
        })
    });

    const resModern = await apiModule.fetchMedia("instagram", "https://instagram.com/p/test", { fetchFn: mockFetchModern });
    assert.strictEqual(resModern.success, true);
    assert.strictEqual(resModern.streamUrl, "/api/media/med_abcdef1234567890");
    assert.strictEqual(resModern.downloadUrl, "/api/media/med_abcdef1234567890?download=1");

    // 2. Success with legacy videoUrl fallback
    const mockFetchLegacy = async () => ({
        ok: true,
        json: async () => ({
            videoUrl: "/api/media/med_abcdef1234567890"
        })
    });

    const resLegacy = await apiModule.fetchMedia("youtube", "https://youtube.com/watch?v=test", { fetchFn: mockFetchLegacy });
    assert.strictEqual(resLegacy.success, true);
    assert.strictEqual(resLegacy.streamUrl, "/api/media/med_abcdef1234567890");

    // 3. Rejects unsafe media URL returned from server
    const mockFetchUnsafe = async () => ({
        ok: true,
        json: async () => ({
            streamUrl: "javascript:alert(1)"
        })
    });

    const resUnsafe = await apiModule.fetchMedia("instagram", "https://instagram.com/p/test", { fetchFn: mockFetchUnsafe });
    assert.strictEqual(resUnsafe.success, false);
    assert.strictEqual(resUnsafe.code, "UNSAFE_MEDIA_URL");

    // 3b. Rejects unsafe downloadUrl even when streamUrl is valid
    const mockFetchUnsafeDownload = async () => ({
        ok: true,
        json: async () => ({
            streamUrl: "/api/media/med_abcdef1234567890",
            downloadUrl: "https://evil.com/payload.mp4"
        })
    });

    const resUnsafeDl = await apiModule.fetchMedia("instagram", "https://instagram.com/p/test", { fetchFn: mockFetchUnsafeDownload });
    assert.strictEqual(resUnsafeDl.success, false);
    assert.strictEqual(resUnsafeDl.code, "UNSAFE_MEDIA_URL");

    // 3c. Rejects downloadUrl with invalid query parameter or traversal
    const mockFetchInvalidDlQuery = async () => ({
        ok: true,
        json: async () => ({
            streamUrl: "/api/media/med_abcdef1234567890",
            downloadUrl: "/api/media/med_abcdef1234567890?download=2"
        })
    });

    const resInvalidDlQuery = await apiModule.fetchMedia("instagram", "https://instagram.com/p/test", { fetchFn: mockFetchInvalidDlQuery });
    assert.strictEqual(resInvalidDlQuery.success, false);
    assert.strictEqual(resInvalidDlQuery.code, "UNSAFE_MEDIA_URL");

    // 4. API Error response
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

    // 5. Aborted request handling
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    const mockFetchAborted = async () => { throw abortErr; };

    const resAborted = await apiModule.fetchMedia("pinterest", "https://pinterest.com/pin/123", { fetchFn: mockFetchAborted });
    assert.strictEqual(resAborted.success, false);
    assert.strictEqual(resAborted.code, "ABORTED");
});

// =========================================================================
// 3. Multilingual UI & i18n Localization Tests
// =========================================================================

test("Frontend Architecture: i18n supports English and Hindi with full key parity", () => {
    assert.deepStrictEqual([...i18nModule.SUPPORTED_LANGUAGES], ["en", "hi"]);

    const enKeys = Object.keys(i18nModule.TRANSLATIONS.en);
    const hiKeys = Object.keys(i18nModule.TRANSLATIONS.hi);

    assert.ok(enKeys.length >= 20, "English dictionary must contain all required UI keys");
    assert.deepStrictEqual(
        enKeys.sort(),
        hiKeys.sort(),
        "Hindi translation dictionary must have exact key parity with English"
    );
});

test("Frontend Architecture: i18n retrieves Hindi translations and handles direction", () => {
    assert.strictEqual(i18nModule.t("app.title", {}, "hi"), "रीवा (Reeva) — यूनिवर्सल रील डाउनलोडर");
    assert.strictEqual(i18nModule.t("platform.instagram", {}, "hi"), "इंस्टाग्राम");
    assert.strictEqual(i18nModule.t("platform.youtube", {}, "hi"), "यूट्यूब");
    assert.strictEqual(i18nModule.t("action.get", {}, "hi"), "पाएं");
    assert.strictEqual(i18nModule.t("action.download", {}, "hi"), "डाउनलोड करें");

    assert.strictEqual(i18nModule.getLanguageDirection("en"), "ltr");
    assert.strictEqual(i18nModule.getLanguageDirection("hi"), "ltr");
});

test("Frontend Architecture: i18n fallback hierarchy protects against missing keys and unknown languages", () => {
    // Missing key in requested language falls back to English, then to key
    assert.strictEqual(i18nModule.t("unknown.key.foo", {}, "hi"), "unknown.key.foo");
    assert.strictEqual(i18nModule.t("unknown.key.foo", {}, "en"), "unknown.key.foo");

    // Unsupported language code falls back to English
    assert.strictEqual(i18nModule.t("action.get", {}, "de"), "Get");
    assert.strictEqual(i18nModule.t("action.get", {}, "fr"), "Get");
    assert.strictEqual(i18nModule.t("action.get", {}, null), "Get");
});

test("Frontend Architecture: i18n parameter interpolation handles special characters and edge cases safely", () => {
    // Normal substitution
    assert.strictEqual(
        i18nModule.t("platform.selected", { platform: "YouTube" }, "en"),
        "Selected platform: YouTube"
    );

    // Special regex characters in parameter values must not break interpolation
    const specialChars = "Special $& *+?()^.|[]\\";
    assert.strictEqual(
        i18nModule.t("status.network_error", { message: specialChars }, "en"),
        `⚠️ Network error: ${specialChars}`
    );

    // Null and undefined parameter values format safely without throwing
    assert.strictEqual(
        i18nModule.t("status.network_error", { message: null }, "en"),
        "⚠️ Network error: "
    );
    assert.strictEqual(
        i18nModule.t("status.network_error", { message: undefined }, "en"),
        "⚠️ Network error: "
    );

    // Objects format as safe placeholder without crashing
    assert.strictEqual(
        i18nModule.t("status.network_error", { message: { complex: "obj" } }, "en"),
        "⚠️ Network error: [object]"
    );
});

// =========================================================================
// 4. Language Resolution Order & Storage Hardening
// =========================================================================

test("Frontend Architecture: Language candidate resolution handles tags, sub-tags, and invalid inputs", () => {
    assert.strictEqual(i18nModule.resolveLanguage("en"), "en");
    assert.strictEqual(i18nModule.resolveLanguage("EN"), "en");
    assert.strictEqual(i18nModule.resolveLanguage("en-US"), "en");
    assert.strictEqual(i18nModule.resolveLanguage("en-GB"), "en");

    assert.strictEqual(i18nModule.resolveLanguage("hi"), "hi");
    assert.strictEqual(i18nModule.resolveLanguage("HI"), "hi");
    assert.strictEqual(i18nModule.resolveLanguage("hi-IN"), "hi");

    // Unsupported languages fall back to default
    assert.strictEqual(i18nModule.resolveLanguage("fr-FR"), "en");
    assert.strictEqual(i18nModule.resolveLanguage("de"), "en");
    assert.strictEqual(i18nModule.resolveLanguage(""), "en");
    assert.strictEqual(i18nModule.resolveLanguage(null), "en");
    assert.strictEqual(i18nModule.resolveLanguage(undefined), "en");

    // Hostile values fall back safely
    assert.strictEqual(i18nModule.resolveLanguage("<script>alert(1)</script>"), "en");
    assert.strictEqual(i18nModule.resolveLanguage("../../etc/passwd"), "en");
    assert.strictEqual(i18nModule.resolveLanguage("a".repeat(100)), "en");
});

test("Frontend Architecture: Language resolution strictly follows 1. Stored -> 2. Browser -> 3. Fallback", () => {
    // Case 1: Stored preference takes highest precedence
    const mockStore = new Map([["reeva_lang", "hi"]]);
    const mockStorage = { getItem: (k) => mockStore.get(k) || null, setItem: (k, v) => mockStore.set(k, v) };
    const mockNav = { languages: ["en-US"], language: "en-US" };

    assert.strictEqual(
        i18nModule.resolveInitialLanguage({ storage: mockStorage, nav: mockNav }),
        "hi",
        "Stored preference 'hi' must take precedence over browser 'en-US'"
    );

    // Case 2: No stored preference -> detects browser language
    mockStore.clear();
    const mockNavHindi = { languages: ["hi-IN", "en"], language: "hi-IN" };
    assert.strictEqual(
        i18nModule.resolveInitialLanguage({ storage: mockStorage, nav: mockNavHindi }),
        "hi",
        "Browser language 'hi-IN' must be resolved when storage is empty"
    );

    // Case 3: Unsupported browser language -> falls back to English
    const mockNavFrench = { languages: ["fr-FR", "es"], language: "fr-FR" };
    assert.strictEqual(
        i18nModule.resolveInitialLanguage({ storage: mockStorage, nav: mockNavFrench }),
        "en",
        "Unsupported browser language 'fr-FR' must fall back to 'en'"
    );

    // Case 4: No storage and no navigator -> falls back to English
    assert.strictEqual(
        i18nModule.resolveInitialLanguage({ storage: null, nav: null }),
        "en"
    );
});

test("Frontend Architecture: Language storage securely validates keys and handles throwing Storage", () => {
    const store = new Map();
    const mockStorage = {
        getItem: (k) => store.get(k) || null,
        setItem: (k, v) => store.set(k, String(v))
    };

    // Storing valid languages succeeds
    assert.strictEqual(i18nModule.setStoredLanguage("en", mockStorage), true);
    assert.strictEqual(mockStorage.getItem("reeva_lang"), "en");

    assert.strictEqual(i18nModule.setStoredLanguage("hi", mockStorage), true);
    assert.strictEqual(mockStorage.getItem("reeva_lang"), "hi");

    // Storing hostile / unsupported values is rejected and does not corrupt storage
    assert.strictEqual(i18nModule.setStoredLanguage("<script>alert(1)</script>", mockStorage), false);
    assert.strictEqual(mockStorage.getItem("reeva_lang"), "hi");

    // Storage throwing exceptions (SecurityError / private browsing) does not crash
    const throwingStorage = {
        getItem: () => { throw new Error("SecurityError: localStorage is disabled"); },
        setItem: () => { throw new Error("QuotaExceededError"); }
    };

    assert.strictEqual(i18nModule.getStoredLanguage(throwingStorage), null);
    assert.strictEqual(i18nModule.setStoredLanguage("en", throwingStorage), false);
});

// =========================================================================
// 5. DOM Invariants, Accessibility & Security Sinks Tests
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

        assert.strictEqual(content.match(/\.innerHTML\s*=/), null, `${relPath} must not use innerHTML`);
        assert.strictEqual(content.match(/\.outerHTML\s*=/), null, `${relPath} must not use outerHTML`);
        assert.strictEqual(content.match(/document\.write/), null, `${relPath} must not use document.write`);
        assert.strictEqual(content.match(/\beval\s*\(/), null, `${relPath} must not use eval()`);
        assert.strictEqual(content.match(/new\s+Function\s*\(/), null, `${relPath} must not use new Function()`);
    }
});

test("Frontend Architecture: styles.css contains no universal transitions and styles all components", () => {
    const cssPath = path.join(__dirname, "../public/styles.css");
    assert.ok(fs.existsSync(cssPath), "public/styles.css must exist");
    const css = fs.readFileSync(cssPath, "utf8");

    // No * { transition: ... }
    assert.strictEqual(
        css.match(/\*\s*\{[^}]*transition\s*:/i),
        null,
        "styles.css must not apply transitions to universal selector (*)"
    );

    // Classes must be defined
    assert.ok(css.includes(".lang-bar"), "styles.css must style .lang-bar");
    assert.ok(css.includes(".lang-select"), "styles.css must style .lang-select");
    assert.ok(css.includes(".instruction"), "styles.css must style .instruction");
    assert.ok(css.includes(".hidden"), "styles.css must style .hidden utility");
});

test("Frontend Architecture: index.html contains zero inline styles and includes accessible elements", () => {
    const htmlPath = path.join(__dirname, "../public/index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    // Zero inline style="" attributes
    const inlineStyleMatch = html.match(/\sstyle\s*=\s*["'][^"']*["']/i);
    assert.strictEqual(
        inlineStyleMatch,
        null,
        "index.html must not contain inline style attributes; all styling belongs in styles.css"
    );

    // Accessibility attributes
    assert.ok(html.includes('role="status"'), "index.html log element must include role='status'");
    assert.ok(html.includes('aria-live="polite"'), "index.html log element must include aria-live='polite'");
    assert.ok(html.includes('id="lang-select"'), "index.html must include accessible language selector");
    assert.ok(html.includes('id="lang-label"'), "index.html must include label for language selector");
    assert.ok(html.includes('for="lang-select"'), "language label must associate with selector via for attribute");
});

// =========================================================================
// 6. Dynamic Language State & In-Flight Race Condition Tests
// =========================================================================

test("Frontend Architecture: Dynamic language change during in-flight request renders status in active language", async () => {
    const state = stateModule.createState({ language: "en" });
    assert.strictEqual(state.getLanguage(), "en");

    const logs = [];
    const mockUi = {
        setLog: (msg, level) => logs.push({ msg, level })
    };

    let resolveFetch;
    const fetchPromise = new Promise((resolve) => {
        resolveFetch = resolve;
    });

    const mockFetchFn = async () => {
        return fetchPromise;
    };

    // Request starts while language is "en"
    const req1 = state.startRequest();
    assert.strictEqual(state.isCurrentRequest(req1), true);

    // User switches language to Hindi while request is pending
    state.setLanguage("hi");
    assert.strictEqual(state.getLanguage(), "hi");

    // Server returns successful response
    resolveFetch({
        ok: true,
        json: async () => ({
            streamUrl: "/api/media/med_abcdef1234567890",
            downloadUrl: "/api/media/med_abcdef1234567890?download=1"
        })
    });

    const result = await apiModule.fetchMedia("instagram", "https://instagram.com/p/test", { fetchFn: mockFetchFn });
    assert.strictEqual(result.success, true);

    // Extraction completion resolves current language at render time
    if (state.isCurrentRequest(req1)) {
        const renderLang = state.getLanguage();
        mockUi.setLog(i18nModule.t("status.success", {}, renderLang), "success");
    }

    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].level, "success");
    assert.strictEqual(logs[0].msg, i18nModule.t("status.success", {}, "hi"));
    assert.notStrictEqual(logs[0].msg, i18nModule.t("status.success", {}, "en"));
});

test("Frontend Architecture: Dynamic language change during failed in-flight request renders error in active language", async () => {
    const state = stateModule.createState({ language: "en" });

    const logs = [];
    const mockUi = {
        setLog: (msg, level) => logs.push({ msg, level })
    };

    const reqId = state.startRequest();

    // User switches to Hindi during request
    state.setLanguage("hi");

    const mockFetchError = async () => ({
        ok: false,
        json: async () => ({
            error: { code: "MEDIA_NOT_FOUND", message: "Video not found" }
        })
    });

    const result = await apiModule.fetchMedia("instagram", "https://instagram.com/p/test", { fetchFn: mockFetchError });
    assert.strictEqual(result.success, false);

    if (state.isCurrentRequest(reqId)) {
        const renderLang = state.getLanguage();
        const errorMessage = result.code === "NETWORK_ERROR"
            ? i18nModule.t("status.network_error", { message: result.message }, renderLang)
            : `❌ ${result.message || i18nModule.t("status.generic_error", {}, renderLang)}`;
        mockUi.setLog(errorMessage, "error");
    }

    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].level, "error");
    assert.strictEqual(logs[0].msg, "❌ Video not found");
});

test("Frontend Architecture: Overlapping requests discard stale responses and preserve active state", async () => {
    const state = stateModule.createState({ language: "en" });

    const logs = [];
    const mockUi = {
        setLog: (msg, level) => logs.push({ msg, level })
    };

    // Request 1 starts
    const req1 = state.startRequest();

    // Request 2 starts immediately after
    const req2 = state.startRequest();
    assert.strictEqual(state.isCurrentRequest(req1), false, "Req 1 must be stale");
    assert.strictEqual(state.isCurrentRequest(req2), true, "Req 2 must be current");

    // Req 1 finishes now (stale)
    if (state.isCurrentRequest(req1)) {
        mockUi.setLog("Req 1 finished", "success");
    }

    assert.strictEqual(logs.length, 0, "Stale Request 1 response must be ignored");

    // Req 2 finishes
    if (state.isCurrentRequest(req2)) {
        mockUi.setLog("Req 2 finished", "success");
    }

    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].msg, "Req 2 finished");
});

