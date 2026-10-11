// tests/tiktok-extraction.test.cjs — Deterministic and Isolated Tests for TikTok Extraction Adapter
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const crypto = require("crypto");

const {
    extractTikTok,
    parseTikTokMetadata,
    mapTikTokYtDlpError,
    resolveTikTokShortUrl
} = require("../lib/extraction/adapters/tiktok.cjs");
const { validateExtractionResult } = require("../lib/extraction/result-validator.cjs");
const { validatePlatform, validateSourceUrl, validateGenericSourceUrl, ValidationError } = require("../lib/url-validator.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../lib/extraction/types.cjs");
const { REEVA_TEMP_DIR } = require("../lib/extraction/adapters/youtube.cjs");
const { MediaRegistry, defaultRegistry } = require("../lib/media-registry.cjs");
const app = require("../server.cjs");

// ==============================================================================
// 1. SOURCE URL VALIDATION & REDIRECT RESOLUTION
// ==============================================================================

test("TikTok Validation: Accepts valid TikTok video URLs", () => {
    const validUrls = [
        "https://www.tiktok.com/@username/video/7106594312292453678",
        "https://tiktok.com/@user.name/video/1234567890123456789",
        "https://m.tiktok.com/v/7106594312292453678.html",
        "https://vm.tiktok.com/ZM8ABC123/",
        "https://vt.tiktok.com/ZS8XYZ456/"
    ];

    for (const u of validUrls) {
        const validated = validateSourceUrl(u, "tiktok");
        assert.ok(validated.startsWith("https://"));
    }
});

test("TikTok Validation: Rejects invalid or untrusted source domains", () => {
    const invalidUrls = [
        "https://evil-tiktok.com/@user/video/123",
        "https://tiktok.com.attacker.com/@user/video/123",
        "http://www.tiktok.com/@user/video/123", // Insecure HTTP
        "https://user:pass@www.tiktok.com/@user/video/123", // Credentials
        "https://www.tiktok.com:8080/@user/video/123", // Non-standard port
        "https://instagram.com/reel/12345"
    ];

    for (const u of invalidUrls) {
        assert.throws(() => validateSourceUrl(u, "tiktok"), ValidationError);
    }
});

test("TikTok Validation: Generic validator directs TikTok links to specialized downloader", async () => {
    await assert.rejects(
        () => validateGenericSourceUrl("https://www.tiktok.com/@user/video/123456789"),
        (err) => err instanceof ValidationError && err.code === "USE_SPECIALIZED_PLATFORM" && err.message.includes("TikTok")
    );

    await assert.rejects(
        () => validateGenericSourceUrl("https://vm.tiktok.com/ZM8ABC123/"),
        (err) => err instanceof ValidationError && err.code === "USE_SPECIALIZED_PLATFORM" && err.message.includes("TikTok")
    );
});

test("TikTok Redirects: Resolves short link under domain boundaries", async () => {
    const mockFetch = async (url, opts) => {
        assert.ok(opts.allowedDomains.includes("tiktok.com"));
        return {
            finalUrl: "https://www.tiktok.com/@user/video/7106594312292453678",
            clearTimeout: () => {}
        };
    };

    const resolved = await resolveTikTokShortUrl("https://vm.tiktok.com/ZM8ABC123/", { fetchFn: mockFetch });
    assert.equal(resolved, "https://www.tiktok.com/@user/video/7106594312292453678");
});

// ==============================================================================
// 2. METADATA PARSING & ERROR MAPPING
// ==============================================================================

test("TikTok Parsing: Parses yt-dlp metadata JSON cleanly", () => {
    const sampleStdout = JSON.stringify({
        id: "7106594312292453678",
        title: "Funny dance challenge",
        fulltitle: "Funny dance challenge #dance",
        formats: [{ url: "https://v16-webapp-prime.tiktokcdn.com/video.mp4" }]
    });

    const parsed = parseTikTokMetadata(sampleStdout);
    assert.equal(parsed.id, "7106594312292453678");
    assert.equal(parsed.title, "Funny dance challenge");
});

test("TikTok Parsing: Rejects playlists and collections", () => {
    const playlistStdout = JSON.stringify({
        _type: "playlist",
        id: "user_collection_123"
    });

    assert.throws(
        () => parseTikTokMetadata(playlistStdout),
        (err) => err instanceof ExtractionError && err.code === EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA
    );
});

test("TikTok Error Mapping: Normalizes bot challenge, timeout, and private video", () => {
    const botErr = mapTikTokYtDlpError(new Error("Sign in to confirm you're not a bot"));
    assert.equal(botErr.code, EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE);

    const privErr = mapTikTokYtDlpError(new Error("This video is private"));
    assert.equal(privErr.code, EXTRACTION_ERROR_CODES.PRIVATE_CONTENT);

    const timeoutErr = mapTikTokYtDlpError(new Error("Connection timed out"));
    assert.equal(timeoutErr.code, EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT);
});

// ==============================================================================
// 3. DETERMINISTIC EXTRACTION ADAPTER EXECUTION (MOCKED RUNNER)
// ==============================================================================

test("TikTok Adapter: Subprocess isolation flags, explicit FFmpeg merging policy, and string arguments", async () => {
    if (!fs.existsSync(REEVA_TEMP_DIR)) fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });

    // Subtest A: With explicit FFmpeg path configured
    const capturedArgsWithFfmpeg = [];
    const mockRunnerA = async ({ command, args }) => {
        capturedArgsWithFfmpeg.push([...args]);
        const oIndex = args.indexOf("-o");
        if (oIndex !== -1 && args[oIndex + 1]) {
            fs.writeFileSync(args[oIndex + 1], Buffer.alloc(1024 * 1024));
        }
        return {
            exitCode: 0,
            stdout: JSON.stringify({
                id: "7106594312292453678",
                title: "TikTok Test Video"
            }),
            stderr: ""
        };
    };

    const dummyFfmpeg = path.join(REEVA_TEMP_DIR, "mock_ffmpeg.exe");
    const resA = await extractTikTok("https://www.tiktok.com/@user/video/7106594312292453678", {
        runner: mockRunnerA,
        ffmpegPath: dummyFfmpeg
    });

    try {
        assert.equal(capturedArgsWithFfmpeg.length, 2);
        const requiredFlags = ["--ignore-config", "--no-cache-dir", "--no-cookies", "--no-call-home", "--no-playlist"];
        for (const argsList of capturedArgsWithFfmpeg) {
            // Task requirement: Every argument passed to runner must be a string (never Promise, object, or undefined)
            for (const arg of argsList) {
                assert.equal(typeof arg, "string", `Subprocess argument must be a string, got ${typeof arg} (${arg})`);
            }

            for (const flag of requiredFlags) {
                assert.ok(argsList.includes(flag), `Arguments must include isolation flag '${flag}'`);
            }
            assert.equal(
                argsList.includes("--no-check-certificates"),
                false,
                "Insecure flag '--no-check-certificates' must NOT be passed to yt-dlp"
            );
        }

        // Check download args (invocation 2)
        const dlArgsA = capturedArgsWithFfmpeg[1];
        const ffmpegIndex = dlArgsA.indexOf("--ffmpeg-location");
        assert.notEqual(ffmpegIndex, -1, "Download args must include --ffmpeg-location when FFmpeg is configured");
        assert.equal(dlArgsA[ffmpegIndex + 1], path.resolve(dummyFfmpeg));
        assert.ok(dlArgsA.includes("--merge-output-format"));
        assert.equal(dlArgsA[dlArgsA.indexOf("-f") + 1], "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best");
    } finally {
        if (resA.localFilePath && fs.existsSync(resA.localFilePath)) {
            try { fs.unlinkSync(resA.localFilePath); } catch (_) {}
        }
    }

    // Subtest B: Without FFmpeg configured (control environment variable)
    const originalFfmpegEnv = process.env.FFMPEG_PATH;
    delete process.env.FFMPEG_PATH;

    const capturedArgsNoFfmpeg = [];
    const mockRunnerB = async ({ command, args }) => {
        capturedArgsNoFfmpeg.push([...args]);
        const oIndex = args.indexOf("-o");
        if (oIndex !== -1 && args[oIndex + 1]) {
            fs.writeFileSync(args[oIndex + 1], Buffer.alloc(1024 * 1024));
        }
        return {
            exitCode: 0,
            stdout: JSON.stringify({
                id: "7106594312292453678",
                title: "TikTok Test Video"
            }),
            stderr: ""
        };
    };

    try {
        const resB = await extractTikTok("https://www.tiktok.com/@user/video/7106594312292453678", {
            runner: mockRunnerB,
            ffmpegPath: null
        });

        try {
            assert.equal(capturedArgsNoFfmpeg.length, 2);
            for (const argsList of capturedArgsNoFfmpeg) {
                for (const arg of argsList) {
                    assert.equal(typeof arg, "string", `Subprocess argument must be a string, got ${typeof arg} (${arg})`);
                }
                for (const flag of ["--ignore-config", "--no-cache-dir", "--no-cookies", "--no-call-home", "--no-playlist"]) {
                    assert.ok(argsList.includes(flag), `Arguments must include isolation flag '${flag}'`);
                }
                assert.equal(argsList.includes("--no-check-certificates"), false);
            }

            // Check download args (invocation 2)
            const dlArgsB = capturedArgsNoFfmpeg[1];
            assert.equal(dlArgsB.includes("--ffmpeg-location"), false, "Must NOT pass --ffmpeg-location when not configured");
            assert.equal(dlArgsB.includes("--merge-output-format"), false, "Must NOT pass --merge-output-format when not merging");
            assert.equal(
                dlArgsB[dlArgsB.indexOf("-f") + 1],
                "b[ext=mp4]/best[ext=mp4]",
                "Must select single-file progressive MP4 format that does not require merging"
            );
        } finally {
            if (resB.localFilePath && fs.existsSync(resB.localFilePath)) {
                try { fs.unlinkSync(resB.localFilePath); } catch (_) {}
            }
        }
    } finally {
        if (originalFfmpegEnv !== undefined) {
            process.env.FFMPEG_PATH = originalFfmpegEnv;
        }
    }
});

test("TikTok Egress Proxy: Explicit REEVA_EGRESS_PROXY_URL is passed as exact URL string", async () => {
    const origProxyUrl = process.env.REEVA_EGRESS_PROXY_URL;
    process.env.REEVA_EGRESS_PROXY_URL = "http://127.0.0.1:8999";

    const capturedArgs = [];
    const mockRunner = async ({ args }) => {
        capturedArgs.push([...args]);
        const oIndex = args.indexOf("-o");
        if (oIndex !== -1 && args[oIndex + 1]) {
            fs.writeFileSync(args[oIndex + 1], Buffer.alloc(1024));
        }
        return {
            exitCode: 0,
            stdout: JSON.stringify({ id: "tt_test", title: "Proxy Test" }),
            stderr: ""
        };
    };

    try {
        const res = await extractTikTok("https://www.tiktok.com/@user/video/7106594312292453678", {
            runner: mockRunner
        });

        assert.equal(capturedArgs.length, 2);
        for (const argsList of capturedArgs) {
            for (const arg of argsList) {
                assert.equal(typeof arg, "string", `Argument must be string: ${arg}`);
            }
            const proxyIdx = argsList.indexOf("--proxy");
            assert.notEqual(proxyIdx, -1, "Must contain --proxy flag");
            assert.equal(argsList[proxyIdx + 1], "http://127.0.0.1:8999/");
        }

        if (res.localFilePath && fs.existsSync(res.localFilePath)) {
            try { fs.unlinkSync(res.localFilePath); } catch (_) {}
        }
    } finally {
        if (origProxyUrl !== undefined) {
            process.env.REEVA_EGRESS_PROXY_URL = origProxyUrl;
        } else {
            delete process.env.REEVA_EGRESS_PROXY_URL;
        }
    }
});

test("TikTok Egress Proxy: Awaits local loopback proxy resolution when explicit proxy is absent", async () => {
    const origProxyUrl = process.env.REEVA_EGRESS_PROXY_URL;
    const origDisable = process.env.REEVA_DISABLE_EGRESS_PROXY;
    delete process.env.REEVA_EGRESS_PROXY_URL;
    delete process.env.REEVA_DISABLE_EGRESS_PROXY;

    const capturedArgs = [];
    const mockRunner = async ({ args }) => {
        capturedArgs.push([...args]);
        const oIndex = args.indexOf("-o");
        if (oIndex !== -1 && args[oIndex + 1]) {
            fs.writeFileSync(args[oIndex + 1], Buffer.alloc(1024));
        }
        return {
            exitCode: 0,
            stdout: JSON.stringify({ id: "tt_test", title: "Awaited Proxy Test" }),
            stderr: ""
        };
    };

    try {
        const res = await extractTikTok("https://www.tiktok.com/@user/video/7106594312292453678", {
            runner: mockRunner
        });

        assert.equal(capturedArgs.length, 2);
        for (const argsList of capturedArgs) {
            for (const arg of argsList) {
                assert.equal(typeof arg, "string", `Subprocess argument must be string, not Promise: ${arg}`);
            }
            const proxyIdx = argsList.indexOf("--proxy");
            assert.notEqual(proxyIdx, -1, "Must contain --proxy flag when egress proxy is enabled");
            const proxyValue = argsList[proxyIdx + 1];
            assert.equal(typeof proxyValue, "string");
            assert.ok(proxyValue.startsWith("http://127.0.0.1:"), `Proxy must be bound to loopback: ${proxyValue}`);
        }

        if (res.localFilePath && fs.existsSync(res.localFilePath)) {
            try { fs.unlinkSync(res.localFilePath); } catch (_) {}
        }
    } finally {
        if (origProxyUrl !== undefined) process.env.REEVA_EGRESS_PROXY_URL = origProxyUrl;
        if (origDisable !== undefined) process.env.REEVA_DISABLE_EGRESS_PROXY = origDisable;
    }
});

test("TikTok Egress Proxy: Rejects disabling egress proxy in production environment", async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origDisable = process.env.REEVA_DISABLE_EGRESS_PROXY;

    process.env.NODE_ENV = "production";
    process.env.REEVA_DISABLE_EGRESS_PROXY = "true";

    try {
        await assert.rejects(
            () => extractTikTok("https://www.tiktok.com/@user/video/7106594312292453678", {
                runner: async () => ({ exitCode: 0, stdout: "{}", stderr: "" })
            }),
            (err) => err instanceof ExtractionError && err.message.includes("cannot be disabled in production")
        );
    } finally {
        process.env.NODE_ENV = origNodeEnv;
        if (origDisable !== undefined) {
            process.env.REEVA_DISABLE_EGRESS_PROXY = origDisable;
        } else {
            delete process.env.REEVA_DISABLE_EGRESS_PROXY;
        }
    }
});

test("TikTok Egress Proxy: Malformed REEVA_EGRESS_PROXY_URL is rejected", async () => {
    const origProxyUrl = process.env.REEVA_EGRESS_PROXY_URL;
    process.env.REEVA_EGRESS_PROXY_URL = "not-a-valid-proxy-url";

    try {
        await assert.rejects(
            () => extractTikTok("https://www.tiktok.com/@user/video/7106594312292453678", {
                runner: async () => ({ exitCode: 0, stdout: "{}", stderr: "" })
            }),
            (err) => err instanceof ExtractionError && err.message.includes("REEVA_EGRESS_PROXY_URL is malformed")
        );
    } finally {
        if (origProxyUrl !== undefined) {
            process.env.REEVA_EGRESS_PROXY_URL = origProxyUrl;
        } else {
            delete process.env.REEVA_EGRESS_PROXY_URL;
        }
    }
});

test("TikTok Adapter: Cleans up partial files on runner failure", async () => {
    if (!fs.existsSync(REEVA_TEMP_DIR)) fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });

    let writtenPath = null;
    const mockFailingRunner = async ({ args }) => {
        const oIndex = args.indexOf("-o");
        if (oIndex !== -1 && args[oIndex + 1]) {
            writtenPath = args[oIndex + 1];
            fs.writeFileSync(writtenPath, Buffer.from("partial"));
            return {
                exitCode: 1,
                stdout: "",
                stderr: "ERROR: Download connection reset by peer"
            };
        }
        // Metadata simulation phase succeeds
        return {
            exitCode: 0,
            stdout: JSON.stringify({ id: "123", title: "Test" }),
            stderr: ""
        };
    };

    await assert.rejects(
        () => extractTikTok("https://www.tiktok.com/@user/video/123", { runner: mockFailingRunner }),
        (err) => err instanceof ExtractionError
    );

    assert.ok(writtenPath, "File path must have been assigned");
    assert.equal(fs.existsSync(writtenPath), false, "Partial file must be cleaned up on failure");
});

test("TikTok Result Validation: Rejects 0-byte output and paths outside REEVA_TEMP_DIR", async () => {
    if (!fs.existsSync(REEVA_TEMP_DIR)) fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });

    const emptyFile = path.join(REEVA_TEMP_DIR, `empty_tt_${Date.now()}.mp4`);
    fs.writeFileSync(emptyFile, Buffer.alloc(0));

    try {
        await assert.rejects(
            () => validateExtractionResult({
                url: `file://${emptyFile}`,
                localFilePath: emptyFile,
                type: "video"
            }, "tiktok"),
            (err) => err instanceof ExtractionError && err.message.includes("empty")
        );
    } finally {
        try { fs.unlinkSync(emptyFile); } catch (_) {}
    }

    const outsideFile = path.resolve(os.tmpdir(), "outside_tt.mp4");
    fs.writeFileSync(outsideFile, Buffer.alloc(100));

    try {
        await assert.rejects(
            () => validateExtractionResult({
                url: `file://${outsideFile}`,
                localFilePath: outsideFile,
                type: "video"
            }, "tiktok"),
            (err) => err instanceof ExtractionError && err.message.includes("outside permitted temporary directory")
        );
    } finally {
        try { fs.unlinkSync(outsideFile); } catch (_) {}
    }
});

// ==============================================================================
// 4. FULL HTTP PIPELINE INTEGRATION TEST
// ==============================================================================

test("TikTok HTTP Endpoint: Streams local file artifact cleanly with headers and lifecycle cleanup", async () => {
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    // Create a valid mock artifact in REEVA_TEMP_DIR
    const tempFile = path.join(REEVA_TEMP_DIR, `reeva_tt_http_${Date.now()}.mp4`);
    fs.writeFileSync(tempFile, Buffer.from("TIKTOK_VIDEO_STREAM_BYTES"));

    try {
        // Register in defaultRegistry as tiktok platform with localFilePath
        const registered = defaultRegistry.registerMedia({
            upstreamUrl: `file://${tempFile}`,
            platform: "tiktok",
            type: "video",
            title: "TikTok Dance Clip",
            localFilePath: tempFile
        });

        // Request stream through HTTP endpoint
        const dlRes = await new Promise((resolve, reject) => {
            const req = http.get({
                host: "127.0.0.1",
                port,
                path: `/api/media/${registered.id}?download=1`
            }, (res) => {
                const chunks = [];
                res.on("data", c => chunks.push(c));
                res.on("end", () => {
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: Buffer.concat(chunks)
                    });
                });
            });
            req.on("error", reject);
        });

        assert.equal(dlRes.statusCode, 200);
        assert.equal(dlRes.headers["content-type"], "video/mp4");
        assert.equal(dlRes.headers["content-disposition"], 'attachment; filename="reeva_tiktok.mp4"');
        assert.equal(dlRes.body.toString("utf8"), "TIKTOK_VIDEO_STREAM_BYTES");

        // Verify active-lease protection and deletion
        assert.equal(fs.existsSync(tempFile), true);
        defaultRegistry.deleteMedia(registered.id);
        // Give 50ms for Windows file handle release
        await new Promise(r => setTimeout(r, 60));
        assert.equal(fs.existsSync(tempFile), false);

    } finally {
        if (fs.existsSync(tempFile)) {
            try { fs.unlinkSync(tempFile); } catch (_) {}
        }
        server.close();
    }
});
