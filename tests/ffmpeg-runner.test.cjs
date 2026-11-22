// tests/ffmpeg-runner.test.cjs — Isolated Tests for Secure FFmpeg & ffprobe Runner
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const {
    MEDIA_PROCESSOR_ERROR_CODES,
    MediaProcessingError,
    validateContainedPath,
    resolveBinaryPath,
    validateSpawnArgs,
    executeBinary,
    validateProcessingProfile,
    buildFfmpegArgs,
    createProcessingLimiter,
    probeMediaFile,
    processMedia
} = require("../lib/media-processor/ffmpeg-runner.cjs");

function createTempWorkspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "reeva-ffmpeg-test-"));
}

function cleanupWorkspace(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

function createFakeProc({ exitCode = 0, stdoutData = "", stderrData = "", delayMs = 5, onSpawn = null } = {}) {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.pid = 999999;
    proc.killed = false;
    proc.kill = (sig) => {
        proc.killed = true;
        process.nextTick(() => proc.emit("close", null, sig || "SIGTERM"));
    };

    if (onSpawn) onSpawn(proc);

    const timer = setTimeout(() => {
        if (proc.killed) return;
        if (stdoutData) proc.stdout.write(stdoutData);
        if (stderrData) proc.stderr.write(stderrData);
        proc.stdout.end();
        proc.stderr.end();
        proc.emit("close", exitCode, null);
    }, delayMs);

    return proc;
}

test("1. Valid execution via real spawn (shell: false) and -nostdin injection", async () => {
    const seenArgs = [];
    const res = await executeBinary({
        binary: "ffmpeg",
        binaryPath: process.execPath,
        args: ["-e", "process.stdout.write('ok')"],
        spawnFn: (cmd, args, opts) => {
            seenArgs.push(...args);
            assert.equal(opts.shell, false);
            assert.equal(args[0], "-nostdin");
            // Run actual node -e without -nostdin by forwarding the script
            return require("child_process").spawn(cmd, ["-e", "process.stdout.write('ok')"], opts);
        }
    });

    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout, "ok");
    assert.equal(seenArgs[0], "-nostdin");
});

test("2. Missing and invalid executable paths reject safely without leaking filesystem paths", () => {
    const tmpDir = createTempWorkspace();
    try {
        const origFfmpeg = process.env.FFMPEG_PATH;
        delete process.env.FFMPEG_PATH;

        assert.throws(
            () => resolveBinaryPath("ffmpeg"),
            (err) => err instanceof MediaProcessingError && err.code === MEDIA_PROCESSOR_ERROR_CODES.BINARY_NOT_FOUND
        );

        const missingPath = path.join(tmpDir, "missing-secret-dir", "ffmpeg");
        assert.throws(
            () => resolveBinaryPath("ffmpeg", missingPath),
            (err) => {
                assert.equal(err.code, MEDIA_PROCESSOR_ERROR_CODES.BINARY_NOT_FOUND);
                assert.equal(err.publicMessage.includes("missing-secret-dir"), false);
                return true;
            }
        );

        assert.throws(
            () => resolveBinaryPath("ffmpeg", tmpDir),
            (err) => err instanceof MediaProcessingError && err.code === MEDIA_PROCESSOR_ERROR_CODES.INVALID_BINARY_PATH
        );

        assert.throws(
            () => resolveBinaryPath("ffmpeg", "/usr/bin/ffmpeg\0bad"),
            (err) => err instanceof MediaProcessingError && err.code === MEDIA_PROCESSOR_ERROR_CODES.BINARY_NOT_FOUND
        );

        if (origFfmpeg !== undefined) process.env.FFMPEG_PATH = origFfmpeg;
    } finally {
        cleanupWorkspace(tmpDir);
    }
});

test("3. Invalid arguments rejected before spawn", async () => {
    assert.throws(
        () => validateSpawnArgs("not-an-array"),
        (err) => err instanceof MediaProcessingError && err.code === MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS
    );

    assert.throws(
        () => validateSpawnArgs(["-i", "bad\0arg"]),
        (err) => err instanceof MediaProcessingError && err.code === MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS
    );

    assert.throws(
        () => validateSpawnArgs(["-i", "bad\narg"]),
        (err) => err instanceof MediaProcessingError && err.code === MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS
    );
});

test("4. Execution timeout terminates child process and throws EXECUTION_TIMEOUT", async () => {
    await assert.rejects(
        () => executeBinary({
            binary: "ffmpeg",
            binaryPath: process.execPath,
            args: ["-e", "setTimeout(() => {}, 10000)"],
            timeoutMs: 150,
            spawnFn: (cmd, args, opts) => require("child_process").spawn(cmd, ["-e", "setTimeout(() => {}, 10000)"], opts)
        }),
        (err) => err instanceof MediaProcessingError && err.code === MEDIA_PROCESSOR_ERROR_CODES.EXECUTION_TIMEOUT
    );
});

test("5. Process cancellation via AbortSignal (pre-aborted and in-flight)", async () => {
    const preAborted = new AbortController();
    preAborted.abort();

    await assert.rejects(
        () => executeBinary({
            binary: "ffmpeg",
            binaryPath: process.execPath,
            args: ["-version"],
            signal: preAborted.signal
        }),
        (err) => err instanceof MediaProcessingError && err.code === MEDIA_PROCESSOR_ERROR_CODES.PROCESS_ABORTED
    );

    const inFlight = new AbortController();
    setTimeout(() => inFlight.abort(), 50);

    await assert.rejects(
        () => executeBinary({
            binary: "ffmpeg",
            binaryPath: process.execPath,
            args: ["-e", "setTimeout(() => {}, 10000)"],
            timeoutMs: 5000,
            signal: inFlight.signal,
            spawnFn: (cmd, args, opts) => require("child_process").spawn(cmd, ["-e", "setTimeout(() => {}, 10000)"], opts)
        }),
        (err) => err instanceof MediaProcessingError && err.code === MEDIA_PROCESSOR_ERROR_CODES.PROCESS_ABORTED
    );
});

test("6. Process failure and ENOENT spawn error handling", async () => {
    await assert.rejects(
        () => executeBinary({
            binary: "ffmpeg",
            binaryPath: process.execPath,
            args: ["-version"],
            spawnFn: () => createFakeProc({ exitCode: 1, stderrData: "Invalid data found" })
        }),
        (err) => err instanceof MediaProcessingError && err.code === MEDIA_PROCESSOR_ERROR_CODES.PROCESS_FAILED && err.exitCode === 1
    );

    await assert.rejects(
        () => executeBinary({
            binary: "ffmpeg",
            binaryPath: "/nonexistent/ffmpeg",
            skipExistsCheck: true,
            args: ["-version"],
            spawnFn: () => {
                const proc = new EventEmitter();
                proc.stdout = new PassThrough();
                proc.stderr = new PassThrough();
                process.nextTick(() => {
                    const e = new Error("spawn ENOENT");
                    e.code = "ENOENT";
                    proc.emit("error", e);
                });
                return proc;
            }
        }),
        (err) => err instanceof MediaProcessingError && err.code === MEDIA_PROCESSOR_ERROR_CODES.BINARY_NOT_FOUND
    );
});

test("7. Bounded stdout/stderr enforcement rejects excessive output", async () => {
    await assert.rejects(
        () => executeBinary({
            binary: "ffprobe",
            binaryPath: process.execPath,
            args: ["-version"],
            maxStdoutBytes: 32,
            spawnFn: () => createFakeProc({ stdoutData: "x".repeat(128), delayMs: 5 })
        }),
        (err) => err instanceof MediaProcessingError && err.code === MEDIA_PROCESSOR_ERROR_CODES.BUFFER_LIMIT_EXCEEDED
    );
});

test("8. Processing profile validation allows valid profiles and blocks arbitrary flags/options", () => {
    const compress = validateProcessingProfile({ operation: "compress", options: { preset: "compact" } });
    assert.equal(compress.outputExt, "mp4");

    const convert = validateProcessingProfile({ operation: "convert", options: { format: "webm" } });
    assert.equal(convert.outputExt, "webm");

    const audio = validateProcessingProfile({ operation: "extract_audio", options: { format: "mp3", bitrate: "128k" } });
    assert.equal(audio.outputExt, "mp3");

    const trim = validateProcessingProfile({ operation: "trim", options: { startSeconds: 5, endSeconds: 20, mode: "fast_copy" } });
    assert.equal(trim.durationSeconds, 15);

    const resize = validateProcessingProfile({ operation: "resize", options: { preset: "portrait_1080x1920", fit: "cover" } });
    const resizeArgs = buildFfmpegArgs(resize, "/tmp/in.mp4", "/tmp/out.mp4");
    assert.ok(resizeArgs.includes("-vf"));
    assert.ok(resizeArgs.includes("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"));

    // Reject unknown options / arbitrary filter injection
    assert.throws(
        () => validateProcessingProfile({ operation: "resize", options: { preset: "portrait_1080x1920", vf: "movie=/etc/passwd" } }),
        (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE
    );
    assert.throws(
        () => validateProcessingProfile({ operation: "unknown_op" }),
        (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE
    );
    assert.throws(
        () => validateProcessingProfile({ operation: "trim", options: { startSeconds: 20, endSeconds: 10 } }),
        (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE
    );
    assert.throws(
        () => validateProcessingProfile({ operation: "convert", options: { format: "exe" } }),
        (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.INVALID_PROFILE
    );
});

test("9. Path traversal attempts are strictly blocked", () => {
    const tmpDir = createTempWorkspace();
    try {
        assert.throws(
            () => validateContainedPath("../outside.mp4", tmpDir),
            (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.PATH_TRAVERSAL
        );

        assert.throws(
            () => validateContainedPath(path.join(os.tmpdir(), "outside.mp4"), tmpDir),
            (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.PATH_TRAVERSAL
        );

        assert.throws(
            () => validateContainedPath("file\0.mp4", tmpDir),
            (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.PATH_TRAVERSAL
        );
    } finally {
        cleanupWorkspace(tmpDir);
    }
});

test("10. processMedia temp cleanup on failure and success path", async () => {
    const tmpDir = createTempWorkspace();
    try {
        const inputFile = path.join(tmpDir, "input.mp4");
        fs.writeFileSync(inputFile, "dummy-video-bytes");

        // Failure case: fake ffmpeg writes partial output then exits 1 -> partial output must be deleted
        await assert.rejects(
            () => processMedia(
                { inputPath: inputFile, outputFileName: "partial.mp4", profile: { operation: "compress", options: { preset: "balanced" } } },
                {
                    baseDir: tmpDir,
                    ffmpegPath: process.execPath,
                    spawnFn: (_cmd, args) => {
                        const outPath = args[args.length - 1];
                        fs.writeFileSync(outPath, "partial-corrupt-data");
                        return createFakeProc({ exitCode: 1, delayMs: 5 });
                    }
                }
            ),
            (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.PROCESS_FAILED
        );
        assert.equal(fs.existsSync(path.join(tmpDir, "partial.mp4")), false);

        // Success case: fake ffmpeg writes valid output
        const result = await processMedia(
            { inputPath: inputFile, outputFileName: "done.mp3", profile: { operation: "extract_audio", options: { format: "mp3" } } },
            {
                baseDir: tmpDir,
                ffmpegPath: process.execPath,
                spawnFn: (_cmd, args) => {
                    const outPath = args[args.length - 1];
                    fs.writeFileSync(outPath, "valid-mp3-bytes");
                    return createFakeProc({ exitCode: 0, delayMs: 5 });
                }
            }
        );
        assert.equal(result.outputExt, "mp3");
        assert.equal(result.outputSizeBytes, 15);
        assert.equal(fs.existsSync(result.outputPath), true);
    } finally {
        cleanupWorkspace(tmpDir);
    }
});

test("11. Concurrent execution limits reject excess parallel jobs and release on completion", async () => {
    const tmpDir = createTempWorkspace();
    try {
        const inputFile = path.join(tmpDir, "input.mp4");
        fs.writeFileSync(inputFile, "dummy-video-bytes");
        const limiter = createProcessingLimiter(1);

        const job1 = processMedia(
            { inputPath: inputFile, outputFileName: "out1.mp4", profile: { operation: "compress" } },
            {
                baseDir: tmpDir,
                ffmpegPath: process.execPath,
                limiter,
                spawnFn: (_cmd, args) => {
                    const outPath = args[args.length - 1];
                    fs.writeFileSync(outPath, "out1");
                    return createFakeProc({ exitCode: 0, delayMs: 60 });
                }
            }
        );

        await assert.rejects(
            () => processMedia(
                { inputPath: inputFile, outputFileName: "out2.mp4", profile: { operation: "compress" } },
                { baseDir: tmpDir, ffmpegPath: process.execPath, limiter }
            ),
            (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.CONCURRENCY_LIMIT
        );

        await job1;
        assert.equal(limiter.getActiveCount(), 0);
    } finally {
        cleanupWorkspace(tmpDir);
    }
});

test("12. probeMediaFile parses valid ffprobe JSON and rejects malformed output", async () => {
    const tmpDir = createTempWorkspace();
    try {
        const inputFile = path.join(tmpDir, "clip.mp4");
        fs.writeFileSync(inputFile, "dummy");

        const probeResult = await probeMediaFile(inputFile, {
            baseDir: tmpDir,
            ffprobePath: process.execPath,
            spawnFn: () => createFakeProc({ stdoutData: JSON.stringify({ format: { duration: "12.5" }, streams: [] }) })
        });
        assert.equal(probeResult.format.duration, "12.5");

        await assert.rejects(
            () => probeMediaFile(inputFile, {
                baseDir: tmpDir,
                ffprobePath: process.execPath,
                spawnFn: () => createFakeProc({ stdoutData: "{not-json" })
            }),
            (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.PROCESS_FAILED
        );
    } finally {
        cleanupWorkspace(tmpDir);
    }
});

test("13. Input/output path overlap, output collision, empty input, and size limits are rejected", async () => {
    const tmpDir = createTempWorkspace();
    try {
        const inputFile = path.join(tmpDir, "clip.mp4");
        fs.writeFileSync(inputFile, "valid-input-bytes");

        // Overlap: outputFileName matches input filename
        await assert.rejects(
            () => processMedia(
                { inputPath: inputFile, outputFileName: "clip.mp4", profile: { operation: "compress" } },
                { baseDir: tmpDir, ffmpegPath: process.execPath }
            ),
            (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.INVALID_ARGUMENTS
        );
        assert.equal(fs.readFileSync(inputFile, "utf8"), "valid-input-bytes");

        // Collision: outputFileName already exists
        const existingOut = path.join(tmpDir, "existing.mp4");
        fs.writeFileSync(existingOut, "do-not-overwrite");
        await assert.rejects(
            () => processMedia(
                { inputPath: inputFile, outputFileName: "existing.mp4", profile: { operation: "compress" } },
                { baseDir: tmpDir, ffmpegPath: process.execPath }
            ),
            (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.STORAGE_ERROR && err.statusCode === 409
        );
        assert.equal(fs.readFileSync(existingOut, "utf8"), "do-not-overwrite");

        // Empty 0-byte input rejected
        const emptyFile = path.join(tmpDir, "empty.mp4");
        fs.writeFileSync(emptyFile, "");
        await assert.rejects(
            () => processMedia(
                { inputPath: emptyFile, profile: { operation: "compress" } },
                { baseDir: tmpDir, ffmpegPath: process.execPath }
            ),
            (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.INPUT_NOT_FOUND
        );

        // Input too large rejected
        await assert.rejects(
            () => processMedia(
                { inputPath: inputFile, profile: { operation: "compress" } },
                { baseDir: tmpDir, ffmpegPath: process.execPath, maxInputBytes: 4 }
            ),
            (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.INPUT_TOO_LARGE
        );

        // Output too large rejected and cleaned up
        await assert.rejects(
            () => processMedia(
                { inputPath: inputFile, outputFileName: "oversized.mp4", profile: { operation: "compress" } },
                {
                    baseDir: tmpDir,
                    ffmpegPath: process.execPath,
                    maxOutputBytes: 5,
                    spawnFn: (_cmd, args) => {
                        fs.writeFileSync(args[args.length - 1], "1234567890");
                        return createFakeProc({ exitCode: 0, delayMs: 5 });
                    }
                }
            ),
            (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.OUTPUT_TOO_LARGE
        );
        assert.equal(fs.existsSync(path.join(tmpDir, "oversized.mp4")), false);
    } finally {
        cleanupWorkspace(tmpDir);
    }
});

test("14. Cancellation during processMedia cleans up partial output and releases concurrency slot", async () => {
    const tmpDir = createTempWorkspace();
    try {
        const inputFile = path.join(tmpDir, "input.mp4");
        fs.writeFileSync(inputFile, "dummy-video-bytes");
        const limiter = createProcessingLimiter(1);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 40);

        await assert.rejects(
            () => processMedia(
                { inputPath: inputFile, outputFileName: "aborted.mp4", profile: { operation: "compress" } },
                {
                    baseDir: tmpDir,
                    ffmpegPath: process.execPath,
                    limiter,
                    signal: controller.signal,
                    spawnFn: (cmd, args, opts) => {
                        fs.writeFileSync(args[args.length - 1], "partial-bytes");
                        return require("child_process").spawn(cmd, ["-e", "setTimeout(() => {}, 5000)"], opts);
                    }
                }
            ),
            (err) => err.code === MEDIA_PROCESSOR_ERROR_CODES.PROCESS_ABORTED
        );

        assert.equal(fs.existsSync(path.join(tmpDir, "aborted.mp4")), false);
        assert.equal(limiter.getActiveCount(), 0);
    } finally {
        cleanupWorkspace(tmpDir);
    }
});
