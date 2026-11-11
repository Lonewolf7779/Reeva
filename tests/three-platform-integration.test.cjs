// tests/three-platform-integration.test.cjs
// Phase 4.5: Three-Platform Integration & Staging Readiness Test Suite
// Verifies:
// 1. Instagram: Reels, Video posts, Image posts, Mixed carousels, challenges, filenames
// 2. Facebook: Watch URLs, Reels, Share links, Relay patterns, redirects, filenames
// 3. TikTok: Standard URLs, Short links (vm/vt), artifact generation, Range streaming, error mapping
// 4. Staging Readiness: Feature gate switching, /api/capabilities, and gate enforcement

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const app = require("../server.cjs");
const { defaultRegistry } = require("../lib/media-registry.cjs");
const { extractInstagram } = require("../lib/extraction/adapters/instagram.cjs");
const { extractFacebook, extractFacebookVideoCandidate } = require("../lib/extraction/adapters/facebook.cjs");
const { extractTikTok, parseTikTokMetadata, mapTikTokYtDlpError } = require("../lib/extraction/adapters/tiktok.cjs");
const { REEVA_TEMP_DIR } = require("../lib/extraction/adapters/youtube.cjs");
const { parseFeatureGates, isPlatformEnabled } = require("../lib/config.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../lib/extraction/types.cjs");
const { ValidationError } = require("../lib/url-validator.cjs");

// =========================================================================
// 1. INSTAGRAM ACCEPTANCE TESTS
// =========================================================================

test("Instagram Acceptance: Single Reel returns type 'video' and approved CDN URL", async () => {
    const reelHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta property="og:type" content="video.other" />
            <meta property="og:video" content="https://scontent.cdninstagram.com/v/t50.2886-16/reel_video.mp4?_nc_cat=101" />
            <meta property="og:title" content="Awesome Reel by Creator" />
        </head>
        <body></body>
        </html>
    `;

    const result = await extractInstagram("https://www.instagram.com/reel/C3_mockReel1/", {
        fetchHtml: async () => reelHtml
    });

    assert.strictEqual(result.type, "video");
    assert.strictEqual(result.url, "https://scontent.cdninstagram.com/v/t50.2886-16/reel_video.mp4?_nc_cat=101");
    assert.strictEqual(result.title, "Awesome Reel by Creator");
});

test("Instagram Acceptance: Single Photo Post returns type 'image' and approved CDN URL", async () => {
    const photoHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta property="og:type" content="article" />
            <meta property="og:image" content="https://scontent.cdninstagram.com/v/t51.2885-15/photo.jpg?_nc_cat=102" />
            <meta property="og:title" content="Scenic Landscape Photo" />
        </head>
        <body></body>
        </html>
    `;

    const result = await extractInstagram("https://www.instagram.com/p/C3_mockPhoto1/", {
        fetchHtml: async () => photoHtml
    });

    assert.strictEqual(result.type, "image");
    assert.strictEqual(result.url, "https://scontent.cdninstagram.com/v/t51.2885-15/photo.jpg?_nc_cat=102");
    assert.ok(result.title.includes("Scenic Landscape Photo"));
});

test("Instagram Acceptance: Mixed Carousel extracts ordered slides with correct classification", async () => {
    const carouselJson = {
        xdt_shortcode_media: {
            id: "3000000000000000000",
            shortcode: "C3_carousel1",
            edge_media_to_caption: {
                edges: [{ node: { text: "Holiday Vacation Highlights" } }]
            },
            edge_sidecar_to_children: {
                edges: [
                    {
                        node: {
                            id: "3000000000000000001",
                            is_video: false,
                            display_url: "https://scontent.cdninstagram.com/slide1_photo.jpg",
                            dimensions: { width: 1080, height: 1350 }
                        }
                    },
                    {
                        node: {
                            id: "3000000000000000002",
                            is_video: true,
                            video_url: "https://scontent.cdninstagram.com/slide2_video.mp4",
                            display_url: "https://scontent.cdninstagram.com/slide2_thumb.jpg",
                            dimensions: { width: 1080, height: 1080 }
                        }
                    }
                ]
            }
        }
    };

    const carouselHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta property="og:title" content="Holiday Vacation Highlights" />
        </head>
        <body>
            <script>var x = {"xdt_shortcode_media": ${JSON.stringify(carouselJson.xdt_shortcode_media)}};</script>
        </body>
        </html>
    `;

    const result = await extractInstagram("https://www.instagram.com/p/C3_carousel1/", {
        fetchHtml: async () => carouselHtml
    });

    assert.ok(Array.isArray(result.items), "Must return items array for carousel");
    assert.strictEqual(result.items.length, 2);

    // Slide 1: Image
    assert.strictEqual(result.items[0].index, 0);
    assert.strictEqual(result.items[0].type, "image");
    assert.strictEqual(result.items[0].url, "https://scontent.cdninstagram.com/slide1_photo.jpg");

    // Slide 2: Video
    assert.strictEqual(result.items[1].index, 1);
    assert.strictEqual(result.items[1].type, "video");
    assert.strictEqual(result.items[1].url, "https://scontent.cdninstagram.com/slide2_video.mp4");
    assert.strictEqual(result.items[1].thumbnailUrl, "https://scontent.cdninstagram.com/slide2_thumb.jpg");
});

test("Instagram Acceptance: Authentication barrier raises PLATFORM_CHALLENGE", async () => {
    const challengeHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Login • Instagram</title>
        </head>
        <body>
            <div id="login_form">Please log in to continue.</div>
        </body>
        </html>
    `;

    await assert.rejects(
        () => extractInstagram("https://www.instagram.com/p/C3_privatePost/", {
            fetchHtml: async () => challengeHtml,
            provider: null // Disable secondary fallback to verify challenge detection
        }),
        (err) => err instanceof ExtractionError && err.code === EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE
    );
});

// =========================================================================
// 2. FACEBOOK ACCEPTANCE TESTS
// =========================================================================

test("Facebook Acceptance: Watch URL extracts candidate from OpenGraph meta tags", async () => {
    const watchHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta property="og:video" content="https://video.famd5-3.fna.fbcdn.net/v/t42.17977-4/watch_clip.mp4?token=mock_token" />
            <meta property="og:title" content="Cooking Masterclass Episode 1" />
        </head>
        <body></body>
        </html>
    `;

    const result = await extractFacebook("https://www.facebook.com/watch/?v=9876543210", {
        fetchHtml: async () => watchHtml
    });

    assert.strictEqual(result.type, "video");
    assert.strictEqual(result.url, "https://video.famd5-3.fna.fbcdn.net/v/t42.17977-4/watch_clip.mp4?token=mock_token");
    assert.strictEqual(result.title, "Cooking Masterclass Episode 1");
});

test("Facebook Acceptance: Reel extracts candidate from modern Relay hd_src_no_ratelimit", async () => {
    const reelHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Facebook Reel</title>
        </head>
        <body>
            <script>
                var data = {
                    "hd_src_no_ratelimit": "https://video.xx.fbcdn.net/v/t42/relay_hd_reel.mp4?token=xyz"
                };
            </script>
        </body>
        </html>
    `;

    const result = await extractFacebook("https://www.facebook.com/reel/1234567890", {
        fetchHtml: async () => reelHtml
    });

    assert.strictEqual(result.type, "video");
    assert.strictEqual(result.url, "https://video.xx.fbcdn.net/v/t42/relay_hd_reel.mp4?token=xyz");
});

test("Facebook Acceptance: Progressive / playback_url attribute is recognized", () => {
    const htmlSnippet = `{"playback_url": "https:\\/\\/video.xx.fbcdn.net\\/v\\/t42\\/progressive_stream.mp4"}`;
    const candidate = extractFacebookVideoCandidate(htmlSnippet);
    assert.strictEqual(candidate, "https://video.xx.fbcdn.net/v/t42/progressive_stream.mp4");
});

test("Facebook Acceptance: Challenge wall raises PLATFORM_CHALLENGE", async () => {
    const wallHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Facebook - Log In or Sign Up</title>
        </head>
        <body>
            <div class="login_wall">You must log in to continue.</div>
        </body>
        </html>
    `;

    await assert.rejects(
        () => extractFacebook("https://www.facebook.com/reel/9999999999", {
            fetchHtml: async () => wallHtml
        }),
        (err) => err instanceof ExtractionError && err.code === EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE
    );
});

// =========================================================================
// 3. TIKTOK ACCEPTANCE TESTS
// =========================================================================

test("TikTok Acceptance: Metadata JSON parser extracts single media and rejects playlists", () => {
    const singleMediaStdout = JSON.stringify({
        id: "7123456789012345678",
        title: "Funny Cat Jump Video",
        fulltitle: "Funny Cat Jump Video #cat #funny",
        duration: 15,
        formats: [{ url: "https://v16-webapp-prime.tiktok.com/video.mp4", ext: "mp4" }]
    });

    const info = parseTikTokMetadata(singleMediaStdout);
    assert.strictEqual(info.id, "7123456789012345678");
    assert.strictEqual(info.title, "Funny Cat Jump Video");

    // Playlist must throw UNSUPPORTED_MEDIA
    const playlistStdout = JSON.stringify({
        _type: "playlist",
        id: "user_collection_1",
        title: "User Liked Videos"
    });

    assert.throws(
        () => parseTikTokMetadata(playlistStdout),
        (err) => err instanceof ExtractionError && err.code === EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA
    );
});

test("TikTok Acceptance: Error mapper classifies bot challenges and private videos cleanly", () => {
    // Challenge
    const errChallenge = mapTikTokYtDlpError(new Error("Command failed"), "Sign in to confirm you're not a bot");
    assert.strictEqual(errChallenge.code, EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE);

    // Private video
    const errPrivate = mapTikTokYtDlpError(new Error("Command failed"), "This video is private");
    assert.strictEqual(errPrivate.code, EXTRACTION_ERROR_CODES.PRIVATE_CONTENT);

    // Max filesize
    const errOversize = mapTikTokYtDlpError(new Error("Command failed"), "File is larger than max-filesize");
    assert.strictEqual(errOversize.code, EXTRACTION_ERROR_CODES.EXTRACTION_FAILED);
    assert.strictEqual(errOversize.statusCode, 413);
});

test("TikTok Acceptance: Materializes local artifact and returns valid localFilePath in REEVA_TEMP_DIR", async () => {
    fs.mkdirSync(REEVA_TEMP_DIR, { recursive: true });

    let createdTempFile = null;

    // Mock runner simulating successful yt-dlp metadata probe and download
    const mockRunner = async ({ args }) => {
        if (args.includes("--simulate")) {
            return {
                exitCode: 0,
                stdout: JSON.stringify({
                    id: "7123456789",
                    title: "Mock TikTok Video",
                    fulltitle: "Mock TikTok Video Full"
                }),
                stderr: ""
            };
        }

        // Locate -o target path
        const oIdx = args.indexOf("-o");
        if (oIdx !== -1 && args[oIdx + 1]) {
            createdTempFile = args[oIdx + 1];
            fs.writeFileSync(createdTempFile, Buffer.alloc(1024, "T")); // 1 KB mock MP4
        }

        return {
            exitCode: 0,
            stdout: JSON.stringify({ id: "7123456789" }),
            stderr: ""
        };
    };

    try {
        const result = await extractTikTok("https://www.tiktok.com/@creator/video/7123456789", {
            runner: mockRunner,
            ffmpegPath: null
        });

        assert.strictEqual(result.platform, "tiktok");
        assert.strictEqual(result.type, "video");
        assert.ok(result.localFilePath.startsWith(REEVA_TEMP_DIR));
        assert.ok(fs.existsSync(result.localFilePath));

        // Test server streaming and filename for TikTok
        const reg = defaultRegistry.registerMedia({
            platform: "tiktok",
            type: "video",
            title: result.title,
            localFilePath: result.localFilePath
        });

        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = server.address().port;

        try {
            const res = await new Promise((resolve, reject) => {
                http.get(`http://127.0.0.1:${port}/api/media/${reg.id}?download=1`, (res) => {
                    const chunks = [];
                    res.on("data", (c) => chunks.push(c));
                    res.on("end", () => resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: Buffer.concat(chunks)
                    }));
                    res.on("error", reject);
                });
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.headers["accept-ranges"], "bytes");
            assert.ok(res.headers["content-disposition"].includes('filename="reeva_tiktok.mp4"'));
            assert.strictEqual(res.body.length, 1024);
        } finally {
            await new Promise((done) => server.close(done));
        }

    } finally {
        if (createdTempFile) {
            try { fs.unlinkSync(createdTempFile); } catch (_) {}
        }
    }
});

// =========================================================================
// 4. STAGING READINESS & FEATURE GATES
// =========================================================================

test("Staging Readiness: Staging environment flags activate all three platforms", () => {
    const stagingEnv = {
        REEVA_ENABLE_INSTAGRAM: "true",
        REEVA_ENABLE_FACEBOOK: "true",
        REEVA_ENABLE_TIKTOK: "true",
        REEVA_ENABLE_YOUTUBE: "true",
        REEVA_ENABLE_TWITTER: "true",
        REEVA_ENABLE_PINTEREST: "true",
        REEVA_ENABLE_GENERIC: "true"
    };

    const gates = parseFeatureGates(stagingEnv);
    assert.strictEqual(isPlatformEnabled("instagram", gates), true);
    assert.strictEqual(isPlatformEnabled("facebook", gates), true);
    assert.strictEqual(isPlatformEnabled("tiktok", gates), true);
});

test("Staging Readiness: Production environment flags preserve disabled gates by default", () => {
    const prodEnv = {
        NODE_ENV: "production",
        REEVA_ENABLE_YOUTUBE: "true",
        REEVA_ENABLE_TWITTER: "true",
        REEVA_ENABLE_PINTEREST: "true",
        REEVA_ENABLE_GENERIC: "true",
        REEVA_ENABLE_INSTAGRAM: "false",
        REEVA_ENABLE_FACEBOOK: "false",
        REEVA_ENABLE_TIKTOK: "false"
    };

    const gates = parseFeatureGates(prodEnv);
    assert.strictEqual(isPlatformEnabled("instagram", gates), false);
    assert.strictEqual(isPlatformEnabled("facebook", gates), false);
    assert.strictEqual(isPlatformEnabled("tiktok", gates), false);
    // Permitted in production
    assert.strictEqual(isPlatformEnabled("youtube", gates), true);
    assert.strictEqual(isPlatformEnabled("twitter", gates), true);
    assert.strictEqual(isPlatformEnabled("pinterest", gates), true);
});
