"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

// Isolate temporary directory for this test worker to prevent cross-worker test interference
process.env.REEVA_TEMP_DIR = path.join(os.tmpdir(), `reeva-async-${process.pid}`);

const {
    REEVA_TEMP_DIR,
    cleanStaleTempFiles,
    cleanupTempFiles: ytCleanupTempFiles,
    extractYouTube,
    getActiveScanCount
} = require("../lib/extraction/adapters/youtube.cjs");
const {
    cleanupTempFiles: genericCleanupTempFiles,
    extractGeneric
} = require("../lib/extraction/adapters/generic.cjs");
const { defaultRegistry } = require("../lib/media-registry.cjs");
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

test.after(() => {
    try {
        if (fs.existsSync(REEVA_TEMP_DIR)) {
            fs.rmSync(REEVA_TEMP_DIR, { recursive: true, force: true });
        }
    } catch (_) {}
});
