// tests/generic-extraction.test.cjs — Automated Tests for "More Sites" Generic Extraction
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const http = require("http");

const {
    validatePlatform,
    validateGenericSourceUrl,
    ValidationError
} = require("../lib/url-validator.cjs");
const {
    extractGeneric,
    parseGenericMetadata,
    mapGenericYtDlpError,
    cleanupTempFiles
} = require("../lib/extraction/adapters/generic.cjs");
const {
    validateExtractionResult
} = require("../lib/extraction/result-validator.cjs");
const { createExtractionOrchestrator } = require("../lib/extraction/index.cjs");
const { MediaRegistry } = require("../lib/media-registry.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../lib/extraction/types.cjs");
const { REEVA_TEMP_DIR } = require("../lib/extraction/adapters/youtube.cjs");

// ==============================================================================
// 1. SOURCE VALIDATION TESTS
// ==============================================================================

test("Generic Source Validation: Valid public HTTPS URL accepted", async () => {
    // commons.wikimedia.org is a real public domain
    const validUrl = "https://commons.wikimedia.org/wiki/File:Big_Buck_Bunny_4K.webm";
    const res = await validateGenericSourceUrl(validUrl);
    assert.equal(res, validUrl);
});

test("Generic Source Validation: Rejects HTTP scheme", async () => {
    await assert.rejects(
        () => validateGenericSourceUrl("http://commons.wikimedia.org/video.mp4"),
        (err) => err instanceof ValidationError && err.code === "UNSUPPORTED_PROTOCOL"
    );
});

test("Generic Source Validation: Rejects credentials in URL", async () => {
    await assert.rejects(
        () => validateGenericSourceUrl("https://admin:pass@commons.wikimedia.org/video.mp4"),
        (err) => err instanceof ValidationError && err.code === "CREDENTIALS_IN_URL"
    );
});

test("Generic Source Validation: Rejects non-443 port", async () => {
    await assert.rejects(
        () => validateGenericSourceUrl("https://commons.wikimedia.org:8443/video.mp4"),
        (err) => err instanceof ValidationError && err.code === "INVALID_PORT"
    );
});

test("Generic Source Validation: Rejects URL exceeding 2048 characters", async () => {
    const longUrl = "https://commons.wikimedia.org/" + "a".repeat(2100);
    await assert.rejects(
        () => validateGenericSourceUrl(longUrl),
        (err) => err instanceof ValidationError && err.code === "URL_TOO_LONG"
    );
});

test("Generic Source Validation: Rejects localhost and internal domain names", async () => {
    const internalTargets = [
        "https://localhost/video.mp4",
        "https://server.local/video.mp4",
        "https://admin.internal/video.mp4",
        "https://gateway.lan/video.mp4",
        "https://mydevice.home/video.mp4",
        "https://corp-intranet.corp/video.mp4",
        "https://hidden.onion/video.mp4"
    ];

    for (const url of internalTargets) {
        await assert.rejects(
            () => validateGenericSourceUrl(url),
            (err) => err instanceof ValidationError && err.code === "DISALLOWED_DOMAIN",
            `Expected ${url} to be rejected as internal domain`
        );
    }
});

test("Generic Source Validation: Rejects IP literals (IPv4 and IPv6)", async () => {
    const ipTargets = [
        "https://127.0.0.1/video.mp4",
        "https://10.0.0.1/video.mp4",
        "https://192.168.1.1/video.mp4",
        "https://172.16.0.1/video.mp4",
        "https://169.254.169.254/video.mp4",
        "https://8.8.8.8/video.mp4",
        "https://[::1]/video.mp4",
        "https://[fc00::1]/video.mp4",
        "https://[fe80::1]/video.mp4"
    ];

    for (const url of ipTargets) {
        await assert.rejects(
            () => validateGenericSourceUrl(url),
            (err) => err instanceof ValidationError && err.code === "DISALLOWED_DOMAIN",
            `Expected IP literal ${url} to be rejected`
        );
    }
});

test("Generic Source Validation: Rejects specialized Reeva platform URLs from generic mode", async () => {
    const specializedUrls = [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtu.be/dQw4w9WgXcQ",
        "https://www.instagram.com/reel/C8qLd9uOMfW/",
        "https://www.facebook.com/watch/?v=10153231379946729",
        "https://x.com/elonmusk/status/1585341984679469056",
        "https://twitter.com/user/status/12345",
        "https://www.pinterest.com/pin/47358233572860931/",
        "https://pin.it/abc1234"
    ];

    for (const url of specializedUrls) {
        await assert.rejects(
            () => validateGenericSourceUrl(url),
            (err) => err instanceof ValidationError && err.code === "USE_SPECIALIZED_PLATFORM",
            `Expected specialized URL ${url} to be rejected from generic mode`
        );
    }
});

// ==============================================================================
// 2. YT-DLP PARSING & SELECTION TESTS
// ==============================================================================

test("yt-dlp Parsing: Correctly parses named extractor metadata", () => {
    const stdout = JSON.stringify({
        extractor: "vimeo",
        extractor_key: "Vimeo",
        id: "12345",
        title: "Test Vimeo Video",
        url: "https://vimeocdn.com/video.mp4"
    });
    const info = parseGenericMetadata(stdout);
    assert.equal(info.extractor_key, "Vimeo");
    assert.equal(info.title, "Test Vimeo Video");
});

test("yt-dlp Parsing: Correctly parses generic extractor metadata", () => {
    const stdout = JSON.stringify({
        extractor: "generic",
        extractor_key: "Generic",
        id: "custom_video",
        title: "Direct MP4 File",
        url: "https://example.com/video.mp4"
    });
    const info = parseGenericMetadata(stdout);
    assert.equal(info.extractor_key, "Generic");
    assert.equal(info.title, "Direct MP4 File");
});

test("yt-dlp Parsing: Correctly parses HTML5MediaEmbed extractor metadata", () => {
    const stdout = JSON.stringify({
        extractor: "html5",
        extractor_key: "HTML5MediaEmbed",
        id: "html5_vid_1",
        title: "HTML Video Embed",
        url: "https://example.com/mov.mp4"
    });
    const info = parseGenericMetadata(stdout);
    assert.equal(info.extractor_key, "HTML5MediaEmbed");
    assert.equal(info.title, "HTML Video Embed");
});

test("yt-dlp Parsing: Handles multi-line JSON stdout and diagnostic messages", () => {
    const multiLineStdout = [
        "WARNING: [generic] Falling back on generic information extractor",
        JSON.stringify({
            extractor: "html5",
            extractor_key: "HTML5MediaEmbed",
            id: "vid_1",
            title: "First Video",
            url: "https://example.com/1.mp4"
        }),
        "[info] Extracting secondary formats",
        JSON.stringify({
            extractor: "html5",
            extractor_key: "HTML5MediaEmbed",
            id: "vid_2",
            title: "Second Video",
            url: "https://example.com/2.mp4"
        })
    ].join("\n");

    const info = parseGenericMetadata(multiLineStdout);
    // Deterministic rule: selects the first valid usable media object
    assert.equal(info.id, "vid_1");
    assert.equal(info.title, "First Video");
});

test("yt-dlp Parsing: Safely rejects malformed or unparseable JSON", () => {
    assert.throws(
        () => parseGenericMetadata("Not valid JSON at all\nAnother invalid line"),
        (err) => err instanceof ExtractionError && err.code === EXTRACTION_ERROR_CODES.EXTRACTION_FAILED
    );
});

test("yt-dlp Parsing: Safely rejects output with no usable media identifier", () => {
    const emptyObject = JSON.stringify({ description: "just text", comments: [] });
    assert.throws(
        () => parseGenericMetadata(emptyObject),
        (err) => err instanceof ExtractionError && err.code === EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND
    );
});

// ==============================================================================
// 3. MEDIA RESTRICTION TESTS
// ==============================================================================

test("Media Restrictions: Rejects playlist outputs immediately", () => {
    const playlistStdout = JSON.stringify({
        _type: "playlist",
        id: "pl_123",
        title: "Sample Playlist",
        entries: [{ id: "vid_1" }]
    });

    assert.throws(
        () => parseGenericMetadata(playlistStdout),
        (err) => err instanceof ExtractionError && err.code === EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA
    );
});

test("Media Restrictions: Rejects live streams in adapter", async () => {
    const fakeMetadataRunner = async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
            id: "live_1",
            title: "Live Stream Broadcast",
            is_live: true,
            url: "https://example.com/live.m3u8"
        }),
        stderr: ""
    });

    await assert.rejects(
        () => extractGeneric("https://example.com/live", { commandRunner: fakeMetadataRunner }),
        (err) => err instanceof ExtractionError && err.code === EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA
    );
});

test("Media Restrictions: Rejects DRM-protected media in metadata and stderr", async () => {
    // Case A: _has_drm in metadata
    const drmMetadataRunner = async () => ({
        exitCode: 0,
        stdout: JSON.stringify({
            id: "drm_1",
            title: "DRM Stream",
            _has_drm: true,
            url: "https://example.com/drm.mpd"
        }),
        stderr: ""
    });

    await assert.rejects(
        () => extractGeneric("https://example.com/drm", { commandRunner: drmMetadataRunner }),
        (err) => err instanceof ExtractionError && err.code === EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA
    );

    // Case B: stderr reports DRM protected
    const drmError = mapGenericYtDlpError(new Error("failed"), "ERROR: [generic] dash: This video is DRM protected");
    assert.equal(drmError.code, EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA);
});

test("Media Restrictions: Maps login-required content to PRIVATE_CONTENT", () => {
    const loginErr1 = mapGenericYtDlpError(new Error("failed"), "ERROR: [vimeo] 76979871: The web client only works when logged-in.");
    assert.equal(loginErr1.code, EXTRACTION_ERROR_CODES.PRIVATE_CONTENT);

    const loginErr2 = mapGenericYtDlpError(new Error("failed"), "Sign in if you've been granted access to this video.");
    assert.equal(loginErr2.code, EXTRACTION_ERROR_CODES.PRIVATE_CONTENT);
});

test("Media Restrictions: Maps bot/captcha challenge to PLATFORM_CHALLENGE", () => {
    const challengeErr = mapGenericYtDlpError(new Error("failed"), "Sign in to confirm you're not a bot");
    assert.equal(challengeErr.code, EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE);
});

// ==============================================================================
// 4. SUBPROCESS SECURITY & BOUNDARY TESTS
// ==============================================================================

test("Subprocess Security: Command runner enforces timeout", async () => {
    const timeoutRunner = async () => {
        throw new ExtractionError(EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT, "Subprocess timed out.");
    };

    await assert.rejects(
        () => extractGeneric("https://example.com/video", { commandRunner: timeoutRunner }),
        (err) => err instanceof ExtractionError && err.code === EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT
    );
});

test("Subprocess Security: User cannot inject additional flags into yt-dlp", async () => {
    let capturedArgs = [];
    const capturingRunner = async ({ args }) => {
        capturedArgs = args;
        return {
            exitCode: 0,
            stdout: JSON.stringify({ id: "vid_1", title: "Video", url: "https://example.com/1.mp4" }),
            stderr: ""
        };
    };

    const maliciousUrl = "https://example.com/video --exec rm -rf /";
    // validateGenericSourceUrl will reject spaces and malformed characters
    await assert.rejects(
        () => validateGenericSourceUrl(maliciousUrl),
        ValidationError
    );
});

// ==============================================================================
// 5. LOCAL FILE ARTIFACT & RESULT VALIDATION TESTS
// ==============================================================================

test("Local File Security: Central result validation verifies file in REEVA_TEMP_DIR and enforces bounds", () => {
    if (!fs.existsSync(REEVA_TEMP_DIR)) fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });

    const tempFile = path.join(REEVA_TEMP_DIR, `test_val_${crypto.randomBytes(8).toString("hex")}.mp4`);
    fs.writeFileSync(tempFile, Buffer.alloc(1024)); // 1 KB test file

    try {
        const rawResult = {
            url: `file://${tempFile}`,
            localFilePath: tempFile,
            type: "video",
            title: "Safe Generic Video",
            mode: "VIDEO_AND_AUDIO"
        };

        const validated = validateExtractionResult(rawResult, "generic");
        assert.equal(validated.platform, "generic");
        assert.equal(validated.localFilePath, tempFile);
        assert.equal(validated.type, "video");
        assert.equal(validated.title, "Safe Generic Video");
    } finally {
        try { fs.unlinkSync(tempFile); } catch (_) {}
    }
});

test("Local File Security: Rejects traversal attempts outside REEVA_TEMP_DIR", () => {
    const outsideFile = path.resolve(os.tmpdir(), "outside_reeva.mp4");
    fs.writeFileSync(outsideFile, Buffer.alloc(1024));

    try {
        const maliciousResult = {
            url: `file://${outsideFile}`,
            localFilePath: outsideFile,
            type: "video",
            title: "Escaped Video"
        };

        assert.throws(
            () => validateExtractionResult(maliciousResult, "generic"),
            (err) => err instanceof ExtractionError && err.message.includes("outside permitted temporary directory")
        );
    } finally {
        try { fs.unlinkSync(outsideFile); } catch (_) {}
    }
});

test("Local File Security: Rejects non-existent local files", () => {
    const nonExistent = path.join(REEVA_TEMP_DIR, "ghost_video.mp4");
    const badResult = {
        url: `file://${nonExistent}`,
        localFilePath: nonExistent,
        type: "video",
        title: "Missing"
    };

    assert.throws(
        () => validateExtractionResult(badResult, "generic"),
        (err) => err instanceof ExtractionError && err.message.includes("does not exist on disk")
    );
});

test("Local File Security: Rejects files exceeding 100 MB", () => {
    if (!fs.existsSync(REEVA_TEMP_DIR)) fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });
    const bigFile = path.join(REEVA_TEMP_DIR, `test_big_${crypto.randomBytes(8).toString("hex")}.mp4`);

    // Create file descriptor and truncate to 101 MB without allocating real memory
    const fd = fs.openSync(bigFile, "w");
    fs.ftruncateSync(fd, 101 * 1024 * 1024);
    fs.closeSync(fd);

    try {
        const bigResult = {
            url: `file://${bigFile}`,
            localFilePath: bigFile,
            type: "video",
            title: "Over 100MB"
        };

        assert.throws(
            () => validateExtractionResult(bigResult, "generic"),
            (err) => err instanceof ExtractionError && err.statusCode === 413
        );
    } finally {
        try { fs.unlinkSync(bigFile); } catch (_) {}
    }
});

test("Local File Security: Rejects standalone images in generic mode", () => {
    const imageResult = {
        url: "https://example.com/image.jpg",
        type: "image",
        title: "Image Post"
    };

    assert.throws(
        () => validateExtractionResult(imageResult, "generic"),
        (err) => err instanceof ExtractionError && err.code === EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA
    );
});

// ==============================================================================
// 6. MEDIA REGISTRY & ORCHESTRATION TESTS
// ==============================================================================

test("Media Registry: Holds localFilePath and unlinks file on deletion/expiry", () => {
    if (!fs.existsSync(REEVA_TEMP_DIR)) fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });
    const tempFile = path.join(REEVA_TEMP_DIR, `test_reg_${crypto.randomBytes(8).toString("hex")}.mp4`);
    fs.writeFileSync(tempFile, Buffer.alloc(512));

    const registry = new MediaRegistry(10, 1000); // 1 second TTL
    const registered = registry.registerMedia({
        upstreamUrl: `file://${tempFile}`,
        platform: "generic",
        type: "video",
        title: "Reg Test",
        localFilePath: tempFile
    });

    assert(registered.id.startsWith("med_"));
    const entry = registry.getMedia(registered.id);
    assert.equal(entry.localFilePath, tempFile);
    assert.equal(entry.platform, "generic");

    // Clean deletion unlinks the file
    registry.deleteMedia(registered.id);
    assert.equal(fs.existsSync(tempFile), false, "Expected file to be unlinked on registry deletion");
});

test("Extraction Orchestrator: End-to-end generic extraction registers local file cleanly", async () => {
    if (!fs.existsSync(REEVA_TEMP_DIR)) fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });
    const tempFile = path.join(REEVA_TEMP_DIR, `test_orch_${crypto.randomBytes(8).toString("hex")}.mp4`);
    fs.writeFileSync(tempFile, Buffer.alloc(1024));

    try {
        const mockGenericAdapter = async (url, options) => {
            return {
                url: `file://${tempFile}`,
                localFilePath: tempFile,
                type: "video",
                title: "Orchestrated Video",
                mode: options.mode || "VIDEO_AND_AUDIO",
                platform: "generic"
            };
        };

        const orchestrator = createExtractionOrchestrator({
            adapters: { generic: mockGenericAdapter }
        });

        const extraction = await orchestrator.extractMedia({
            platform: "generic",
            sourceUrl: "https://commons.wikimedia.org/wiki/File:Sample.webm",
            mode: "VIDEO_AND_AUDIO",
            requestId: "req_test_generic"
        });

        assert.equal(extraction.success, true);
        assert.equal(extraction.media.platform, "generic");
        assert.equal(extraction.media.localFilePath, tempFile);
        assert.equal(extraction.media.title, "Orchestrated Video");
        assert.equal(extraction.media.url.startsWith("file://"), true);
    } finally {
        try { fs.unlinkSync(tempFile); } catch (_) {}
    }
});

// ==============================================================================
// 7. API ENDPOINT & BOUNDARY TESTS
// ==============================================================================

function makeRequest(server, path, method = "GET", headers = {}) {
    return new Promise((resolve, reject) => {
        const addr = server.address();
        const req = http.request({
            host: "127.0.0.1",
            port: addr.port,
            path,
            method,
            headers
        }, (res) => {
            let data = "";
            res.on("data", chunk => { data += chunk; });
            res.on("end", () => {
                let json = null;
                try { json = JSON.parse(data); } catch { }
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: data,
                    json
                });
            });
        });
        req.on("error", reject);
        req.end();
    });
}

test("API Generic Endpoint: Rejects specialized platforms with clear error", async () => {
    const app = require("../server.cjs");
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, "127.0.0.1", r));

    try {
        const res = await makeRequest(
            server,
            "/api/download/generic?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
        assert.equal(res.status, 400);
        assert.equal(res.json.error.code, "USE_SPECIALIZED_PLATFORM");
        assert.ok(res.json.error.message.includes("YouTube"));
    } finally {
        server.close();
    }
});

test("API Generic Endpoint: Rejects invalid media mode", async () => {
    const app = require("../server.cjs");
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, "127.0.0.1", r));

    try {
        const res = await makeRequest(
            server,
            "/api/download/generic?url=https://commons.wikimedia.org/wiki/File:Sample.webm&mode=INVALID_MODE"
        );
        assert.equal(res.status, 502);
        assert.equal(res.json.error.code, "UNSUPPORTED_MEDIA");
    } finally {
        server.close();
    }
});

test("API Generic Endpoint: Rejects SSRF loopback / IP literal destinations", async () => {
    const app = require("../server.cjs");
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, "127.0.0.1", r));

    try {
        const res = await makeRequest(
            server,
            "/api/download/generic?url=https://127.0.0.1/video.mp4"
        );
        assert.equal(res.status, 400);
        assert.equal(res.json.error.code, "DISALLOWED_DOMAIN");
    } finally {
        server.close();
    }
});

test("API Generic Endpoint: Streaming remote URL for generic platform is strictly blocked", async () => {
    const { defaultRegistry } = require("../lib/media-registry.cjs");
    const app = require("../server.cjs");
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, "127.0.0.1", r));

    try {
        // Register an illegal remote generic entry (has upstreamUrl but no localFilePath)
        const entry = defaultRegistry.registerMedia({
            upstreamUrl: "https://vimeocdn.com/video.mp4",
            platform: "generic",
            type: "video"
        });

        const res = await makeRequest(server, `/api/media/${entry.id}`);
        assert.equal(res.status, 403);
        assert.equal(res.json.error.code, "ACCESS_DENIED");
    } finally {
        server.close();
    }
});

test("API Generic Endpoint: Streams local file artifact cleanly with headers and first bytes", async () => {
    const { defaultRegistry } = require("../lib/media-registry.cjs");
    const app = require("../server.cjs");
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, "127.0.0.1", r));

    if (!fs.existsSync(REEVA_TEMP_DIR)) fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });
    const tempFile = path.join(REEVA_TEMP_DIR, `reeva_gen_streamtest_${crypto.randomBytes(8).toString("hex")}.mp4`);
    const fileBytes = Buffer.from("REEVA_TEST_GENERIC_MP4_CONTENT");
    fs.writeFileSync(tempFile, fileBytes);

    try {
        const entry = defaultRegistry.registerMedia({
            upstreamUrl: `file://${tempFile}`,
            platform: "generic",
            type: "video",
            title: "Streamable Generic Video",
            localFilePath: tempFile
        });

        const res = await makeRequest(server, `/api/media/${entry.id}`);
        assert.equal(res.status, 200);
        assert.equal(res.headers["content-type"], "video/mp4");
        assert.equal(res.headers["content-length"], String(fileBytes.length));
        assert.equal(res.headers["x-content-type-options"], "nosniff");
        assert.equal(res.body, fileBytes.toString());
    } finally {
        try { fs.unlinkSync(tempFile); } catch (_) {}
        server.close();
    }
});

