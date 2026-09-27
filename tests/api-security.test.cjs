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

test("Arbitrary Proxy Elimination: /api/proxy strictly rejects arbitrary URLs", async () => {
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, "127.0.0.1", r));

    try {
        const arbitraryUrls = [
            "https://attacker.com/evil.mp4",
            "http://127.0.0.1:3000/secret",
            "http://169.254.169.254/latest/meta-data/",
            "https://evil-instagram.com/reel.mp4"
        ];

        for (const url of arbitraryUrls) {
            const res = await makeRequest(server, `/api/proxy?url=${encodeURIComponent(url)}`);
            assert.equal(res.status, 403, `Expected 403 Forbidden for arbitrary proxy URL ${url}`);
            assert.equal(res.json.error.code, "ARBITRARY_PROXY_FORBIDDEN");
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
    } finally {
        server.close();
    }
});
