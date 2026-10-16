// tests/production-preflight.test.cjs — Deterministic Tests for Production Binary and Storage Preflight
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const {
    ConfigError,
    validateBinaryExecutable,
    validateStorageDirectory,
    validateProductionPreflight
} = require("../lib/config.cjs");
const app = require("../server.cjs");

const TEST_DIR = path.join(os.tmpdir(), `reeva_preflight_test_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`);

function ensureCleanTestDir() {
    if (!fs.existsSync(TEST_DIR)) {
        fs.mkdirSync(TEST_DIR, { recursive: true });
    }
    return TEST_DIR;
}

function removeTestDir() {
    if (fs.existsSync(TEST_DIR)) {
        try {
            fs.rmSync(TEST_DIR, { recursive: true, force: true });
        } catch (_) {}
    }
}

// =========================================================================
// 1. Storage Validation Tests
// =========================================================================

test("validateStorageDirectory: Validates and creates directory if needed", () => {
    ensureCleanTestDir();
    const subDir = path.join(TEST_DIR, "media_sub");

    try {
        const resolved = validateStorageDirectory(subDir);
        assert.strictEqual(resolved, path.resolve(subDir));
        assert.strictEqual(fs.existsSync(subDir), true);
    } finally {
        removeTestDir();
    }
});

test("validateStorageDirectory: Rejects paths that are regular files", () => {
    ensureCleanTestDir();
    const filePath = path.join(TEST_DIR, "regular_file.tmp");
    fs.writeFileSync(filePath, "data");

    try {
        assert.throws(
            () => validateStorageDirectory(filePath),
            (err) => err instanceof ConfigError && err.message.includes("is not a directory")
        );
    } finally {
        removeTestDir();
    }
});

test("validateStorageDirectory: Rejects unwritable directories", () => {
    ensureCleanTestDir();

    // On Windows, read-only permissions on directories don't completely block file creations in some setups,
    // so we test by mocking writeFileSync or checking invalid root
    const invalidPath = process.platform === "win32" ? "Z:\\nonexistent_drive\\reeva" : "/proc/nonexistent/reeva";

    assert.throws(
        () => validateStorageDirectory(invalidPath),
        (err) => err instanceof ConfigError
    );
});

// =========================================================================
// 2. Binary Executable Validation Tests
// =========================================================================

test("validateBinaryExecutable: Rejects missing, empty, or nonexistent paths", async () => {
    await assert.rejects(
        () => validateBinaryExecutable("", "YT_DLP_PATH"),
        (err) => err instanceof ConfigError && err.message.includes("Missing required production binary configuration")
    );

    await assert.rejects(
        () => validateBinaryExecutable(null, "YT_DLP_PATH"),
        (err) => err instanceof ConfigError && err.message.includes("Missing required production binary configuration")
    );

    await assert.rejects(
        () => validateBinaryExecutable(path.join(TEST_DIR, "nonexistent.exe"), "YT_DLP_PATH"),
        (err) => err instanceof ConfigError && err.message.includes("does not exist")
    );
});

test("validateBinaryExecutable: Rejects directory paths for YT_DLP_PATH even if containing executable", async () => {
    ensureCleanTestDir();
    const dirPath = path.join(TEST_DIR, "ytdlp_directory");
    fs.mkdirSync(dirPath, { recursive: true });
    const nestedBin = path.join(dirPath, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    fs.writeFileSync(nestedBin, "dummy inside dir");

    try {
        await assert.rejects(
            () => validateBinaryExecutable(dirPath, "YT_DLP_PATH"),
            (err) => err instanceof ConfigError && err.message.includes("is a directory and cannot be used as an executable")
        );
    } finally {
        removeTestDir();
    }
});

test("validateBinaryExecutable: Resolves FFMPEG_PATH directory containing ffmpeg binary", async () => {
    ensureCleanTestDir();
    const dirPath = path.join(TEST_DIR, "ffmpeg_directory");
    fs.mkdirSync(dirPath, { recursive: true });
    const nestedBin = path.join(dirPath, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    fs.writeFileSync(nestedBin, "dummy inside dir");

    const mockRunner = async () => ({ stdout: "ffmpeg version 6.0", stderr: "", exitCode: 0 });

    try {
        const validated = await validateBinaryExecutable(dirPath, "FFMPEG_PATH", ["-version"], { runner: mockRunner });
        assert.strictEqual(validated, path.resolve(nestedBin));
    } finally {
        removeTestDir();
    }
});

test("validateBinaryExecutable: Successfully verifies valid binary with mock runner", async () => {
    ensureCleanTestDir();
    const dummyBin = path.join(TEST_DIR, "dummy_ytdlp.exe");
    fs.writeFileSync(dummyBin, "mock binary");

    const mockRunner = async (cmd, args) => {
        assert.strictEqual(cmd, path.resolve(dummyBin));
        assert.deepStrictEqual(args, ["--version"]);
        return { stdout: "2026.01.01\n", stderr: "", exitCode: 0 };
    };

    try {
        const validated = await validateBinaryExecutable(dummyBin, "YT_DLP_PATH", ["--version"], { runner: mockRunner });
        assert.strictEqual(validated, path.resolve(dummyBin));
    } finally {
        removeTestDir();
    }
});

test("validateBinaryExecutable: Rejects binary when version probe fails with non-zero exit code", async () => {
    ensureCleanTestDir();
    const brokenBin = path.join(TEST_DIR, "broken.exe");
    fs.writeFileSync(brokenBin, "broken binary");

    const mockRunner = async () => {
        return { stdout: "", stderr: "Segmentation fault\n", exitCode: 1 };
    };

    try {
        await assert.rejects(
            () => validateBinaryExecutable(brokenBin, "YT_DLP_PATH", ["--version"], { runner: mockRunner }),
            (err) => err instanceof ConfigError && err.message.includes("version probe failed with exit code 1")
        );
    } finally {
        removeTestDir();
    }
});

test("validateBinaryExecutable: Rejects binary when probe times out or runner throws", async () => {
    ensureCleanTestDir();
    const timeoutBin = path.join(TEST_DIR, "timeout.exe");
    fs.writeFileSync(timeoutBin, "timeout binary");

    const mockRunner = async () => {
        throw new ConfigError("Binary version probe timed out after 5000ms for 'timeout.exe'.");
    };

    try {
        await assert.rejects(
            () => validateBinaryExecutable(timeoutBin, "YT_DLP_PATH", ["--version"], { runner: mockRunner }),
            (err) => err instanceof ConfigError && err.message.includes("timed out")
        );
    } finally {
        removeTestDir();
    }
});

// =========================================================================
// 3. validateProductionPreflight Integration Tests
// =========================================================================

test("validateProductionPreflight: Production requires YT_DLP_PATH", async () => {
    ensureCleanTestDir();

    await assert.rejects(
        () => validateProductionPreflight({
            NODE_ENV: "production",
            FFMPEG_PATH: path.join(TEST_DIR, "ffmpeg.exe"),
            REEVA_TEMP_DIR: TEST_DIR
        }),
        (err) => err instanceof ConfigError && err.message.includes("Missing required production binary configuration: YT_DLP_PATH")
    );

    removeTestDir();
});

test("validateProductionPreflight: Production requires FFMPEG_PATH for default VIDEO_AND_AUDIO pipeline", async () => {
    ensureCleanTestDir();
    const dummyYt = path.join(TEST_DIR, "ytdlp.exe");
    fs.writeFileSync(dummyYt, "mock yt");

    const mockRunner = async () => ({ stdout: "1.0.0", stderr: "", exitCode: 0 });

    try {
        await assert.rejects(
            () => validateProductionPreflight({
                NODE_ENV: "production",
                YT_DLP_PATH: dummyYt,
                REEVA_TEMP_DIR: TEST_DIR
            }, { runner: mockRunner }),
            (err) => err instanceof ConfigError && err.message.includes("Missing required production binary configuration: FFMPEG_PATH")
        );
    } finally {
        removeTestDir();
    }
});

test("validateProductionPreflight: Production verifies both YT_DLP_PATH and FFMPEG_PATH", async () => {
    ensureCleanTestDir();
    const dummyYt = path.join(TEST_DIR, "ytdlp.exe");
    const dummyFfmpeg = path.join(TEST_DIR, "ffmpeg.exe");
    fs.writeFileSync(dummyYt, "mock yt");
    fs.writeFileSync(dummyFfmpeg, "mock ffmpeg");

    const probed = [];
    const mockRunner = async (cmd, args) => {
        probed.push({ cmd, args });
        return { stdout: "1.0.0", stderr: "", exitCode: 0 };
    };

    try {
        const result = await validateProductionPreflight({
            NODE_ENV: "production",
            YT_DLP_PATH: dummyYt,
            FFMPEG_PATH: dummyFfmpeg,
            REEVA_TEMP_DIR: TEST_DIR
        }, { runner: mockRunner });

        assert.strictEqual(result.ytDlpPath, path.resolve(dummyYt));
        assert.strictEqual(result.ffmpegPath, path.resolve(dummyFfmpeg));
        assert.strictEqual(result.tempDir, path.resolve(TEST_DIR));
        assert.strictEqual(probed.length, 2);
    } finally {
        removeTestDir();
    }
});

test("validateProductionPreflight: Rejects failing or timing out FFmpeg probe in production", async () => {
    ensureCleanTestDir();
    const dummyYt = path.join(TEST_DIR, "ytdlp.exe");
    const dummyFfmpeg = path.join(TEST_DIR, "ffmpeg.exe");
    fs.writeFileSync(dummyYt, "mock yt");
    fs.writeFileSync(dummyFfmpeg, "mock ffmpeg");

    const failingRunner = async (cmd) => {
        if (cmd === path.resolve(dummyYt)) {
            return { stdout: "2026.01.01", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "Unrecognized option -version", exitCode: 1 };
    };

    try {
        await assert.rejects(
            () => validateProductionPreflight({
                NODE_ENV: "production",
                YT_DLP_PATH: dummyYt,
                FFMPEG_PATH: dummyFfmpeg,
                REEVA_TEMP_DIR: TEST_DIR
            }, { runner: failingRunner }),
            (err) => err instanceof ConfigError && err.message.includes("FFMPEG_PATH version probe failed with exit code 1")
        );
    } finally {
        removeTestDir();
    }
});

test("validateProductionPreflight: Non-production development does not require YT_DLP_PATH", async () => {
    ensureCleanTestDir();

    const result = await validateProductionPreflight({
        NODE_ENV: "development",
        REEVA_TEMP_DIR: TEST_DIR
    });

    assert.strictEqual(result.ytDlpPath, null);
    assert.strictEqual(result.ffmpegPath, null);
    assert.strictEqual(result.tempDir, path.resolve(TEST_DIR));

    removeTestDir();
});

test("startServer: Blocks listen and throws if production preflight fails", async () => {
    ensureCleanTestDir();
    const origNodeEnv = process.env.NODE_ENV;
    const origYtDlp = process.env.YT_DLP_PATH;
    process.env.NODE_ENV = "production";
    delete process.env.YT_DLP_PATH;

    app.resetShutdownState();

    try {
        await assert.rejects(
            () => app.startServer(0),
            (err) => err instanceof ConfigError && err.message.includes("Missing required production binary configuration: YT_DLP_PATH")
        );
        assert.strictEqual(app.getIsPreflightComplete(), false);
    } finally {
        if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
        else delete process.env.NODE_ENV;

        if (origYtDlp !== undefined) process.env.YT_DLP_PATH = origYtDlp;
        else delete process.env.YT_DLP_PATH;

        app.resetShutdownState();
        removeTestDir();
    }
});

test.after(() => {
    removeTestDir();
    setTimeout(() => process.exit(0), 200).unref();
});
