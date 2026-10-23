// tests/media-stream-protection.test.cjs — Deterministic Regression Tests for Active Local Media File Protection
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");

// Isolate temporary directory for this test worker to prevent cross-worker test interference
process.env.REEVA_TEMP_DIR = path.join(os.tmpdir(), `reeva-msp-${process.pid}`);

const { MediaRegistry, defaultRegistry } = require("../lib/media-registry.cjs");
const { REEVA_TEMP_DIR, cleanStaleTempFiles } = require("../lib/extraction/adapters/youtube.cjs");
const { stopDefaultEgressProxy } = require("../lib/extraction/egress-proxy.cjs");
const app = require("../server.cjs");

function ensureTempDir() {
    if (!fs.existsSync(REEVA_TEMP_DIR)) {
        fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });
    }
}

before(async () => {
    // Settle any in-flight startup scan initiated by server.cjs before starting test suite
    await cleanStaleTempFiles();
});

function httpRequest({ method = "GET", path: reqPath, port, headers = {}, timeoutMs = 5000 }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
        };

        const safeReject = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        };

        const safeResolve = (val) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(val);
        };

        const req = http.request({
            host: "127.0.0.1",
            port,
            path: reqPath,
            method,
            agent: false,
            headers: { "Connection": "close", ...headers }
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const rawBody = Buffer.concat(chunks);
                safeResolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: rawBody,
                    arrayBuffer: async () => rawBody.buffer.slice(rawBody.byteOffset, rawBody.byteOffset + rawBody.byteLength),
                    json: async () => JSON.parse(rawBody.toString("utf8"))
                });
            });
            res.on("error", safeReject);
        });

        req.on("error", safeReject);

        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                const timeoutErr = new Error(`httpRequest timed out after ${timeoutMs}ms (${method} ${reqPath})`);
                req.destroy(timeoutErr);
                safeReject(timeoutErr);
            }, timeoutMs);
            if (timer.unref) timer.unref();
        }

        req.end();
    });
}

async function awaitWithTimeout(promise, timeoutMs, timeoutMessage) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
            })
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function trackServer(server) {
    if (!server) return server;
    const sockets = new Set();
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    server._sockets = sockets;
    return server;
}

async function closeServer(server, timeoutMs = 2000) {
    if (!server) return;
    if (server._sockets) {
        for (const s of server._sockets) {
            try { s.destroy(); } catch (_) {}
        }
        server._sockets.clear();
    }
    if (typeof server.closeIdleConnections === "function") {
        try { server.closeIdleConnections(); } catch (_) {}
    }
    if (typeof server.closeAllConnections === "function") {
        try { server.closeAllConnections(); } catch (_) {}
    }
    if (server.listening) {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                try { server.close(); } catch (_) {}
                resolve();
            }, timeoutMs);

            server.close(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
}

// ==============================================================================
// TEST A: TTL EXPIRATION DURING ACTIVE STREAMING
// ==============================================================================

test("Media Stream Protection: TTL expiration defers unlinking while lease is active", async () => {
    ensureTempDir();
    const testFile = path.join(REEVA_TEMP_DIR, `test_ttl_exp_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`);
    fs.writeFileSync(testFile, "test-ttl-content");

    // Short TTL (60ms)
    const registry = new MediaRegistry(10, 60);

    const reg = registry.registerMedia({
        upstreamUrl: "https://example.com/video.mp4",
        platform: "youtube",
        localFilePath: testFile
    });

    assert.ok(fs.existsSync(testFile));
    assert.strictEqual(registry.isPathActive(testFile), false);

    // Acquire active stream lease
    const lease = registry.acquireStreamLease(reg.id);
    assert.ok(lease);
    assert.strictEqual(registry.isPathActive(testFile), true);
    assert.strictEqual(registry.getActiveReaderCount(testFile), 1);

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 80));

    // Run sweep
    registry.sweepExpired();

    // 1. Entry must no longer be acquirable by new requests
    assert.strictEqual(registry.getMedia(reg.id), null, "Expired media must return null from getMedia");
    assert.strictEqual(registry.acquireStreamLease(reg.id), null, "Expired media must not grant new stream leases");

    // 2. Active reader's file must remain present on disk
    assert.strictEqual(fs.existsSync(testFile), true, "File must NOT be unlinked while stream lease is active");
    assert.strictEqual(registry.isPendingDeletion(testFile), true, "File must be marked for pending deletion");

    // 3. Release the lease
    lease.release();
    assert.strictEqual(registry.isPathActive(testFile), false);
    assert.strictEqual(registry.getActiveReaderCount(testFile), 0);

    // 4. Deferred deletion must now have occurred
    assert.strictEqual(fs.existsSync(testFile), false, "File must be unlinked once active lease is released");
    assert.strictEqual(registry.isPendingDeletion(testFile), false);

    registry.destroy();
});

// ==============================================================================
// TEST B: LRU EVICTION DURING ACTIVE STREAMING
// ==============================================================================

test("Media Stream Protection: LRU eviction preserves active file until lease is released", () => {
    ensureTempDir();
    const testFile1 = path.join(REEVA_TEMP_DIR, `test_lru_1_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`);
    fs.writeFileSync(testFile1, "lru-content-1");

    // Registry with max 2 entries
    const registry = new MediaRegistry(2, 60000);

    const entry1 = registry.registerMedia({
        upstreamUrl: "https://example.com/1.mp4",
        platform: "youtube",
        localFilePath: testFile1
    });

    // Acquire lease on entry 1
    const releaseLease1 = registry.acquireFileLease(testFile1);
    assert.strictEqual(registry.getActiveReaderCount(testFile1), 1);

    // Register 2 more entries to force entry 1 eviction via LRU
    registry.registerMedia({ upstreamUrl: "https://example.com/2.mp4", platform: "instagram" });
    registry.registerMedia({ upstreamUrl: "https://example.com/3.mp4", platform: "instagram" });

    // Entry 1 must be evicted from the store
    assert.strictEqual(registry.getMedia(entry1.id), null, "Oldest entry must be evicted from registry");

    // But file 1 must NOT be unlinked because lease is active
    assert.strictEqual(fs.existsSync(testFile1), true, "Evicted entry file must be preserved while lease is active");
    assert.strictEqual(registry.isPendingDeletion(testFile1), true);

    // Release lease
    releaseLease1();

    // File 1 must now be unlinked
    assert.strictEqual(fs.existsSync(testFile1), false, "File must be unlinked upon final lease release");
    assert.strictEqual(registry.isPendingDeletion(testFile1), false);

    registry.destroy();
});

// ==============================================================================
// TEST C: MULTIPLE SIMULTANEOUS READERS
// ==============================================================================

test("Media Stream Protection: Multiple readers keep file alive until last lease release", () => {
    ensureTempDir();
    const testFile = path.join(REEVA_TEMP_DIR, `test_multi_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`);
    fs.writeFileSync(testFile, "multi-reader-content");

    const registry = new MediaRegistry(10, 60000);
    const reg = registry.registerMedia({
        upstreamUrl: "https://example.com/multi.mp4",
        platform: "generic",
        localFilePath: testFile
    });

    const release1 = registry.acquireFileLease(testFile);
    const release2 = registry.acquireFileLease(testFile);
    assert.strictEqual(registry.getActiveReaderCount(testFile), 2);

    // Delete media entry while both readers are active
    const deleted = registry.deleteMedia(reg.id);
    assert.strictEqual(deleted, true);
    assert.strictEqual(registry.getMedia(reg.id), null);

    // File must still exist
    assert.strictEqual(fs.existsSync(testFile), true, "File must remain while 2 readers are active");
    assert.strictEqual(registry.isPendingDeletion(testFile), true);

    // Release first reader
    release1();
    assert.strictEqual(registry.getActiveReaderCount(testFile), 1);
    assert.strictEqual(fs.existsSync(testFile), true, "File must remain while 1 reader is still active");

    // Release second reader
    release2();
    assert.strictEqual(registry.getActiveReaderCount(testFile), 0);
    assert.strictEqual(fs.existsSync(testFile), false, "File must be deleted when final reader releases");
    assert.strictEqual(registry.isPendingDeletion(testFile), false);

    // Verify idempotent release calls do not throw or decrement below 0
    assert.doesNotThrow(() => {
        release1();
        release2();
    });
    assert.strictEqual(registry.getActiveReaderCount(testFile), 0);

    registry.destroy();
});

// ==============================================================================
// TEST D: STALE-FILE CLEANUP DURING ACTIVE STREAMING
// ==============================================================================

test("Media Stream Protection: cleanStaleTempFiles skips files with active leases", async () => {
    ensureTempDir();
    const staleFile = path.join(REEVA_TEMP_DIR, `reeva_mux_stale_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`);
    fs.writeFileSync(staleFile, "stale-video-content");

    // Backdate mtime to 60 minutes ago
    const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleFile, oneHourAgo, oneHourAgo);

    // Acquire active lease on defaultRegistry
    const release = defaultRegistry.acquireFileLease(staleFile);
    assert.strictEqual(defaultRegistry.isPathActive(staleFile), true);

    try {
        // Run stale cleanup with 15 min threshold
        await cleanStaleTempFiles(15 * 60 * 1000);

        // Active file must be preserved!
        assert.strictEqual(fs.existsSync(staleFile), true, "Active leased file must not be removed by cleanStaleTempFiles");
        assert.strictEqual(defaultRegistry.isPendingDeletion(staleFile), true, "Stale scan must mark pending deletion");

        // Release the lease
        release();

        // Must now be cleaned up
        assert.strictEqual(fs.existsSync(staleFile), false, "Deferred deletion must unlink file after release");
    } finally {
        release();
        if (fs.existsSync(staleFile)) {
            try { fs.unlinkSync(staleFile); } catch (_) {}
        }
    }
});

// ==============================================================================
// TEST E: READER LIFECYCLE INTEGRATION (SERVER STREAMING)
// ==============================================================================

test("Media Stream Protection: HTTP streaming acquires and releases lease cleanly on completion", async () => {
    ensureTempDir();
    const testFile = path.join(REEVA_TEMP_DIR, `test_http_complete_${Date.now()}.mp4`);
    fs.writeFileSync(testFile, Buffer.alloc(32 * 1024, "X")); // 32 KB

    const reg = defaultRegistry.registerMedia({
        upstreamUrl: "https://example.com/test.mp4",
        platform: "youtube",
        localFilePath: testFile
    });

    const server = trackServer(http.createServer(app));
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
        // Before stream: 0 active readers
        assert.strictEqual(defaultRegistry.getActiveReaderCount(testFile), 0);

        const res = await httpRequest({
            port,
            path: `/api/media/${reg.id}`
        });
        assert.strictEqual(res.status, 200);

        const buf = await res.arrayBuffer();
        assert.strictEqual(buf.byteLength, 32 * 1024);

        // Wait a brief tick for finish/close events to process
        await new Promise((r) => setTimeout(r, 60));

        // After stream completion: reader count must be 0 (no leaks)
        assert.strictEqual(defaultRegistry.getActiveReaderCount(testFile), 0, "Active reader count must return to 0");

        // Explicit deletion unlinks file immediately
        defaultRegistry.deleteMedia(reg.id);
        assert.strictEqual(fs.existsSync(testFile), false, "File must be unlinked when no readers are active");
    } finally {
        await closeServer(server);
        if (fs.existsSync(testFile)) {
            try { fs.unlinkSync(testFile); } catch (_) {}
        }
    }
});

test("Media Stream Protection: HTTP client abort releases lease immediately", async () => {
    ensureTempDir();
    const testFile = path.join(REEVA_TEMP_DIR, `test_http_abort_${Date.now()}.mp4`);
    fs.writeFileSync(testFile, Buffer.alloc(1024 * 1024, "Y")); // 1 MB

    const reg = defaultRegistry.registerMedia({
        upstreamUrl: "https://example.com/abort.mp4",
        platform: "youtube",
        localFilePath: testFile
    });

    const server = trackServer(http.createServer(app));
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    let clientReq;
    try {
        let firstChunkReceived = false;
        const chunkPromise = new Promise((resolve) => {
            clientReq = http.request({
                host: "127.0.0.1",
                port,
                path: `/api/media/${reg.id}`,
                method: "GET",
                agent: false,
                headers: { "Connection": "close" }
            }, (res) => {
                res.on("data", (chunk) => {
                    if (!firstChunkReceived && chunk.length > 0) {
                        firstChunkReceived = true;
                        resolve(chunk);
                    }
                });
                res.on("error", () => {});
            });
            clientReq.on("error", () => {});
            clientReq.end();
        });

        const chunk = await chunkPromise;
        assert.ok(chunk && chunk.length > 0);

        // Abort the client connection immediately
        clientReq.destroy();

        // Wait for server to process close/abort
        await new Promise((r) => setTimeout(r, 80));

        // Reader count must have been released
        assert.strictEqual(defaultRegistry.getActiveReaderCount(testFile), 0, "Reader count must be 0 after abort");
    } finally {
        if (clientReq && !clientReq.destroyed) {
            try { clientReq.destroy(); } catch (_) {}
        }
        await closeServer(server);
        defaultRegistry.deleteMedia(reg.id);
        if (fs.existsSync(testFile)) {
            try { fs.unlinkSync(testFile); } catch (_) {}
        }
    }
});

// ==============================================================================
// TEST F: REMOTE MEDIA REGRESSION
// ==============================================================================

test("Media Stream Protection: Remote media entries function without filesystem leases", () => {
    const registry = new MediaRegistry(10, 60000);
    const reg = registry.registerMedia({
        upstreamUrl: "https://instagram.com/cdn/remote.mp4",
        platform: "instagram",
        type: "video"
    });

    assert.ok(reg.id.startsWith("med_"));
    const entry = registry.getMedia(reg.id);
    assert.strictEqual(entry.upstreamUrl, "https://instagram.com/cdn/remote.mp4");
    assert.strictEqual(entry.localFilePath, null);

    // acquireStreamLease on remote media returns safe no-op release
    const lease = registry.acquireStreamLease(reg.id);
    assert.ok(lease);
    assert.doesNotThrow(() => lease.release());

    // deleteMedia operates normally
    assert.strictEqual(registry.deleteMedia(reg.id), true);
    assert.strictEqual(registry.getMedia(reg.id), null);

    registry.destroy();
});

// ==============================================================================
// TEST G: ASYNCHRONOUS LOCAL MEDIA STREAM FILE VALIDATION (PHASE 3.18D-3-FIX1)
// ==============================================================================

test("Media Stream Protection (G1): Missing local file returns 404 MEDIA_NOT_FOUND and releases lease", async () => {
    ensureTempDir();
    const missingFile = path.join(REEVA_TEMP_DIR, `test_missing_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`);
    if (fs.existsSync(missingFile)) {
        fs.unlinkSync(missingFile);
    }

    const reg = defaultRegistry.registerMedia({
        upstreamUrl: "https://example.com/missing.mp4",
        platform: "youtube",
        localFilePath: missingFile
    });

    const server = trackServer(http.createServer(app));
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
        assert.strictEqual(defaultRegistry.getActiveReaderCount(missingFile), 0);

        const res = await httpRequest({
            port,
            path: `/api/media/${reg.id}`
        });
        assert.strictEqual(res.status, 404);

        const body = await res.json();
        assert.strictEqual(body.error.code, "MEDIA_NOT_FOUND");
        assert.strictEqual(body.error.message, "The requested media file has expired or does not exist.");

        // Wait brief tick to confirm lease release
        await new Promise((r) => setTimeout(r, 40));
        assert.strictEqual(defaultRegistry.getActiveReaderCount(missingFile), 0, "Lease must be released on missing file");
    } finally {
        await closeServer(server);
        defaultRegistry.deleteMedia(reg.id);
    }
});

test("Media Stream Protection (G2): Oversized local file returns 413 PAYLOAD_TOO_LARGE and releases lease", async () => {
    ensureTempDir();
    const testFile = path.join(REEVA_TEMP_DIR, `test_oversized_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`);
    fs.writeFileSync(testFile, Buffer.alloc(1024, "O"));

    const reg = defaultRegistry.registerMedia({
        upstreamUrl: "https://example.com/oversized.mp4",
        platform: "youtube",
        localFilePath: testFile
    });

    const server = trackServer(http.createServer(app));
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    const originalStat = fs.promises.stat;
    // Simulate oversized file (300 MB > 250 MB ceiling)
    fs.promises.stat = async (targetPath) => {
        if (path.resolve(targetPath) === path.resolve(testFile)) {
            return { size: 300 * 1024 * 1024 };
        }
        return originalStat.call(fs.promises, targetPath);
    };

    try {
        const res = await httpRequest({
            port,
            path: `/api/media/${reg.id}`
        });
        assert.strictEqual(res.status, 413);

        const body = await res.json();
        assert.strictEqual(body.error.code, "PAYLOAD_TOO_LARGE");
        assert.strictEqual(body.error.message, "Media stream exceeded maximum permitted size.");

        await new Promise((r) => setTimeout(r, 40));
        assert.strictEqual(defaultRegistry.getActiveReaderCount(testFile), 0, "Lease must be released on oversized file");
    } finally {
        fs.promises.stat = originalStat;
        await closeServer(server);
        defaultRegistry.deleteMedia(reg.id);
        if (fs.existsSync(testFile)) {
            try { fs.unlinkSync(testFile); } catch (_) {}
        }
    }
});

test("Media Stream Protection (G3): Unexpected filesystem errors return 500 STREAM_ERROR and release lease", async () => {
    ensureTempDir();
    const testFile = path.join(REEVA_TEMP_DIR, `test_ioerr_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`);
    fs.writeFileSync(testFile, Buffer.alloc(1024, "E"));

    const reg = defaultRegistry.registerMedia({
        upstreamUrl: "https://example.com/ioerr.mp4",
        platform: "youtube",
        localFilePath: testFile
    });

    const server = trackServer(http.createServer(app));
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    const originalStat = fs.promises.stat;
    // Simulate unexpected filesystem I/O error
    fs.promises.stat = async (targetPath) => {
        if (path.resolve(targetPath) === path.resolve(testFile)) {
            const err = new Error("Simulated I/O disk hardware error");
            err.code = "EIO";
            throw err;
        }
        return originalStat.call(fs.promises, targetPath);
    };

    try {
        const res = await httpRequest({
            port,
            path: `/api/media/${reg.id}`
        });
        assert.strictEqual(res.status, 500);

        const body = await res.json();
        assert.strictEqual(body.error.code, "STREAM_ERROR");
        assert.strictEqual(body.error.message, "Failed to stream local media file.");

        await new Promise((r) => setTimeout(r, 40));
        assert.strictEqual(defaultRegistry.getActiveReaderCount(testFile), 0, "Lease must be released on filesystem error");
    } finally {
        fs.promises.stat = originalStat;
        await closeServer(server);
        defaultRegistry.deleteMedia(reg.id);
        if (fs.existsSync(testFile)) {
            try { fs.unlinkSync(testFile); } catch (_) {}
        }
    }
});

test("Media Stream Protection (G4): Client abort while async stat is pending releases lease without opening stream", async () => {
    ensureTempDir();
    const testFile = path.join(REEVA_TEMP_DIR, `test_abort_stat_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`);
    fs.writeFileSync(testFile, Buffer.alloc(1024, "A"));

    const reg = defaultRegistry.registerMedia({
        upstreamUrl: "https://example.com/abort-stat.mp4",
        platform: "youtube",
        localFilePath: testFile
    });

    let notifyServerDisconnected;
    const serverDisconnected = new Promise((resolve) => {
        notifyServerDisconnected = resolve;
    });

    const server = trackServer(http.createServer((req, res) => {
        res.on("close", () => {
            if (!res.writableEnded) {
                notifyServerDisconnected();
            }
        });
        app(req, res);
    }));
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    const originalStat = fs.promises.stat;
    const originalCreateReadStream = fs.createReadStream;

    let resumeStat;
    const statGate = new Promise((resolve) => {
        resumeStat = resolve;
    });
    let notifyStatStarted;
    const statStarted = new Promise((resolve) => {
        notifyStatStarted = resolve;
    });

    let readStreamCreatedForTestFile = false;

    let statCount = 0;
    fs.promises.stat = async (targetPath) => {
        if (path.resolve(targetPath) === path.resolve(testFile)) {
            statCount++;
            if (statCount === 1) {
                notifyStatStarted();
                await statGate;
            }
        }
        return originalStat.call(fs.promises, targetPath);
    };

    fs.createReadStream = function (targetPath, options) {
        if (typeof targetPath === "string" && path.resolve(targetPath) === path.resolve(testFile)) {
            readStreamCreatedForTestFile = true;
        }
        return originalCreateReadStream.call(fs, targetPath, options);
    };

    let clientReq;
    try {
        const reqPromise = new Promise((resolve) => {
            clientReq = http.request({
                host: "127.0.0.1",
                port,
                path: `/api/media/${reg.id}`,
                method: "GET",
                agent: false,
                headers: { "Connection": "close" }
            }, (res) => {
                res.on("data", () => {});
                res.on("end", resolve);
            });
            clientReq.on("error", () => resolve());
            clientReq.end();
        });

        // 1. Wait until server has acquired lease and entered async stat (bounded timeout)
        await awaitWithTimeout(statStarted, 5000, "Stat operation did not start within timeout");
        assert.strictEqual(defaultRegistry.getActiveReaderCount(testFile), 1, "Lease must be held while stat is pending");

        // 2. Client disconnects before the stat operation completes
        clientReq.destroy();

        // 3. Server observes premature response termination (bounded timeout)
        await awaitWithTimeout(serverDisconnected, 5000, "Server did not observe premature response termination within timeout");

        // 4. The stat operation is subsequently allowed to complete
        resumeStat();
        await reqPromise;

        // 5. Bounded wait for server cancellation handling to finish lease release
        const start = Date.now();
        while (defaultRegistry.getActiveReaderCount(testFile) > 0 && Date.now() - start < 1000) {
            await new Promise((r) => setTimeout(r, 20));
        }

        // 6. fs.createReadStream() is NOT called for that media file
        assert.strictEqual(readStreamCreatedForTestFile, false, "createReadStream must NOT be called for aborted request");

        // 7. The active-reader lease returns to zero
        assert.strictEqual(defaultRegistry.getActiveReaderCount(testFile), 0, "Lease must return to 0 after aborted stat");
    } finally {
        // 8. Clean up mocks, promises, and servers in finally block
        fs.promises.stat = originalStat;
        fs.createReadStream = originalCreateReadStream;
        if (resumeStat) resumeStat();
        if (clientReq && !clientReq.destroyed) {
            try { clientReq.destroy(); } catch (_) {}
        }
        await closeServer(server);
        defaultRegistry.deleteMedia(reg.id);
        if (fs.existsSync(testFile)) {
            try { fs.unlinkSync(testFile); } catch (_) {}
        }
    }
});

test("Media Stream Protection (G5): Client abort while async stat is pending followed by stat error releases lease without opening stream or unhandled exception", async () => {
    ensureTempDir();
    const testFile = path.join(REEVA_TEMP_DIR, `test_abort_stat_err_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`);
    fs.writeFileSync(testFile, Buffer.alloc(1024, "E"));

    const reg = defaultRegistry.registerMedia({
        upstreamUrl: "https://example.com/abort-stat-err.mp4",
        platform: "youtube",
        localFilePath: testFile
    });

    let notifyServerDisconnected;
    const serverDisconnected = new Promise((resolve) => {
        notifyServerDisconnected = resolve;
    });

    const server = trackServer(http.createServer((req, res) => {
        res.on("close", () => {
            if (!res.writableEnded) {
                notifyServerDisconnected();
            }
        });
        app(req, res);
    }));
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    const originalStat = fs.promises.stat;
    const originalCreateReadStream = fs.createReadStream;

    let resumeStat;
    const statGate = new Promise((resolve) => {
        resumeStat = resolve;
    });
    let notifyStatStarted;
    const statStarted = new Promise((resolve) => {
        notifyStatStarted = resolve;
    });

    let readStreamCreatedForTestFile = false;

    let statErrCount = 0;
    fs.promises.stat = async (targetPath) => {
        if (path.resolve(targetPath) === path.resolve(testFile)) {
            statErrCount++;
            if (statErrCount === 1) {
                notifyStatStarted();
                await statGate;
                const err = new Error("Simulated I/O failure during cancelled stat");
                err.code = "EIO";
                throw err;
            }
        }
        return originalStat.call(fs.promises, targetPath);
    };

    fs.createReadStream = function (targetPath, options) {
        if (typeof targetPath === "string" && path.resolve(targetPath) === path.resolve(testFile)) {
            readStreamCreatedForTestFile = true;
        }
        return originalCreateReadStream.call(fs, targetPath, options);
    };

    let clientReq;
    try {
        const reqPromise = new Promise((resolve) => {
            clientReq = http.request({
                host: "127.0.0.1",
                port,
                path: `/api/media/${reg.id}`,
                method: "GET",
                agent: false,
                headers: { "Connection": "close" }
            }, (res) => {
                res.on("data", () => {});
                res.on("end", resolve);
            });
            clientReq.on("error", () => resolve());
            clientReq.end();
        });

        // 1. Wait until server has acquired lease and entered async stat (bounded timeout)
        await awaitWithTimeout(statStarted, 5000, "Stat operation did not start within timeout");
        assert.strictEqual(defaultRegistry.getActiveReaderCount(testFile), 1, "Lease must be held while stat is pending");

        // 2. Client disconnects before the stat operation completes
        clientReq.destroy();

        // 3. Server observes premature response termination (bounded timeout)
        await awaitWithTimeout(serverDisconnected, 5000, "Server did not observe premature response termination within timeout");

        // 4. The stat operation is allowed to complete (with error)
        resumeStat();
        await reqPromise;

        // 5. Bounded wait for server cancellation handling to finish lease release
        const start = Date.now();
        while (defaultRegistry.getActiveReaderCount(testFile) > 0 && Date.now() - start < 1000) {
            await new Promise((r) => setTimeout(r, 20));
        }

        // 6. fs.createReadStream() is NOT called for that media file
        assert.strictEqual(readStreamCreatedForTestFile, false, "createReadStream must NOT be called when stat fails after abort");

        // 7. The active-reader lease returns to zero
        assert.strictEqual(defaultRegistry.getActiveReaderCount(testFile), 0, "Lease must return to 0 after aborted stat error");
    } finally {
        // 8. Clean up mocks, promises, and servers in finally block
        fs.promises.stat = originalStat;
        fs.createReadStream = originalCreateReadStream;
        if (resumeStat) resumeStat();
        if (clientReq && !clientReq.destroyed) {
            try { clientReq.destroy(); } catch (_) {}
        }
        await closeServer(server);
        defaultRegistry.deleteMedia(reg.id);
        if (fs.existsSync(testFile)) {
            try { fs.unlinkSync(testFile); } catch (_) {}
        }
    }
});

after(async () => {
    http.globalAgent.destroy();
    await stopDefaultEgressProxy();
    try {
        if (fs.existsSync(REEVA_TEMP_DIR)) {
            fs.rmSync(REEVA_TEMP_DIR, { recursive: true, force: true });
        }
    } catch (_) {}
});
