// tests/media-delivery-preview.test.cjs
// P0 Media Delivery and Preview Test Suite
// Verifies:
// 1. Precise MIME-to-extension resolution (PNG, JPEG, WebP, MP4, WebM, M4A, MP3, OGG)
// 2. Safe HTTP Range requests (206 Partial Content, 416 Range Not Satisfiable, Accept-Ranges, Content-Range)
// 3. Frontend single-media preview controller for image, video, audio, and safe unknown fallbacks
// 4. Stale resource teardown and memory cleanup on preview reset

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const app = require("../server.cjs");
const { defaultRegistry } = require("../lib/media-registry.cjs");
const { createUiController } = require("../public/js/ui.js");
const i18n = require("../public/js/i18n.js");

// =========================================================================
// 1. MIME Extension Resolution Tests
// =========================================================================

test("MIME Resolution: Correctly maps image content types to precise file extensions", () => {
    const resolve = app.resolveMediaExtension;
    assert.strictEqual(typeof resolve, "function", "resolveMediaExtension should be exported");

    // PNG
    assert.strictEqual(resolve("image/png", "image"), "png");
    assert.strictEqual(resolve("image/png; charset=utf-8", "image"), "png");

    // JPEG
    assert.strictEqual(resolve("image/jpeg", "image"), "jpg");
    assert.strictEqual(resolve("image/jpg", "image"), "jpg");

    // WebP
    assert.strictEqual(resolve("image/webp", "image"), "webp");

    // GIF
    assert.strictEqual(resolve("image/gif", "image"), "gif");

    // SVG
    assert.strictEqual(resolve("image/svg+xml", "image"), "svg");
});

test("MIME Resolution: Correctly maps video content types to precise file extensions", () => {
    const resolve = app.resolveMediaExtension;

    // MP4
    assert.strictEqual(resolve("video/mp4", "video"), "mp4");
    assert.strictEqual(resolve("video/x-m4v", "video"), "m4v");
    assert.strictEqual(resolve("video/quicktime", "video"), "mov");

    // WebM
    assert.strictEqual(resolve("video/webm", "video"), "webm");

    // Ogg
    assert.strictEqual(resolve("video/ogg", "video"), "ogv");

    // 3GPP
    assert.strictEqual(resolve("video/3gpp", "video"), "3gp");
});

test("MIME Resolution: Correctly maps audio content types to precise file extensions", () => {
    const resolve = app.resolveMediaExtension;

    // MP3
    assert.strictEqual(resolve("audio/mpeg", "audio"), "mp3");
    assert.strictEqual(resolve("audio/mp3", "audio"), "mp3");

    // M4A / AAC
    assert.strictEqual(resolve("audio/mp4", "audio"), "m4a");
    assert.strictEqual(resolve("audio/m4a", "audio"), "m4a");
    assert.strictEqual(resolve("audio/x-m4a", "audio"), "m4a");
    assert.strictEqual(resolve("audio/aac", "audio"), "aac");

    // WebM
    assert.strictEqual(resolve("audio/webm", "audio"), "webm");

    // Ogg
    assert.strictEqual(resolve("audio/ogg", "audio"), "ogg");
});

test("MIME Resolution: Safe fallbacks for unknown or generic content types", () => {
    const resolve = app.resolveMediaExtension;

    // Application / octet-stream fallback based on mediaType
    assert.strictEqual(resolve("application/octet-stream", "image"), "jpg");
    assert.strictEqual(resolve("application/octet-stream", "audio"), "mp3");
    assert.strictEqual(resolve("application/octet-stream", "video"), "mp4");

    // Null or undefined
    assert.strictEqual(resolve(null, "image"), "jpg");
    assert.strictEqual(resolve(undefined, "audio"), "mp3");
    assert.strictEqual(resolve("", "video"), "mp4");
});

// =========================================================================
// 2. Local File Format Sniffing Tests
// =========================================================================

test("File Sniffing: Correctly detects WebP magic bytes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reeva-sniff-"));
    const webpPath = path.join(tmpDir, "test.webp");
    try {
        // RIFF (4 bytes) + file size (4 bytes) + WEBP (4 bytes)
        const webpHeader = Buffer.from([
            0x52, 0x49, 0x46, 0x46, // 'RIFF'
            0x24, 0x00, 0x00, 0x00, // file length
            0x57, 0x45, 0x42, 0x50, // 'WEBP'
            0x56, 0x50, 0x38, 0x20  // 'VP8 '
        ]);
        fs.writeFileSync(webpPath, webpHeader);

        const sniff = app.sniffLocalMediaFormat;
        const result = await sniff(webpPath, "image");
        assert.strictEqual(result.contentType, "image/webp");
        assert.strictEqual(result.fileExt, "webp");
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// =========================================================================
// 3. Frontend UI Preview Controller Tests
// =========================================================================

function createMockElement(tagName, id) {
    const attributes = {};
    const classList = new Set();
    const style = {};
    let innerText = "";
    let src = "";
    let poster = "";
    let paused = false;
    let loadCalled = false;
    let pauseCalled = false;

    return {
        tagName: tagName.toUpperCase(),
        id,
        style,
        dataset: {},
        get src() { return src; },
        set src(v) { src = String(v); },
        get poster() { return poster; },
        set poster(v) { poster = String(v); },
        get textContent() { return innerText; },
        set textContent(v) { innerText = String(v); },
        setAttribute(name, value) { attributes[name] = String(value); },
        getAttribute(name) { return attributes[name] || null; },
        removeAttribute(name) {
            delete attributes[name];
            if (name === "src") src = "";
            if (name === "poster") poster = "";
        },
        classList: {
            add: (c) => classList.add(c),
            remove: (c) => classList.delete(c),
            contains: (c) => classList.has(c)
        },
        pause() {
            paused = true;
            pauseCalled = true;
        },
        load() {
            loadCalled = true;
        },
        _isPauseCalled: () => pauseCalled,
        _isLoadCalled: () => loadCalled
    };
}

function createMockDocument() {
    const elements = {
        "app-heading": createMockElement("h1", "app-heading"),
        "app-subtitle": createMockElement("p", "app-subtitle"),
        "input-instruction": createMockElement("p", "input-instruction"),
        "lang-label": createMockElement("label", "lang-label"),
        "lang-select": createMockElement("select", "lang-select"),
        "get": createMockElement("button", "get"),
        "download": createMockElement("button", "download"),
        "url": createMockElement("input", "url"),
        "log": createMockElement("div", "log"),
        "preview": createMockElement("video", "preview"),
        "preview-image": createMockElement("img", "preview-image"),
        "preview-audio": createMockElement("audio", "preview-audio"),
        "embed-container": createMockElement("div", "embed-container"),
        "carousel-container": createMockElement("div", "carousel-container"),
        "consent": createMockElement("input", "consent"),
        "consent-text": createMockElement("span", "consent-text"),
        "why-consent": createMockElement("a", "why-consent"),
        "footer-disclaimer": createMockElement("p", "footer-disclaimer"),
        "footer-copyright": createMockElement("p", "footer-copyright"),
        "link-privacy": createMockElement("a", "link-privacy"),
        "link-terms": createMockElement("a", "link-terms")
    };

    return {
        getElementById: (id) => elements[id] || null,
        querySelectorAll: () => [],
        createElement: (tag) => createMockElement(tag, null),
        createTextNode: (txt) => ({ textContent: txt }),
        documentElement: { lang: "en", dir: "ltr" },
        _elements: elements
    };
}

test("Frontend Preview: Displays image element and hides video/audio on image type", () => {
    const mockDoc = createMockDocument();
    const ui = createUiController(mockDoc);

    const streamUrl = "/api/media/med_image12345678";
    ui.showPreview(streamUrl, "image");

    const img = mockDoc._elements["preview-image"];
    const video = mockDoc._elements["preview"];
    const audio = mockDoc._elements["preview-audio"];

    // Image must be visible with correct src
    assert.strictEqual(img.src, streamUrl);
    assert.strictEqual(img.classList.contains("hidden"), false);
    assert.strictEqual(img.style.display, "block");

    // Video and audio must remain hidden
    assert.strictEqual(video.classList.contains("hidden"), true);
    assert.strictEqual(video.style.display, "none");
    assert.strictEqual(audio.classList.contains("hidden"), true);
    assert.strictEqual(audio.style.display, "none");
});

test("Frontend Preview: Displays video element and hides image/audio on video type", () => {
    const mockDoc = createMockDocument();
    const ui = createUiController(mockDoc);

    const streamUrl = "/api/media/med_video12345678";
    ui.showPreview(streamUrl, "video", "https://example.com/poster.jpg");

    const img = mockDoc._elements["preview-image"];
    const video = mockDoc._elements["preview"];
    const audio = mockDoc._elements["preview-audio"];

    // Video must be visible with correct src and poster
    assert.strictEqual(video.src, streamUrl);
    assert.strictEqual(video.poster, "https://example.com/poster.jpg");
    assert.strictEqual(video.classList.contains("hidden"), false);
    assert.strictEqual(video.style.display, "block");

    // Image and audio must remain hidden
    assert.strictEqual(img.classList.contains("hidden"), true);
    assert.strictEqual(audio.classList.contains("hidden"), true);
});

test("Frontend Preview: Displays audio element and hides image/video on audio type", () => {
    const mockDoc = createMockDocument();
    const ui = createUiController(mockDoc);

    const streamUrl = "/api/media/med_audio12345678";
    ui.showPreview(streamUrl, "audio");

    const img = mockDoc._elements["preview-image"];
    const video = mockDoc._elements["preview"];
    const audio = mockDoc._elements["preview-audio"];

    // Audio must be visible with correct src
    assert.strictEqual(audio.src, streamUrl);
    assert.strictEqual(audio.classList.contains("hidden"), false);
    assert.strictEqual(audio.style.display, "block");

    // Video and image must remain hidden
    assert.strictEqual(video.classList.contains("hidden"), true);
    assert.strictEqual(img.classList.contains("hidden"), true);
});

test("Frontend Preview: Safe fallback on unknown or unrecognised media type", () => {
    const mockDoc = createMockDocument();
    const ui = createUiController(mockDoc);

    ui.showPreview("/api/media/med_unknown12345", "document");

    const img = mockDoc._elements["preview-image"];
    const video = mockDoc._elements["preview"];
    const audio = mockDoc._elements["preview-audio"];

    // All previews remain hidden safely
    assert.strictEqual(img.classList.contains("hidden"), true);
    assert.strictEqual(video.classList.contains("hidden"), true);
    assert.strictEqual(audio.classList.contains("hidden"), true);
});

test("Frontend Preview: hidePreview tears down media resources, pauses playback, and resets src", () => {
    const mockDoc = createMockDocument();
    const ui = createUiController(mockDoc);

    // Show video first
    ui.showPreview("/api/media/med_vid12345", "video");
    const video = mockDoc._elements["preview"];
    assert.strictEqual(video.src, "/api/media/med_vid12345");

    // Hide preview
    ui.hidePreview();

    assert.strictEqual(video._isPauseCalled(), true, "video.pause() should be invoked");
    assert.strictEqual(video._isLoadCalled(), true, "video.load() should be invoked to detach decoder");
    assert.strictEqual(video.src, "", "video.src should be removed");
    assert.strictEqual(video.classList.contains("hidden"), true);

    const img = mockDoc._elements["preview-image"];
    assert.strictEqual(img.src, "", "img.src should be removed");
    assert.strictEqual(img.classList.contains("hidden"), true);

    const audio = mockDoc._elements["preview-audio"];
    assert.strictEqual(audio._isPauseCalled(), true);
    assert.strictEqual(audio.src, "", "audio.src should be removed");
    assert.strictEqual(audio.classList.contains("hidden"), true);
});

// =========================================================================
// 4. HTTP Range Requests on Local Media Streaming
// =========================================================================

test("HTTP Range: Local file streaming handles full content and byte ranges (200, 206, 416)", async () => {
    const { REEVA_TEMP_DIR } = require("../lib/extraction/adapters/youtube.cjs");
    fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    const filePath = path.join(REEVA_TEMP_DIR, `range_test_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`);

    // Create 100-byte test file with predictable byte values 0..99
    const fileBytes = Buffer.alloc(100);
    for (let i = 0; i < 100; i++) fileBytes[i] = i;
    fs.writeFileSync(filePath, fileBytes);

    const reg = defaultRegistry.registerMedia({
        platform: "generic",
        type: "video",
        title: "Range Test",
        localFilePath: filePath,
        mode: "sandbox"
    });

    try {
        // 1. Full content request (no Range) -> HTTP 200, Accept-Ranges: bytes
        const resFull = await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${port}/api/media/${reg.id}`, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks)
                }));
                res.on("error", reject);
            });
        });

        assert.strictEqual(resFull.status, 200);
        assert.strictEqual(resFull.headers["accept-ranges"], "bytes");
        assert.strictEqual(resFull.headers["content-length"], "100");
        assert.strictEqual(resFull.body.length, 100);

        // 2. Specific range: bytes=0-49 -> HTTP 206, Content-Range: bytes 0-49/100, length: 50
        const resRange50 = await new Promise((resolve, reject) => {
            const req = http.get(`http://127.0.0.1:${port}/api/media/${reg.id}`, {
                headers: { "Range": "bytes=0-49" }
            }, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks)
                }));
                res.on("error", reject);
            });
            req.on("error", reject);
        });

        assert.strictEqual(resRange50.status, 206);
        assert.strictEqual(resRange50.headers["content-range"], "bytes 0-49/100");
        assert.strictEqual(resRange50.headers["content-length"], "50");
        assert.strictEqual(resRange50.body.length, 50);
        assert.strictEqual(resRange50.body[0], 0);
        assert.strictEqual(resRange50.body[49], 49);

        // 3. Suffix range: bytes=-20 -> HTTP 206, bytes 80-99/100, length: 20
        const resSuffix = await new Promise((resolve, reject) => {
            const req = http.get(`http://127.0.0.1:${port}/api/media/${reg.id}`, {
                headers: { "Range": "bytes=-20" }
            }, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks)
                }));
                res.on("error", reject);
            });
            req.on("error", reject);
        });

        assert.strictEqual(resSuffix.status, 206);
        assert.strictEqual(resSuffix.headers["content-range"], "bytes 80-99/100");
        assert.strictEqual(resSuffix.headers["content-length"], "20");
        assert.strictEqual(resSuffix.body.length, 20);
        assert.strictEqual(resSuffix.body[0], 80);
        assert.strictEqual(resSuffix.body[19], 99);

        // 4. Unsatisfiable range: bytes=200-300 -> HTTP 416, Content-Range: bytes */100
        const resUnsat = await new Promise((resolve, reject) => {
            const req = http.get(`http://127.0.0.1:${port}/api/media/${reg.id}`, {
                headers: { "Range": "bytes=200-300" }
            }, (res) => {
                res.on("data", () => {});
                res.on("end", () => resolve({
                    status: res.statusCode,
                    headers: res.headers
                }));
                res.on("error", reject);
            });
            req.on("error", reject);
        });

        assert.strictEqual(resUnsat.status, 416);
        assert.strictEqual(resUnsat.headers["content-range"], "bytes */100");

    } finally {
        await new Promise((done) => server.close(done));
        try { fs.unlinkSync(filePath); } catch (_) {}
    }
});

// =========================================================================
// 5. Remote Media Delivery & Content-Disposition Filename Extension
// =========================================================================

test("Remote Media: Sets Content-Disposition with .png extension when upstream returns image/png", async () => {
    const { Readable } = require("node:stream");
    let forwardedHeaders = null;

    // Inject mock secureFetch onto app to test upstream response handling cleanly
    app.secureFetch = async (url, options) => {
        forwardedHeaders = options.headers || {};
        const isRange = Boolean(forwardedHeaders["Range"]);

        const mockBody = isRange ? Buffer.alloc(10, 0x89) : Buffer.alloc(100, 0x89);
        const headersMap = new Map([
            ["content-type", "image/png"],
            ["accept-ranges", "bytes"]
        ]);

        if (isRange) {
            headersMap.set("content-range", "bytes 0-9/100");
            headersMap.set("content-length", "10");
        } else {
            headersMap.set("content-length", "100");
        }

        return {
            response: {
                ok: true,
                status: isRange ? 206 : 200,
                headers: {
                    get: (name) => headersMap.get(name.toLowerCase()) || null
                },
                body: Readable.from([mockBody])
            },
            finalUrl: url,
            abort: () => {}
        };
    };

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const serverPort = server.address().port;

    const reg = defaultRegistry.registerMedia({
        upstreamUrl: "https://i.pinimg.com/originals/test_pin.png",
        platform: "pinterest",
        type: "image",
        title: "Pinterest Pin"
    });

    try {
        // 1. Download request (?download=1)
        const resDownload = await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${serverPort}/api/media/${reg.id}?download=1`, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks)
                }));
                res.on("error", reject);
            });
        });

        assert.strictEqual(resDownload.status, 200);
        assert.strictEqual(resDownload.headers["content-type"], "image/png");
        assert.ok(
            resDownload.headers["content-disposition"].includes('filename="reeva_pinterest.png"'),
            `Expected filename to end with .png, got: ${resDownload.headers["content-disposition"]}`
        );

        // 2. Range request forwarded to upstream
        const resRange = await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${serverPort}/api/media/${reg.id}`, {
                headers: { "Range": "bytes=0-9" }
            }, (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks)
                }));
                res.on("error", reject);
            });
        });

        assert.strictEqual(resRange.status, 206);
        assert.strictEqual(forwardedHeaders["Range"], "bytes=0-9");
        assert.strictEqual(resRange.headers["content-range"], "bytes 0-9/100");
        assert.strictEqual(resRange.headers["accept-ranges"], "bytes");

    } finally {
        delete app.secureFetch;
        await new Promise((done) => server.close(done));
    }
});
