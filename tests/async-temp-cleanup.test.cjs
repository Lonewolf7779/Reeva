"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const http = require("node:http");

// Isolate temporary directory for this test worker to prevent cross-worker test interference
process.env.REEVA_TEMP_DIR = path.join(os.tmpdir(), `reeva-async-${process.pid}`);

const {
    REEVA_TEMP_DIR,
    cleanStaleTempFiles,
    cleanupTempFiles: ytCleanupTempFiles,
    extractYouTube,
    getActiveScanCount,
    getTargetCoordinator
} = require("../lib/extraction/adapters/youtube.cjs");
const {
    cleanupTempFiles: genericCleanupTempFiles,
    extractGeneric
} = require("../lib/extraction/adapters/generic.cjs");
const { defaultRegistry, MediaRegistry } = require("../lib/media-registry.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../lib/extraction/types.cjs");
const app = require("../server.cjs");

function ensureTempDir() {
    if (!fs.existsSync(REEVA_TEMP_DIR)) {
        fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });
    }
    return REEVA_TEMP_DIR;
}

test.before(async () => {
    // Settle any in-flight startup scan before starting test suite
    await cleanStaleTempFiles();
});

// ==============================================================================
// TEST A, C, D: STALE FILE CLEANUP WITH FILENAME & AGE FILTERING
// ==============================================================================

test("Async Cleanup (A, C, D): Removes eligible inactive files older than threshold, preserving recent and non-matching files", async () => {
    ensureTempDir();
    const id = crypto.randomBytes(6).toString("hex");
    const staleMux = path.join(REEVA_TEMP_DIR, `reeva_mux_stale_${id}.mp4`);
    const staleGen = path.join(REEVA_TEMP_DIR, `reeva_gen_stale_${id}.mp4`);
    const staleTest = path.join(REEVA_TEMP_DIR, `test_stale_${id}.tmp`);
    const recentMux = path.join(REEVA_TEMP_DIR, `reeva_mux_recent_${id}.mp4`);
    const unrelatedStale = path.join(REEVA_TEMP_DIR, `unrelated_file_${id}.mp4`);

    fs.writeFileSync(staleMux, "stale-mux");
    fs.writeFileSync(staleGen, "stale-gen");
    fs.writeFileSync(staleTest, "stale-test");
    fs.writeFileSync(recentMux, "recent-mux");
    fs.writeFileSync(unrelatedStale, "unrelated-stale");

    // Backdate stale files to 60 minutes ago
    const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleMux, oneHourAgo, oneHourAgo);
    fs.utimesSync(staleGen, oneHourAgo, oneHourAgo);
    fs.utimesSync(staleTest, oneHourAgo, oneHourAgo);
    fs.utimesSync(unrelatedStale, oneHourAgo, oneHourAgo);

    try {
        const removed = await cleanStaleTempFiles(15 * 60 * 1000);
        assert.ok(removed >= 3, `Expected at least 3 stale files removed, got ${removed}`);

        // Eligible stale files must be deleted
        assert.strictEqual(fs.existsSync(staleMux), false, "Stale mux file must be unlinked");
        assert.strictEqual(fs.existsSync(staleGen), false, "Stale gen file must be unlinked");
        assert.strictEqual(fs.existsSync(staleTest), false, "Stale test file must be unlinked");

        // Recent files must remain untouched
        assert.strictEqual(fs.existsSync(recentMux), true, "Recent file must be preserved");

        // Non-eligible filename prefixes must remain untouched even if older than maxAge
        assert.strictEqual(fs.existsSync(unrelatedStale), true, "Non-matching filename prefix must not be deleted");
    } finally {
        for (const f of [staleMux, staleGen, staleTest, recentMux, unrelatedStale]) {
            if (fs.existsSync(f)) {
                try { fs.unlinkSync(f); } catch (_) {}
            }
        }
    }
});

// ==============================================================================
// TEST B: ACTIVE-FILE LEASE PROTECTION DURING ASYNC CLEANUP
// ==============================================================================

test("Async Cleanup (B): Active-file leases protect files from unlinking and trigger deferred deletion upon release", async () => {
    ensureTempDir();
    const id = crypto.randomBytes(6).toString("hex");
    const leasedFile = path.join(REEVA_TEMP_DIR, `reeva_mux_leased_${id}.mp4`);
    fs.writeFileSync(leasedFile, "active-leased-media");

    // Backdate mtime to 60 minutes ago
    const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(leasedFile, oneHourAgo, oneHourAgo);

    // Acquire lease
    const release = defaultRegistry.acquireFileLease(leasedFile);
    assert.strictEqual(defaultRegistry.isPathActive(leasedFile), true);

    try {
        await cleanStaleTempFiles(15 * 60 * 1000);

        // File must remain alive on disk while leased
        assert.strictEqual(fs.existsSync(leasedFile), true, "Active leased file must not be removed by async cleanup");
        assert.strictEqual(defaultRegistry.isPendingDeletion(leasedFile), true, "Active file must be marked for pending deletion");

        // Release the lease
        release();

        // Must now be unlinked via deferred deletion
        assert.strictEqual(fs.existsSync(leasedFile), false, "File must be deleted upon release of final lease");
    } finally {
        release();
        if (fs.existsSync(leasedFile)) {
            try { fs.unlinkSync(leasedFile); } catch (_) {}
        }
    }
});

// ==============================================================================
// TEST E: MISSING FILES AND FILESYSTEM ERRORS
// ==============================================================================

test("Async Cleanup (E): Missing files and filesystem errors do not produce unhandled rejections", async () => {
    // Calling cleanupTempFiles with nonexistent paths or invalid types
    await assert.doesNotReject(async () => {
        await ytCleanupTempFiles(null);
        await ytCleanupTempFiles(undefined);
        await ytCleanupTempFiles("");
        await ytCleanupTempFiles(path.join(REEVA_TEMP_DIR, "nonexistent_dir_12345", "prefix"));
        await genericCleanupTempFiles(null);
        await genericCleanupTempFiles(path.join(REEVA_TEMP_DIR, "nonexistent_dir_67890", "prefix"));
    });

    // Calling cleanStaleTempFiles when path predicate throws
    await assert.doesNotReject(async () => {
        const faultyPredicate = () => {
            throw new Error("Simulated predicate error");
        };
        const removed = await cleanStaleTempFiles(15 * 60 * 1000, faultyPredicate);
        assert.strictEqual(typeof removed, "number");
    });
});

// ==============================================================================
// TEST F: CONCURRENT CLEANUP CALLS COALESCING
// ==============================================================================

test("Async Cleanup (F): Concurrent cleanup requests do not cause overlapping scans", async () => {
    ensureTempDir();
    const id = crypto.randomBytes(6).toString("hex");
    const staleFile = path.join(REEVA_TEMP_DIR, `reeva_mux_concur_${id}.mp4`);
    fs.writeFileSync(staleFile, "stale-concurrent");

    const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleFile, oneHourAgo, oneHourAgo);

    try {
        // Fire 5 simultaneous calls to cleanStaleTempFiles
        const results = await Promise.all([
            cleanStaleTempFiles(15 * 60 * 1000),
            cleanStaleTempFiles(15 * 60 * 1000),
            cleanStaleTempFiles(15 * 60 * 1000),
            cleanStaleTempFiles(15 * 60 * 1000),
            cleanStaleTempFiles(15 * 60 * 1000)
        ]);

        // All should resolve with the same coalesced result
        assert.strictEqual(results[0], results[1]);
        assert.strictEqual(results[0], results[2]);
        assert.strictEqual(results[0], results[3]);
        assert.strictEqual(results[0], results[4]);
        assert.ok(results[0] >= 1, "At least 1 file removed across concurrent calls");
        assert.strictEqual(fs.existsSync(staleFile), false);
        assert.strictEqual(getActiveScanCount(), 0, "No active scans should remain running");
    } finally {
        if (fs.existsSync(staleFile)) {
            try { fs.unlinkSync(staleFile); } catch (_) {}
        }
    }
});

// ==============================================================================
// TEST 6: EVENT-LOOP RESPONSIVENESS
// ==============================================================================

test("Async Cleanup (6): Asynchronous cleanup yields to the event loop", async () => {
    ensureTempDir();
    const id = crypto.randomBytes(4).toString("hex");
    const createdFiles = [];

    // Create 15 stale files
    const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    for (let i = 0; i < 15; i++) {
        const filePath = path.join(REEVA_TEMP_DIR, `test_yield_${id}_${i}.tmp`);
        fs.writeFileSync(filePath, `yield-content-${i}`);
        fs.utimesSync(filePath, oneHourAgo, oneHourAgo);
        createdFiles.push(filePath);
    }

    let eventLoopTurns = 0;
    let keepTicking = true;

    const tick = () => {
        if (!keepTicking) return;
        setImmediate(() => {
            eventLoopTurns++;
            tick();
        });
    };
    tick();

    try {
        await cleanStaleTempFiles(15 * 60 * 1000);
        keepTicking = false;

        assert.ok(
            eventLoopTurns > 0,
            `Event loop must execute turns while cleanup is in progress (observed turns: ${eventLoopTurns})`
        );
    } finally {
        keepTicking = false;
        for (const f of createdFiles) {
            if (fs.existsSync(f)) {
                try { fs.unlinkSync(f); } catch (_) {}
            }
        }
    }
});

// ==============================================================================
// TEST G: YOUTUBE EXTRACTION FAILURE CLEANUP
// ==============================================================================

test("Async Cleanup (G): YouTube extraction failure removes owned partial files", async () => {
    ensureTempDir();
    let capturedTempPrefix = null;

    const mockFailingRunner = async ({ args }) => {
        const outIdx = args.indexOf("-o");
        if (outIdx !== -1 && args[outIdx + 1]) {
            const tempFilePath = args[outIdx + 1];
            capturedTempPrefix = tempFilePath.replace(/\.mp4$/, "");
            // Simulate yt-dlp creating partial artifacts before failure
            fs.writeFileSync(`${capturedTempPrefix}.mp4.part`, "partial-video-stream");
            fs.writeFileSync(`${capturedTempPrefix}.temp.mp4`, "intermediate-temp-mux");
        }
        const err = new Error("yt-dlp process failure");
        err.exitCode = 1;
        throw err;
    };

    await assert.rejects(
        () => extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
            commandRunner: mockFailingRunner,
            ffmpegPath: "ffmpeg"
        }),
        (err) => err instanceof ExtractionError
    );

    assert.ok(capturedTempPrefix, "Temp prefix should have been captured");
    assert.strictEqual(
        fs.existsSync(`${capturedTempPrefix}.mp4.part`),
        false,
        "Partial .part file must be cleaned up on extraction failure"
    );
    assert.strictEqual(
        fs.existsSync(`${capturedTempPrefix}.temp.mp4`),
        false,
        "Temporary mux file must be cleaned up on extraction failure"
    );
});

// ==============================================================================
// TEST H: GENERIC EXTRACTION FAILURE CLEANUP
// ==============================================================================

test("Async Cleanup (H): Generic extraction failure removes owned partial files", async () => {
    ensureTempDir();
    let capturedTempPrefix = null;
    let callCount = 0;

    const mockFailingRunner = async ({ args }) => {
        callCount++;
        if (callCount === 1) {
            return {
                stdout: JSON.stringify({ id: "123", url: "https://example.com/video.mp4", ext: "mp4", title: "Test" }),
                stderr: "",
                exitCode: 0
            };
        }
        // Find output argument
        const outIdx = args.indexOf("-o");
        if (outIdx !== -1 && args[outIdx + 1]) {
            const tempFilePath = args[outIdx + 1];
            capturedTempPrefix = tempFilePath.replace(/\.mp4$/, "");
            fs.writeFileSync(`${capturedTempPrefix}.part`, "partial-stream");
        }
        return {
            stdout: JSON.stringify({ url: "https://example.com/video.mp4", ext: "mp4", title: "Test" }),
            stderr: "",
            exitCode: 1
        };
    };

    await assert.rejects(
        () => extractGeneric("https://commons.wikimedia.org/wiki/File:Test.webm", {
            commandRunner: mockFailingRunner
        }),
        (err) => err instanceof ExtractionError
    );

    assert.ok(capturedTempPrefix, "Temp prefix should have been captured");
    assert.strictEqual(
        fs.existsSync(`${capturedTempPrefix}.part`),
        false,
        "Partial file must be cleaned up on generic extraction failure"
    );
});

// ==============================================================================
// TEST I: EXTRACTION CANCELLATION CLEANUP
// ==============================================================================

test("Async Cleanup (I): Cancellation performs cleanup without masking original abort error", async () => {
    ensureTempDir();
    const ac = new AbortController();
    let capturedTempPrefix = null;

    const mockAbortingRunner = async ({ args, signal }) => {
        const outIdx = args.indexOf("-o");
        if (outIdx !== -1 && args[outIdx + 1]) {
            const tempFilePath = args[outIdx + 1];
            capturedTempPrefix = tempFilePath.replace(/\.mp4$/, "");
            fs.writeFileSync(`${capturedTempPrefix}.mp4.part`, "partial-abort-stream");
        }
        ac.abort();
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
    };

    await assert.rejects(
        () => extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
            commandRunner: mockAbortingRunner,
            ffmpegPath: "ffmpeg",
            signal: ac.signal
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.strictEqual(err.code, EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT);
            return true;
        }
    );

    assert.ok(capturedTempPrefix, "Temp prefix should have been captured");
    assert.strictEqual(
        fs.existsSync(`${capturedTempPrefix}.mp4.part`),
        false,
        "Partial file must be cleaned up on cancellation"
    );
});

// ==============================================================================
// TEST J: SHUTDOWN CLEANUP
// ==============================================================================

test("Async Cleanup (J): Graceful shutdown awaits cleanup and completes cleanly", async () => {
    ensureTempDir();
    const id = crypto.randomBytes(6).toString("hex");
    const staleFile = path.join(REEVA_TEMP_DIR, `reeva_mux_shutdown_${id}.mp4`);
    fs.writeFileSync(staleFile, "shutdown-stale");

    const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleFile, oneHourAgo, oneHourAgo);

    try {
        await app.gracefulShutdown("TEST_ASYNC_SHUTDOWN", { timeoutMs: 300, server: null });
        assert.strictEqual(fs.existsSync(staleFile), false, "Stale file must be unlinked during shutdown");
    } finally {
        app.resetShutdownState();
        if (fs.existsSync(staleFile)) {
            try { fs.unlinkSync(staleFile); } catch (_) {}
        }
    }
});

// ==============================================================================
// TEST K: DETERMINISTIC ASYNC DELETION VS STREAM LEASE COORDINATION
// ==============================================================================

test("Async Cleanup (K1): Pause during async deletion denies new leases and returns 404 MEDIA_NOT_FOUND", async () => {
    ensureTempDir();
    const id = crypto.randomBytes(6).toString("hex");
    const staleFile = path.join(REEVA_TEMP_DIR, `reeva_mux_race_${id}.mp4`);
    fs.writeFileSync(staleFile, Buffer.alloc(1024, "A"));

    const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleFile, oneHourAgo, oneHourAgo);

    const reg = defaultRegistry.registerMedia({
        upstreamUrl: "https://example.com/race.mp4",
        platform: "youtube",
        localFilePath: staleFile
    });

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    const originalUnlink = fs.promises.unlink;
    let resumeUnlink;
    const unlinkGate = new Promise((resolve) => {
        resumeUnlink = resolve;
    });
    let notifyEntered;
    const unlinkEntered = new Promise((resolve) => {
        notifyEntered = resolve;
    });

    fs.promises.unlink = async (targetPath) => {
        if (path.resolve(targetPath) === path.resolve(staleFile)) {
            notifyEntered();
            await unlinkGate;
        }
        return originalUnlink.call(fs.promises, targetPath);
    };

    try {
        const cleanupPromise = cleanStaleTempFiles(15 * 60 * 1000);

        // Wait until cleanStaleTempFiles has claimed deletion and entered async unlink
        await unlinkEntered;

        // 1. Verify deletion is active in registry
        assert.strictEqual(defaultRegistry.isDeletionInProgress(staleFile), true, "Deletion claim must be marked in progress");

        // 2. Direct file lease acquisition must be denied
        const deniedFileLease = defaultRegistry.acquireFileLease(staleFile);
        assert.strictEqual(deniedFileLease, null, "acquireFileLease must return null when deletion is claimed");

        // 3. Media stream lease acquisition must be denied
        const deniedStreamLease = defaultRegistry.acquireStreamLease(reg.id);
        assert.strictEqual(deniedStreamLease, null, "acquireStreamLease must return null when deletion is claimed");

        // 4. Active reader count must remain 0
        assert.strictEqual(defaultRegistry.getActiveReaderCount(staleFile), 0, "No active readers should be attached");

        // 5. HTTP streaming request during deletion must cleanly return 404 MEDIA_NOT_FOUND
        const res = await fetch(`http://127.0.0.1:${port}/api/media/${reg.id}`);
        assert.strictEqual(res.status, 404, "HTTP request during deletion must receive 404");
        const body = await res.json();
        assert.strictEqual(body.error.code, "MEDIA_NOT_FOUND", "Error code must be MEDIA_NOT_FOUND");

        // Release the pause to let deletion complete
        resumeUnlink();
        await cleanupPromise;

        // 6. Post-deletion state
        assert.strictEqual(defaultRegistry.isDeletionInProgress(staleFile), false, "Claim must be released after deletion");
        assert.strictEqual(fs.existsSync(staleFile), false, "File must be unlinked");
    } finally {
        fs.promises.unlink = originalUnlink;
        if (resumeUnlink) resumeUnlink();
        await new Promise((resolve) => server.close(resolve));
        if (fs.existsSync(staleFile)) {
            try { fs.unlinkSync(staleFile); } catch (_) {}
        }
    }
});

test("Async Cleanup (K2): Multiple concurrent active readers defer deletion until final lease release", async () => {
    ensureTempDir();
    const id = crypto.randomBytes(6).toString("hex");
    const staleFile = path.join(REEVA_TEMP_DIR, `reeva_mux_multi_${id}.mp4`);
    fs.writeFileSync(staleFile, Buffer.alloc(1024, "B"));

    const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleFile, oneHourAgo, oneHourAgo);

    const r1 = defaultRegistry.acquireFileLease(staleFile);
    const r2 = defaultRegistry.acquireFileLease(staleFile);
    assert.strictEqual(defaultRegistry.getActiveReaderCount(staleFile), 2);

    try {
        await cleanStaleTempFiles(15 * 60 * 1000);

        // Readers protected the file; it must not have been unlinked
        assert.strictEqual(fs.existsSync(staleFile), true, "File must be preserved while readers exist");
        assert.strictEqual(defaultRegistry.isPendingDeletion(staleFile), true, "File must be marked for pending deletion");
        assert.strictEqual(defaultRegistry.getActiveReaderCount(staleFile), 2);

        // First release: 1 reader remains, file still alive
        r1();
        assert.strictEqual(defaultRegistry.getActiveReaderCount(staleFile), 1);
        assert.strictEqual(fs.existsSync(staleFile), true, "File must be preserved while 1 reader remains");
        assert.strictEqual(defaultRegistry.isPendingDeletion(staleFile), true);

        // Second release: 0 readers remain, file must be immediately deleted
        r2();
        assert.strictEqual(defaultRegistry.getActiveReaderCount(staleFile), 0);
        assert.strictEqual(defaultRegistry.isPendingDeletion(staleFile), false);
        assert.strictEqual(fs.existsSync(staleFile), false, "File must be deleted after final reader releases lease");
    } finally {
        r1();
        r2();
        if (fs.existsSync(staleFile)) {
            try { fs.unlinkSync(staleFile); } catch (_) {}
        }
    }
});

test("Async Cleanup (K3): Deletion claim is released cleanly on filesystem unlink errors", async () => {
    ensureTempDir();
    const id = crypto.randomBytes(6).toString("hex");
    const staleFile = path.join(REEVA_TEMP_DIR, `reeva_mux_err_${id}.mp4`);
    fs.writeFileSync(staleFile, Buffer.alloc(512, "C"));

    const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleFile, oneHourAgo, oneHourAgo);

    const originalUnlink = fs.promises.unlink;
    fs.promises.unlink = async (targetPath) => {
        if (path.resolve(targetPath) === path.resolve(staleFile)) {
            throw new Error("Simulated EIO filesystem error");
        }
        return originalUnlink.call(fs.promises, targetPath);
    };

    try {
        await cleanStaleTempFiles(15 * 60 * 1000);

        // Claim must be released even though unlink threw
        assert.strictEqual(defaultRegistry.isDeletionInProgress(staleFile), false, "Claim must be released on failure");

        // Subsequent lease acquisition is possible again
        const lease = defaultRegistry.acquireFileLease(staleFile);
        assert.ok(typeof lease === "function", "Lease acquisition must be restored");
        lease();
    } finally {
        fs.promises.unlink = originalUnlink;
        if (fs.existsSync(staleFile)) {
            try { fs.unlinkSync(staleFile); } catch (_) {}
        }
    }
});

test("Async Cleanup (K4): MediaRegistry coordinated claimDeletion API contracts", () => {
    const reg = new MediaRegistry();
    const dummyPath = path.join(REEVA_TEMP_DIR, "contract_test.mp4");

    // Invalid / empty path returns false
    assert.strictEqual(reg.claimDeletion(""), false);
    assert.strictEqual(reg.claimDeletion(null), false);
    assert.strictEqual(reg.isDeletionInProgress(dummyPath), false);

    // Initial claim succeeds
    assert.strictEqual(reg.claimDeletion(dummyPath), true);
    assert.strictEqual(reg.isDeletionInProgress(dummyPath), true);

    // Second duplicate claim returns false
    assert.strictEqual(reg.claimDeletion(dummyPath), false);

    // Lease acquisition is denied while claimed
    assert.strictEqual(reg.acquireFileLease(dummyPath), null);

    // Release claim
    reg.releaseDeletionClaim(dummyPath);
    assert.strictEqual(reg.isDeletionInProgress(dummyPath), false);

    // Lease acquisition succeeds once claim released
    const release = reg.acquireFileLease(dummyPath);
    assert.ok(typeof release === "function");
    assert.strictEqual(reg.getActiveReaderCount(dummyPath), 1);

    // Claiming while reader active returns false and marks pending deletion
    assert.strictEqual(reg.claimDeletion(dummyPath), false);
    assert.strictEqual(reg.isPendingDeletion(dummyPath), true);

    release();
    reg.destroy();
});

// ==============================================================================
// TEST L: COMPLETE DELETION COORDINATION REQUIREMENT (PHASE 3.18D-2-FIX2)
// ==============================================================================

test("Async Cleanup (L1): getTargetCoordinator strictly validates complete coordinator API", () => {
    // 1. Default fallback resolves defaultRegistry
    assert.strictEqual(getTargetCoordinator(), defaultRegistry);
    assert.strictEqual(getTargetCoordinator(null), defaultRegistry);
    assert.strictEqual(getTargetCoordinator(undefined), defaultRegistry);

    // 2. Complete custom MediaRegistry resolves successfully
    const customReg = new MediaRegistry();
    assert.strictEqual(getTargetCoordinator(customReg), customReg);
    customReg.destroy();

    // 3. Callback-only argument returns null
    assert.strictEqual(getTargetCoordinator(() => false), null);
    assert.strictEqual(getTargetCoordinator(() => true), null);

    // 4. Incomplete coordinator: claimDeletion only returns null
    assert.strictEqual(getTargetCoordinator({ claimDeletion: () => true }), null);

    // 5. Incomplete coordinator: releaseDeletionClaim only returns null
    assert.strictEqual(getTargetCoordinator({ releaseDeletionClaim: () => {} }), null);

    // 6. Incomplete coordinator: isPathActive only returns null
    assert.strictEqual(getTargetCoordinator({ isPathActive: () => false }), null);

    // 7. Non-object invalid types return null
    assert.strictEqual(getTargetCoordinator("not-a-coordinator"), null);
    assert.strictEqual(getTargetCoordinator(12345), null);
    assert.strictEqual(getTargetCoordinator(true), null);
});

test("Async Cleanup (L2): Complete custom MediaRegistry coordinates stale-file deletion", async () => {
    ensureTempDir();
    const id = crypto.randomBytes(6).toString("hex");
    const staleFile = path.join(REEVA_TEMP_DIR, `reeva_mux_custom_${id}.mp4`);
    fs.writeFileSync(staleFile, Buffer.alloc(512, "L2"));

    const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleFile, oneHourAgo, oneHourAgo);

    const customReg = new MediaRegistry();
    let claimCalled = false;
    let releaseCalled = false;

    const originalClaim = customReg.claimDeletion.bind(customReg);
    const originalRelease = customReg.releaseDeletionClaim.bind(customReg);

    customReg.claimDeletion = (p) => {
        if (path.resolve(p) === path.resolve(staleFile)) claimCalled = true;
        return originalClaim(p);
    };
    customReg.releaseDeletionClaim = (p) => {
        if (path.resolve(p) === path.resolve(staleFile)) releaseCalled = true;
        return originalRelease(p);
    };

    try {
        const removed = await cleanStaleTempFiles(15 * 60 * 1000, customReg);
        assert.ok(removed >= 1, "Stale file must be removed by custom coordinator");
        assert.strictEqual(claimCalled, true, "claimDeletion must be called on custom coordinator");
        assert.strictEqual(releaseCalled, true, "releaseDeletionClaim must be called on custom coordinator");
        assert.strictEqual(fs.existsSync(staleFile), false, "Stale file must be unlinked");
    } finally {
        customReg.destroy();
        if (fs.existsSync(staleFile)) {
            try { fs.unlinkSync(staleFile); } catch (_) {}
        }
    }
});

test("Async Cleanup (L3): Callback-only argument fails safely and NEVER calls fs.promises.unlink", async () => {
    ensureTempDir();
    const id = crypto.randomBytes(6).toString("hex");
    const staleFile = path.join(REEVA_TEMP_DIR, `reeva_mux_callback_${id}.mp4`);
    fs.writeFileSync(staleFile, Buffer.alloc(512, "L3"));

    const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleFile, oneHourAgo, oneHourAgo);

    const originalUnlink = fs.promises.unlink;
    let unlinkAttempted = false;

    fs.promises.unlink = async (targetPath) => {
        if (path.resolve(targetPath) === path.resolve(staleFile)) {
            unlinkAttempted = true;
        }
        return originalUnlink.call(fs.promises, targetPath);
    };

    try {
        const callbackOnly = () => false; // Reports not-active
        const removed = await cleanStaleTempFiles(15 * 60 * 1000, callbackOnly);

        assert.strictEqual(removed, 0, "No files should be deleted without a complete coordinator");
        assert.strictEqual(unlinkAttempted, false, "fs.promises.unlink must NEVER be called without a deletion claim");
        assert.strictEqual(fs.existsSync(staleFile), true, "File must remain on disk when coordinator is missing");
    } finally {
        fs.promises.unlink = originalUnlink;
        if (fs.existsSync(staleFile)) {
            try { fs.unlinkSync(staleFile); } catch (_) {}
        }
    }
});

test("Async Cleanup (L4): Incomplete coordinator missing releaseDeletionClaim fails safely and NEVER calls fs.promises.unlink", async () => {
    ensureTempDir();
    const id = crypto.randomBytes(6).toString("hex");
    const staleFile = path.join(REEVA_TEMP_DIR, `reeva_mux_incompl1_${id}.mp4`);
    fs.writeFileSync(staleFile, Buffer.alloc(512, "L4"));

    const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleFile, oneHourAgo, oneHourAgo);

    const originalUnlink = fs.promises.unlink;
    let unlinkAttempted = false;

    fs.promises.unlink = async (targetPath) => {
        if (path.resolve(targetPath) === path.resolve(staleFile)) {
            unlinkAttempted = true;
        }
        return originalUnlink.call(fs.promises, targetPath);
    };

    try {
        const incompleteCoordinator = {
            claimDeletion: () => true
            // releaseDeletionClaim is deliberately absent
        };
        const removed = await cleanStaleTempFiles(15 * 60 * 1000, incompleteCoordinator);

        assert.strictEqual(removed, 0, "No files should be deleted with incomplete coordinator");
        assert.strictEqual(unlinkAttempted, false, "fs.promises.unlink must NEVER be called with incomplete coordinator");
        assert.strictEqual(fs.existsSync(staleFile), true, "File must remain on disk");
    } finally {
        fs.promises.unlink = originalUnlink;
        if (fs.existsSync(staleFile)) {
            try { fs.unlinkSync(staleFile); } catch (_) {}
        }
    }
});

test("Async Cleanup (L5): Incomplete coordinator missing claimDeletion fails safely and NEVER calls fs.promises.unlink", async () => {
    ensureTempDir();
    const id = crypto.randomBytes(6).toString("hex");
    const staleFile = path.join(REEVA_TEMP_DIR, `reeva_mux_incompl2_${id}.mp4`);
    fs.writeFileSync(staleFile, Buffer.alloc(512, "L5"));

    const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleFile, oneHourAgo, oneHourAgo);

    const originalUnlink = fs.promises.unlink;
    let unlinkAttempted = false;

    fs.promises.unlink = async (targetPath) => {
        if (path.resolve(targetPath) === path.resolve(staleFile)) {
            unlinkAttempted = true;
        }
        return originalUnlink.call(fs.promises, targetPath);
    };

    try {
        const incompleteCoordinator = {
            isPathActive: () => false,
            releaseDeletionClaim: () => {}
            // claimDeletion is deliberately absent
        };
        const removed = await cleanStaleTempFiles(15 * 60 * 1000, incompleteCoordinator);

        assert.strictEqual(removed, 0, "No files should be deleted with incomplete coordinator");
        assert.strictEqual(unlinkAttempted, false, "fs.promises.unlink must NEVER be called with incomplete coordinator");
        assert.strictEqual(fs.existsSync(staleFile), true, "File must remain on disk");
    } finally {
        fs.promises.unlink = originalUnlink;
        if (fs.existsSync(staleFile)) {
            try { fs.unlinkSync(staleFile); } catch (_) {}
        }
    }
});

test.after(() => {
    try {
        if (fs.existsSync(REEVA_TEMP_DIR)) {
            fs.rmSync(REEVA_TEMP_DIR, { recursive: true, force: true });
        }
    } catch (_) {}
});
