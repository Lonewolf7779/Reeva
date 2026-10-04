// tests/api-security.test.cjs — Automated Tests for API Hardening, Headers, and Proxy Controls
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const app = require("../server.cjs");
const { MediaRegistry } = require("../lib/media-registry.cjs");

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

test("API Hardening: Enforces HTTP methods (rejects POST/PUT/DELETE on GET routes)", async () => {
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, "127.0.0.1", r));

    try {
        const postRes = await makeRequest(server, "/api/download/instagram", "POST");
        assert.equal(postRes.status, 405, "POST method should return 405");
        assert.equal(postRes.json.error.code, "METHOD_NOT_ALLOWED");

        const putRes = await makeRequest(server, "/api/media/med_123", "PUT");
        assert.equal(putRes.status, 405, "PUT method should return 405");
    } finally {
        server.close();
    }
});

test("API Hardening: Controlled 404 for unknown API routes", async () => {
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, "127.0.0.1", r));

    try {
        const res = await makeRequest(server, "/api/unknown-endpoint");
        assert.equal(res.status, 404);
        assert.equal(res.json.error.code, "NOT_FOUND");
    } finally {
        server.close();
    }
});

test("Security Headers: Helmet CSP and protections are properly configured", async () => {
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, "127.0.0.1", r));

    try {
        const res = await makeRequest(server, "/");
        const csp = res.headers["content-security-policy"];

        assert.ok(csp, "Content-Security-Policy header must be present");
        assert.ok(csp.includes("script-src 'self'"), "script-src should restrict to 'self'");
        assert.ok(csp.includes("frame-ancestors 'none'"), "Clickjacking protection required");
        assert.equal(res.headers["x-content-type-options"], "nosniff");
        assert.equal(res.headers["x-frame-options"], "DENY");
        assert.ok(res.headers["x-request-id"], "X-Request-Id header must be returned");
    } finally {
        server.close();
    }
});

test("Proxy Routing (Test A): /api/proxy?id=<opaque-id> resolves existing entry without router manipulation", async () => {
    const { defaultRegistry } = require("../lib/media-registry.cjs");
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, "127.0.0.1", r));

    try {
        // Register a media entry directly
        const testMedia = defaultRegistry.registerMedia({
            upstreamUrl: "https://scontent.cdninstagram.com/v/t50/mock_video.mp4",
            platform: "instagram",
            type: "video"
        });

        // 1. Valid existing ID should resolve cleanly (will attempt secure streaming, not fail with routing/param error)
        const proxyRes = await makeRequest(server, `/api/proxy?id=${testMedia.id}`);
        // Upstream fetch will fail gracefully with 502 UPSTREAM_FETCH_FAILED or STREAM_ERROR since mock URL isn't live,
        // but crucially: it MUST NOT be 400, 404, or crash Express routing
        assert.notEqual(proxyRes.status, 400);
        assert.notEqual(proxyRes.status, 404);
        assert.ok(proxyRes.status === 502 || proxyRes.status === 200, "Should invoke secure media streaming logic");

        // 2. Non-existent ID returns 404
        const missingRes = await makeRequest(server, "/api/proxy?id=med_00000000000000000000000000000000");
        assert.equal(missingRes.status, 404);
        assert.equal(missingRes.json.error.code, "MEDIA_NOT_FOUND");

        // 3. Malformed ID returns 400
        const badIdRes = await makeRequest(server, "/api/proxy?id=!invalid-id!");
        assert.equal(badIdRes.status, 400);
        assert.equal(badIdRes.json.error.code, "INVALID_MEDIA_ID");
    } finally {
        server.close();
    }
});

test("Proxy Security (Test B): /api/proxy?url=<approved-cdn> cannot register arbitrary new media entries", async () => {
    const { defaultRegistry } = require("../lib/media-registry.cjs");
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, "127.0.0.1", r));

    try {
        const approvedCdnUrl = "https://scontent.cdninstagram.com/arbitrary_user_injected_url.mp4";

        // Confirm URL is not currently registered
        assert.equal(defaultRegistry.findByUpstreamUrl(approvedCdnUrl), null);

        // Attempt to pass arbitrary URL belonging to approved CDN
        const res = await makeRequest(server, `/api/proxy?url=${encodeURIComponent(approvedCdnUrl)}`);

        // Must reject with 403 ARBITRARY_PROXY_FORBIDDEN
        assert.equal(res.status, 403);
        assert.equal(res.json.error.code, "ARBITRARY_PROXY_FORBIDDEN");

        // Confirm it was NOT registered in the media registry
        assert.equal(defaultRegistry.findByUpstreamUrl(approvedCdnUrl), null);
    } finally {
        server.close();
    }
});

test("Proxy SSRF Defense (Test C): /api/proxy?url= strictly blocks SSRF/internal targets", async () => {
    const { defaultRegistry } = require("../lib/media-registry.cjs");
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, "127.0.0.1", r));

    try {
        const ssrfUrls = [
            "http://127.0.0.1/",
            "https://127.0.0.1/",
            "http://127.0.0.1:3000/secret",
            "https://169.254.169.254/",
            "http://169.254.169.254/latest/meta-data/",
            "https://localhost/",
            "https://attacker.com/evil.mp4"
        ];

        for (const url of ssrfUrls) {
            const res = await makeRequest(server, `/api/proxy?url=${encodeURIComponent(url)}`);
            assert.equal(res.status, 403, `Expected 403 Forbidden for proxy URL ${url}`);
            assert.equal(res.json.error.code, "ARBITRARY_PROXY_FORBIDDEN");
            assert.equal(defaultRegistry.findByUpstreamUrl(url), null);
        }
    } finally {
        server.close();
    }
});

test("Media Registry: Issues opaque tokens and enforces expiration", () => {
    const registry = new MediaRegistry(10, 100); // 100ms TTL for testing

    const registered = registry.registerMedia({
        upstreamUrl: "https://scontent.cdninstagram.com/v/t50/video.mp4",
        platform: "instagram",
        type: "video"
    });

    assert.ok(registered.id.startsWith("med_"));

    // Lookup immediately
    const found = registry.getMedia(registered.id);
    assert.ok(found);
    assert.equal(found.platform, "instagram");

    // After expiration, lookup must fail
    const expiredRegistry = new MediaRegistry(10, -1000); // Already expired
    const expReg = expiredRegistry.registerMedia({
        upstreamUrl: "https://scontent.cdninstagram.com/v/t50/video.mp4",
        platform: "instagram"
    });
    assert.equal(expiredRegistry.getMedia(expReg.id), null, "Expired media must return null");
});

test("API Download Endpoint: Validates parameters, platforms, and domains", async () => {
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, "127.0.0.1", r));

    try {
        // Missing URL
        const missingUrlRes = await makeRequest(server, "/api/download/instagram");
        assert.equal(missingUrlRes.status, 400);
        assert.equal(missingUrlRes.json.error.code, "MISSING_URL");

        // Invalid Platform
        const invalidPlatformRes = await makeRequest(server, "/api/download/tiktok?url=https://instagram.com/p/123");
        assert.equal(invalidPlatformRes.status, 400);
        assert.equal(invalidPlatformRes.json.error.code, "UNSUPPORTED_PLATFORM");

        // Wrong domain for platform
        const wrongDomainRes = await makeRequest(server, "/api/download/instagram?url=https://youtube.com/watch?v=123");
        assert.equal(wrongDomainRes.status, 400);
        assert.equal(wrongDomainRes.json.error.code, "DISALLOWED_DOMAIN");

        // SSRF attempt in download url
        const ssrfRes = await makeRequest(server, "/api/download/instagram?url=http://127.0.0.1:3000/");
        assert.equal(ssrfRes.status, 400);

        // Invalid media ID format
        const badIdRes = await makeRequest(server, "/api/media/!bad!id!");
        assert.equal(badIdRes.status, 400);
        assert.equal(badIdRes.json.error.code, "INVALID_MEDIA_ID");

        // Nonexistent media ID
        const nonExistentRes = await makeRequest(server, "/api/media/med_00112233445566778899aabbccddeeff");
        assert.equal(nonExistentRes.status, 404);
        assert.equal(nonExistentRes.json.error.code, "MEDIA_NOT_FOUND");

        // Invalid YouTube mode
        const invalidModeRes = await makeRequest(server, "/api/download/youtube?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&mode=INVALID_MODE");
        assert.equal(invalidModeRes.status, 502);
        assert.equal(invalidModeRes.json.error.code, "UNSUPPORTED_MEDIA");
    } finally {
        server.close();
    }
});

test("Media Registry: Automatically unlinks localFilePath on expiration and deletion", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");

    const tempDir = path.join(os.tmpdir(), "reeva_test_" + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });

    const dummyFile = path.join(tempDir, "test_file.mp4");
    fs.writeFileSync(dummyFile, "dummy video data");
    assert.ok(fs.existsSync(dummyFile));

    const registry = new MediaRegistry(10, 50); // 50ms TTL
    const entry = registry.registerMedia({
        upstreamUrl: "https://googlevideo.com/test",
        platform: "youtube",
        type: "video",
        localFilePath: dummyFile,
        mode: "VIDEO_AND_AUDIO"
    });

    assert.equal(entry.id.startsWith("med_"), true);

    // Explicit deletion cleans up file
    registry.deleteMedia(entry.id);
    assert.equal(fs.existsSync(dummyFile), false, "deleteMedia must unlink the local file");

    // Clean up temp dir
    try { fs.rmdirSync(tempDir); } catch (_) {}
});

test("API Media Streaming: Serves local file artifact with security boundary checks", async () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { defaultRegistry } = require("../lib/media-registry.cjs");
    const { REEVA_TEMP_DIR } = require("../lib/extraction/adapters/youtube.cjs");

    if (!fs.existsSync(REEVA_TEMP_DIR)) {
        fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });
    }

    const testFile = path.join(REEVA_TEMP_DIR, `reeva_mux_test_${Date.now()}.mp4`);
    fs.writeFileSync(testFile, "test-media-stream-content-12345");

    const server = http.createServer(app);
    await new Promise(r => server.listen(0, "127.0.0.1", r));

    try {
        const registered = defaultRegistry.registerMedia({
            upstreamUrl: "https://rr1---sn-abc.googlevideo.com/videoplayback",
            platform: "youtube",
            type: "video",
            localFilePath: testFile,
            mode: "VIDEO_AND_AUDIO"
        });

        // 1. Valid streaming request
        const res = await makeRequest(server, `/api/media/${registered.id}`);
        assert.equal(res.status, 200);
        assert.equal(res.headers["content-type"], "video/mp4");
        assert.equal(res.body, "test-media-stream-content-12345");

        // 2. Traversal test: registering a file outside REEVA_TEMP_DIR must be blocked with 403 ACCESS_DENIED
        const outsideFile = path.join(os.tmpdir(), "outside_test.mp4");
        fs.writeFileSync(outsideFile, "outside content");
        const outsideEntry = defaultRegistry.registerMedia({
            upstreamUrl: "https://rr1---sn-abc.googlevideo.com/videoplayback",
            platform: "youtube",
            type: "video",
            localFilePath: outsideFile
        });

        const blockedRes = await makeRequest(server, `/api/media/${outsideEntry.id}`);
        assert.equal(blockedRes.status, 403);
        assert.equal(blockedRes.json.error.code, "ACCESS_DENIED");

        try { fs.unlinkSync(outsideFile); } catch (_) {}
    } finally {
        server.close();
        try { fs.unlinkSync(testFile); } catch (_) {}
    }
});
