// tests/media-stream-protection.test.cjs — Deterministic Regression Tests for Active Local Media File Protection
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const { MediaRegistry, defaultRegistry } = require("../lib/media-registry.cjs");
const { REEVA_TEMP_DIR, cleanStaleTempFiles } = require("../lib/extraction/adapters/youtube.cjs");
const app = require("../server.cjs");

function ensureTempDir() {
    if (!fs.existsSync(REEVA_TEMP_DIR)) {
        fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });
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

test("Media Stream Protection: cleanStaleTempFiles skips files with active leases", () => {
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
        cleanStaleTempFiles(15 * 60 * 1000);

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

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
        // Before stream: 0 active readers
        assert.strictEqual(defaultRegistry.getActiveReaderCount(testFile), 0);

        const res = await fetch(`http://127.0.0.1:${port}/api/media/${reg.id}`);
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
        server.close();
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

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
        const controller = new AbortController();
        const res = await fetch(`http://127.0.0.1:${port}/api/media/${reg.id}`, {
            signal: controller.signal
        });
        assert.strictEqual(res.status, 200);

        // Read first chunk
        const reader = res.body.getReader();
        const chunk = await reader.read();
        assert.ok(chunk.value && chunk.value.length > 0);

        // Abort the client connection
        controller.abort();

        // Wait for server to process close/abort
        await new Promise((r) => setTimeout(r, 80));

        // Reader count must have been released
        assert.strictEqual(defaultRegistry.getActiveReaderCount(testFile), 0, "Reader count must be 0 after abort");
    } finally {
        server.close();
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
