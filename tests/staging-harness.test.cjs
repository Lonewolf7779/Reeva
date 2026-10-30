// tests/staging-harness.test.cjs — Isolated Deterministic Unit Tests for Staging Diagnostics Harness
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const {
    checkTcpConnection,
    checkTlsHandshake,
    checkHttpProbe,
    validateMediaResponseHeaders,
    sniffContainerFormat,
    verifyFfmpegDecode,
    verifyTarget
} = require("../scripts/verify-staging-platforms.cjs");

// =========================================================================
// 1. TCP Connection Diagnostic Tests
// =========================================================================

test("Staging Harness: checkTcpConnection succeeds when TCP port connects", async () => {
    const server = net.createServer((socket) => {
        socket.end();
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
        const result = await checkTcpConnection("127.0.0.1", port, 2000);
        assert.equal(result.tcpOk, true);
        assert.equal(result.error, null);
        assert.ok(result.durationMs >= 0);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("Staging Harness: checkTcpConnection handles connection refusal cleanly", async () => {
    // Port 1 is reserved and typically immediately refused on loopback
    const result = await checkTcpConnection("127.0.0.1", 1, 1000);
    assert.equal(result.tcpOk, false);
    assert.ok(result.error.includes("ECONNREFUSED") || result.error.includes("TCP_ERROR"));
});

test("Staging Harness: checkTcpConnection handles connection timeout cleanly", async () => {
    // Mock net.connect emitting timeout
    const mockNet = {
        connect: () => {
            const socket = new EventEmitter();
            socket.setTimeout = (ms, cb) => {
                setTimeout(cb, 10);
            };
            socket.destroy = () => {};
            return socket;
        }
    };

    const result = await checkTcpConnection("10.255.255.1", 443, 20, { netModule: mockNet });
    assert.equal(result.tcpOk, false);
    assert.ok(result.error.includes("timed out"));
});

// =========================================================================
// 2. TLS Handshake Diagnostic Tests
// =========================================================================

test("Staging Harness: checkTlsHandshake rejects untrusted leaf certificate with strict rejectUnauthorized", async () => {
    // Mock tls.connect rejecting leaf certificate
    const mockTls = {
        connect: (port, host, opts, cb) => {
            assert.equal(opts.rejectUnauthorized, true, "Must enforce rejectUnauthorized: true");
            const socket = new EventEmitter();
            socket.setTimeout = () => {};
            socket.destroy = () => {};
            socket.getPeerCertificate = () => ({ issuer: { O: "Sophos", CN: "Sophos SSL CA" } });
            process.nextTick(() => {
                const err = new Error("unable to verify the first certificate");
                err.code = "UNABLE_TO_VERIFY_LEAF_SIGNATURE";
                socket.emit("error", err);
            });
            return socket;
        }
    };

    const result = await checkTlsHandshake("www.instagram.com", 443, 1000, { tlsModule: mockTls });
    assert.equal(result.tlsOk, false);
    assert.equal(result.authorized, false);
    assert.ok(result.error.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE"));
    assert.ok(result.issuer.includes("Sophos"));
});

// =========================================================================
// 3. HTTP Diagnostic Probe Tests (HEAD & Bounded GET)
// =========================================================================

test("Staging Harness: checkHttpProbe succeeds on HTTP 200 via HEAD", async () => {
    const mockFetch = async (url, opts) => {
        assert.equal(opts.method, "HEAD");
        return {
            finalUrl: url,
            response: {
                ok: true,
                status: 200,
                headers: new Map([
                    ["content-type", "text/html; charset=utf-8"],
                    ["content-length", "1024"]
                ])
            },
            abort: () => {}
        };
    };

    const res = await checkHttpProbe("https://www.tiktok.com/@test/video/123", "tiktok", { fetchFn: mockFetch });
    assert.equal(res.httpOk, true);
    assert.equal(res.status, 200);
    assert.equal(res.methodUsed, "HEAD");
    assert.equal(res.contentType, "text/html; charset=utf-8");
    assert.equal(res.contentLength, "1024");
});

test("Staging Harness: checkHttpProbe captures HTTP 302 redirect", async () => {
    const mockFetch = async (url, opts) => {
        return {
            finalUrl: "https://www.tiktok.com/in/about",
            response: {
                ok: false,
                status: 302,
                headers: new Map([
                    ["location", "https://www.tiktok.com/in/about"],
                    ["content-type", "text/html"]
                ])
            },
            abort: () => {}
        };
    };

    const res = await checkHttpProbe("https://www.tiktok.com/@test/video/123", "tiktok", { fetchFn: mockFetch });
    assert.equal(res.httpOk, true);
    assert.equal(res.status, 302);
    assert.equal(res.finalUrl, "https://www.tiktok.com/in/about");
});

test("Staging Harness: checkHttpProbe falls back to bounded GET when HEAD returns 405 Method Not Allowed", async () => {
    let callCount = 0;
    const mockFetch = async (url, opts) => {
        callCount++;
        if (opts.method === "HEAD") {
            return {
                finalUrl: url,
                response: {
                    ok: false,
                    status: 405,
                    headers: new Map()
                },
                abort: () => {}
            };
        }
        if (opts.method === "GET") {
            assert.equal(opts.headers.Range, "bytes=0-2047");
            assert.ok(opts.maxSizeBytes <= 64 * 1024);
            return {
                finalUrl: url,
                response: {
                    ok: true,
                    status: 206,
                    headers: new Map([
                        ["content-type", "video/mp4"],
                        ["content-length", "2048"]
                    ])
                },
                abort: () => {}
            };
        }
    };

    const res = await checkHttpProbe("https://www.facebook.com/watch/?v=123", "facebook", { fetchFn: mockFetch });
    assert.equal(callCount, 2);
    assert.equal(res.httpOk, true);
    assert.equal(res.status, 206);
    assert.ok(res.methodUsed.includes("GET"));
});

test("Staging Harness: checkHttpProbe captures HTTP 403 Forbidden correctly", async () => {
    const mockFetch = async (url, opts) => {
        return {
            finalUrl: url,
            response: {
                ok: false,
                status: 403,
                headers: new Map([["content-type", "text/html"]])
            },
            abort: () => {}
        };
    };

    const res = await checkHttpProbe("https://www.instagram.com/reel/123", "instagram", { fetchFn: mockFetch });
    assert.equal(res.httpOk, false);
    assert.equal(res.status, 403);
    assert.ok(res.error.includes("status 403"));
});

test("Staging Harness: checkHttpProbe captures timeout error without throwing", async () => {
    const mockFetch = async () => {
        throw new Error("Request timed out after 6000ms");
    };

    const res = await checkHttpProbe("https://www.facebook.com/watch/?v=123", "facebook", { fetchFn: mockFetch });
    assert.equal(res.httpOk, false);
    assert.equal(res.status, null);
    assert.ok(res.error.includes("timed out"));
});

// =========================================================================
// 4. Early Response Rejection Tests (HTML Challenge, JSON Error, 0-byte)
// =========================================================================

test("Staging Harness: validateMediaResponseHeaders rejects HTML challenge response", () => {
    const response = {
        status: 200,
        headers: new Map([
            ["content-type", "text/html; charset=utf-8"],
            ["content-length", "4500"]
        ])
    };

    const res = validateMediaResponseHeaders(response);
    assert.equal(res.valid, false);
    assert.ok(res.error.includes("Rejected HTML response"));
});

test("Staging Harness: validateMediaResponseHeaders rejects JSON error response", () => {
    const response = {
        status: 200,
        headers: new Map([
            ["content-type", "application/json; charset=utf-8"],
            ["content-length", "120"]
        ])
    };

    const res = validateMediaResponseHeaders(response);
    assert.equal(res.valid, false);
    assert.ok(res.error.includes("Rejected JSON error response"));
});

test("Staging Harness: validateMediaResponseHeaders rejects 0-byte response header", () => {
    const response = {
        status: 200,
        headers: new Map([
            ["content-type", "video/mp4"],
            ["content-length", "0"]
        ])
    };

    const res = validateMediaResponseHeaders(response);
    assert.equal(res.valid, false);
    assert.ok(res.error.includes("Rejected 0-byte media stream"));
});

test("Staging Harness: validateMediaResponseHeaders accepts valid video response headers", () => {
    const response = {
        status: 200,
        headers: new Map([
            ["content-type", "video/mp4"],
            ["content-length", "10485760"]
        ])
    };

    const res = validateMediaResponseHeaders(response);
    assert.equal(res.valid, true);
    assert.equal(res.error, null);
});

// =========================================================================
// 5. Container Sniffing & FFmpeg Frame Validation Tests
// =========================================================================

test("Staging Harness: sniffContainerFormat correctly validates MP4 and WebM magic bytes", () => {
    // Valid MP4 buffer: offset 4 is 'ftyp'
    const mp4Buf = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    assert.equal(sniffContainerFormat(mp4Buf), "mp4");

    // Valid WebM buffer: starts with 0x1A 0x45 0xDF 0xA3
    const webmBuf = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81]);
    assert.equal(sniffContainerFormat(webmBuf), "webm");

    // Invalid container buffer (HTML / ASCII text: <!DOCTYPE)
    const htmlBuf = Buffer.from("<!DOCTYPE html><html><head>");
    assert.equal(sniffContainerFormat(htmlBuf), null);

    // Short buffer
    assert.equal(sniffContainerFormat(Buffer.from([0x01, 0x02])), null);
});

test("Staging Harness: verifyFfmpegDecode reports decoding errors cleanly", async () => {
    // Mock spawn failure / stderr output
    const mockSpawn = () => {
        const proc = new EventEmitter();
        proc.stderr = new EventEmitter();
        process.nextTick(() => {
            proc.stderr.emit("data", Buffer.from("Invalid data found when processing input\n"));
            proc.emit("close", 1);
        });
        return proc;
    };

    const res = await verifyFfmpegDecode("dummy_corrupt.tmp", { spawnFn: mockSpawn });
    assert.equal(res.valid, false);
    assert.ok(res.errors.length > 0);
    assert.ok(res.errors[0].includes("Invalid data found"));
});
