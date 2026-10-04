// tests/extraction.test.cjs — Deterministic Unit Tests for Reeva Extraction Architecture
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    createExtractionOrchestrator,
    validateExtractionResult,
    decodeUrl,
    extractFromMeta,
    extractMediaFromHtml,
    withTimeout,
    ExtractionError,
    EXTRACTION_ERROR_CODES
} = require("../lib/extraction/index.cjs");

const { extractInstagram } = require("../lib/extraction/adapters/instagram.cjs");
const { extractFacebook } = require("../lib/extraction/adapters/facebook.cjs");
const { extractTwitter, extractTweetId, calculateSyndicationToken } = require("../lib/extraction/adapters/twitter.cjs");
const { extractPinterest } = require("../lib/extraction/adapters/pinterest.cjs");
const { extractYouTube } = require("../lib/extraction/adapters/youtube.cjs");
const { ValidationError } = require("../lib/url-validator.cjs");
const { SecurityHTTPError } = require("../lib/http-client.cjs");
const { BoundedCache } = require("../lib/cache.cjs");

// ==================== CORE ORCHESTRATOR TESTS ====================

// Test 1: Valid normalized extraction result
test("Extraction Test 1: Valid normalized extraction result", async () => {
    const testCache = new BoundedCache(50, 60000);
    const orchestrator = createExtractionOrchestrator({
        cache: testCache,
        adapters: {
            instagram: async () => ({
                url: "https://scontent.cdninstagram.com/v/t50/valid_reel.mp4",
                type: "video",
                title: "Valid Instagram Reel"
            })
        }
    });

    const result = await orchestrator.extractMedia({
        platform: "instagram",
        sourceUrl: "https://www.instagram.com/reel/DA123456789/",
        requestId: "req_test_01"
    });

    assert.equal(result.success, true);
    assert.equal(result.media.url, "https://scontent.cdninstagram.com/v/t50/valid_reel.mp4");
    assert.equal(result.media.type, "video");
    assert.equal(result.media.platform, "instagram");
    assert.equal(result.media.title, "Valid Instagram Reel");
});

// Test 2: Malformed provider result
test("Extraction Test 2: Malformed provider result rejected", async () => {
    const orchestrator = createExtractionOrchestrator({
        cache: new BoundedCache(10, 60000),
        adapters: {
            instagram: async () => ({
                url: 12345, // invalid non-string URL
                type: "video"
            })
        }
    });

    await assert.rejects(
        () => orchestrator.extractMedia({
            platform: "instagram",
            sourceUrl: "https://www.instagram.com/p/DA123456789/",
            requestId: "req_test_02"
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND);
            return true;
        }
    );
});

// Test 3: Provider returns no media
test("Extraction Test 3: Provider returns no media", async () => {
    const orchestrator = createExtractionOrchestrator({
        cache: new BoundedCache(10, 60000),
        adapters: {
            facebook: async () => null // no media returned
        }
    });

    await assert.rejects(
        () => orchestrator.extractMedia({
            platform: "facebook",
            sourceUrl: "https://www.facebook.com/watch?v=1020304050",
            requestId: "req_test_03"
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND);
            return true;
        }
    );
});

// Test 4: Provider throws an ordinary error
test("Extraction Test 4: Provider throws an ordinary error normalized to EXTRACTION_FAILED", async () => {
    const orchestrator = createExtractionOrchestrator({
        cache: new BoundedCache(10, 60000),
        adapters: {
            twitter: async () => {
                throw new Error("Internal parser crash or scraping error");
            }
        }
    });

    await assert.rejects(
        () => orchestrator.extractMedia({
            platform: "twitter",
            sourceUrl: "https://twitter.com/user/status/1234567890123456789",
            requestId: "req_test_04"
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.EXTRACTION_FAILED);
            assert.equal(err.message, "Failed to extract media from the requested URL.");
            return true;
        }
    );
});

// Test 5: Provider returns an unsafe media URL (Rejected by Reeva security validation)
test("Extraction Test 5: Provider returns an unsafe media URL (SSRF target rejected)", async () => {
    const orchestrator = createExtractionOrchestrator({
        cache: new BoundedCache(10, 60000),
        adapters: {
            instagram: async () => ({
                url: "http://127.0.0.1:3000/internal-video.mp4",
                type: "video"
            })
        }
    });

    await assert.rejects(
        () => orchestrator.extractMedia({
            platform: "instagram",
            sourceUrl: "https://www.instagram.com/reel/DA123456789/",
            requestId: "req_test_05"
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.code, "UNSUPPORTED_PROTOCOL");
            return true;
        }
    );
});

// Test 6: Provider returns an unapproved CDN
test("Extraction Test 6: Provider returns an unapproved CDN (Expected rejection)", async () => {
    const orchestrator = createExtractionOrchestrator({
        cache: new BoundedCache(10, 60000),
        adapters: {
            youtube: async () => ({
                url: "https://malicious-unapproved-cdn.com/exploit.mp4",
                type: "video"
            })
        }
    });

    await assert.rejects(
        () => orchestrator.extractMedia({
            platform: "youtube",
            sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            requestId: "req_test_06"
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.code, "UNAPPROVED_MEDIA_DOMAIN");
            return true;
        }
    );
});

// Test 7: Both primary and fallback fail (Controlled MEDIA_NOT_FOUND)
test("Extraction Test 7: Primary provider fails and fallback also fails (controlled MEDIA_NOT_FOUND)", async () => {
    const failingAdapter = async () => {
        throw new ExtractionError(
            EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
            "Could not find downloadable media for this Instagram link."
        );
    };

    const orchestrator = createExtractionOrchestrator({
        cache: new BoundedCache(10, 60000),
        adapters: {
            instagram: failingAdapter
        }
    });

    await assert.rejects(
        () => orchestrator.extractMedia({
            platform: "instagram",
            sourceUrl: "https://www.instagram.com/reel/DA123456789/",
            requestId: "req_test_07"
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND);
            return true;
        }
    );
});

// ==================== PHASE 3.4 INSTAGRAM CRAWLER EXTRACTION & ADAPTER TESTS ====================

// --- INSTAGRAM ---
test("Instagram Integration: Primary crawler HTML extraction maps og:video and title", async () => {
    const mockFetchHtml = async () => `
        <!DOCTYPE html>
        <html>
            <head>
                <meta property="og:video" content="https://scontent.cdninstagram.com/v/t50/primary_reel.mp4" />
                <meta property="og:title" content="Awesome Public Reel" />
            </head>
        </html>
    `;

    const result = await extractInstagram("https://www.instagram.com/reel/DA123456789/", {
        fetchHtml: mockFetchHtml
    });

    assert.equal(result.url, "https://scontent.cdninstagram.com/v/t50/primary_reel.mp4");
    assert.equal(result.type, "video");
    assert.equal(result.title, "Awesome Public Reel");

    const validated = validateExtractionResult(result, "instagram");
    assert.equal(validated.url, "https://scontent.cdninstagram.com/v/t50/primary_reel.mp4");
});

test("Instagram Integration: Passes crawler User-Agent in headers to fetchHtml", async () => {
    let capturedOptions = null;
    const mockFetchHtml = async (url, domains, maxBytes, options) => {
        capturedOptions = options;
        return `<html><head><meta property="og:video" content="https://scontent.cdninstagram.com/v/t50/reel.mp4" /></head></html>`;
    };

    const result = await extractInstagram("https://www.instagram.com/reel/DA123456789/", {
        fetchHtml: mockFetchHtml
    });

    assert.ok(capturedOptions);
    assert.ok(capturedOptions.headers);
    assert.equal(
        capturedOptions.headers["User-Agent"],
        "facebookexternalhit/1.1 (+https://www.facebook.com/externalhit_uatext.php)"
    );
    assert.equal(result.url, "https://scontent.cdninstagram.com/v/t50/reel.mp4");
});

test("Instagram Integration: Extracts og:video:url correctly", async () => {
    const mockFetchHtml = async () => `
        <html><head><meta property="og:video:url" content="https://scontent.cdninstagram.com/v/t50/video_url_test.mp4" /></head></html>
    `;

    const result = await extractInstagram("https://www.instagram.com/reel/DA123456789/", {
        fetchHtml: mockFetchHtml
    });

    assert.equal(result.url, "https://scontent.cdninstagram.com/v/t50/video_url_test.mp4");
    assert.equal(result.type, "video");
});

test("Instagram Integration: Extracts og:video:secure_url correctly", async () => {
    const mockFetchHtml = async () => `
        <html><head><meta property="og:video:secure_url" content="https://scontent.cdninstagram.com/v/t50/secure_url_test.mp4" /></head></html>
    `;

    const result = await extractInstagram("https://www.instagram.com/reel/DA123456789/", {
        fetchHtml: mockFetchHtml
    });

    assert.equal(result.url, "https://scontent.cdninstagram.com/v/t50/secure_url_test.mp4");
    assert.equal(result.type, "video");
});

test("Instagram Integration: Extracts video with reversed attributes (content before property)", async () => {
    const mockFetchHtml = async () => `
        <html><head><meta content="https://scontent.cdninstagram.com/v/t50/reversed_attr.mp4" property="og:video" /></head></html>
    `;

    const result = await extractInstagram("https://www.instagram.com/reel/DA123456789/", {
        fetchHtml: mockFetchHtml
    });

    assert.equal(result.url, "https://scontent.cdninstagram.com/v/t50/reversed_attr.mp4");
    assert.equal(result.type, "video");
});

test("Instagram Integration: Video post with only og:image is NOT treated as video", async () => {
    const mockFetchHtml = async () => `
        <html>
            <head>
                <meta property="og:image" content="https://scontent.cdninstagram.com/preview_only.jpg" />
                <title>Some Reel Preview</title>
            </head>
        </html>
    `;

    await assert.rejects(
        () => extractInstagram("https://www.instagram.com/reel/DA123456789/", {
            fetchHtml: mockFetchHtml,
            provider: null
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND);
            return true;
        }
    );
});

test("Instagram Integration: Photo post without video returns og:image as image", async () => {
    const mockFetchHtml = async () => `
        <html>
            <head>
                <meta property="og:image" content="https://scontent.cdninstagram.com/photo.jpg" />
                <meta property="og:title" content="A Beautiful Photo" />
            </head>
        </html>
    `;

    const result = await extractInstagram("https://www.instagram.com/p/DA123456789/", {
        fetchHtml: mockFetchHtml,
        provider: null
    });

    assert.equal(result.url, "https://scontent.cdninstagram.com/photo.jpg");
    assert.equal(result.type, "image");
    assert.equal(result.title, "A Beautiful Photo");
});

test("Instagram Integration: Candidate URL from unapproved domain is rejected by validateMediaUrl", async () => {
    const mockFetchHtml = async () => `
        <html>
            <head>
                <meta property="og:video" content="https://evil-unapproved-domain.com/malicious.mp4" />
            </head>
        </html>
    `;

    await assert.rejects(
        () => extractInstagram("https://www.instagram.com/reel/DA123456789/", {
            fetchHtml: mockFetchHtml
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.code, "UNAPPROVED_MEDIA_DOMAIN");
            return true;
        }
    );
});

test("Instagram Integration: Login barrier shell classified as PLATFORM_CHALLENGE", async () => {
    const mockFetchHtml = async () => `
        <!DOCTYPE html>
        <html>
            <head><title>Login • Instagram</title></head>
            <body>
                <a href="/accounts/login/">Log In</a>
            </body>
        </html>
    `;

    await assert.rejects(
        () => extractInstagram("https://www.instagram.com/reel/DA123456789/", {
            fetchHtml: mockFetchHtml,
            provider: null
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE);
            assert.equal(err.statusCode, 403);
            return true;
        }
    );
});

test("Instagram Integration: Secondary provider maps media_details output when primary HTML yields no media", async () => {
    let calledWithUrl = null;

    const mockInstagramDirect = {
        instagramGetUrl: async (url) => {
            calledWithUrl = url;
            return {
                results_number: 1,
                post_info: { caption: "Awesome Reel #test" },
                media_details: [
                    {
                        type: "video",
                        url: "https://scontent.cdninstagram.com/v/t50/reel_from_media_details.mp4"
                    }
                ]
            };
        }
    };

    const result = await extractInstagram("https://www.instagram.com/reel/DA123456789/", {
        fetchHtml: async () => "<html></html>",
        provider: mockInstagramDirect
    });

    assert.equal(calledWithUrl, "https://www.instagram.com/reel/DA123456789/");
    assert.equal(result.url, "https://scontent.cdninstagram.com/v/t50/reel_from_media_details.mp4");
    assert.equal(result.type, "video");
    assert.equal(result.title, "Awesome Reel #test");

    const validated = validateExtractionResult(result, "instagram");
    assert.equal(validated.url, "https://scontent.cdninstagram.com/v/t50/reel_from_media_details.mp4");
});

test("Instagram Integration: Secondary provider maps url_list when media_details is empty", async () => {
    const mockInstagramDirect = {
        instagramGetUrl: async () => ({
            results_number: 1,
            url_list: ["https://scontent.cdninstagram.com/v/t50/reel_from_url_list.mp4"]
        })
    };

    const result = await extractInstagram("https://www.instagram.com/reel/DA123456789/", {
        fetchHtml: async () => "<html></html>",
        provider: mockInstagramDirect
    });

    assert.equal(result.url, "https://scontent.cdninstagram.com/v/t50/reel_from_url_list.mp4");
    assert.equal(result.type, "video");
});

test("Instagram Integration: Upstream HTTP 401/403 classified as PLATFORM_CHALLENGE", async () => {
    const { SecurityHTTPError } = require("../lib/http-client.cjs");
    const mockFetchHtml = async () => {
        throw new SecurityHTTPError("Failed to load page (401)", 401);
    };

    await assert.rejects(
        () => extractInstagram("https://www.instagram.com/reel/DA123456789/", {
            fetchHtml: mockFetchHtml,
            provider: null
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE);
            assert.equal(err.statusCode, 403);
            return true;
        }
    );
});

// --- TWITTER / X NATIVE SYNDICATION INTEGRATION TESTS ---

test("Twitter Integration: Tweet ID extracted correctly from twitter.com and x.com URLs", () => {
    assert.equal(extractTweetId("https://twitter.com/user/status/1234567890123456789"), "1234567890123456789");
    assert.equal(extractTweetId("https://x.com/NASA/status/1803506497839399197"), "1803506497839399197");
    assert.equal(extractTweetId("https://x.com/user/status/123456789/video/1"), "123456789");
    assert.equal(extractTweetId("https://twitter.com/i/web/status/9876543210"), "9876543210");
});

test("Twitter Integration: Invalid URL or non-status paths rejected by extractTweetId", () => {
    assert.equal(extractTweetId("https://twitter.com/user/123456"), null);
    assert.equal(extractTweetId("https://x.com/user/photos/123456"), null);
    assert.equal(extractTweetId("https://x.com/user/status/notanumber"), null);
    assert.equal(extractTweetId("https://twitter.com/"), null);
    assert.equal(extractTweetId(""), null);
});

test("Twitter Integration: Calculates syndication token using mathematical formula", () => {
    const token1 = calculateSyndicationToken("1585341984679469056");
    assert.equal(token1, "3uchycv2wqc");

    const token2 = calculateSyndicationToken("850007368138018817");
    assert.equal(token2, "226dkgspmbx");
});

test("Twitter Integration: Successful video response selects highest bitrate MP4 and ignores HLS", async () => {
    const mockTweetJson = {
        text: "Entering Twitter HQ – let that sink in! https://t.co/D68z4K2wq7",
        user: { name: "Elon Musk", screen_name: "elonmusk" },
        mediaDetails: [
            {
                type: "video",
                video_info: {
                    variants: [
                        { bitrate: 256000, content_type: "video/mp4", url: "https://video.twimg.com/example-low.mp4" },
                        { bitrate: 10368000, content_type: "video/mp4", url: "https://video.twimg.com/example-high.mp4" },
                        { content_type: "application/x-mpegURL", url: "https://video.twimg.com/example.m3u8" }
                    ]
                }
            }
        ]
    };

    let requestedUrl = null;
    const mockFetchHtml = async (url) => {
        requestedUrl = url;
        return JSON.stringify(mockTweetJson);
    };

    const result = await extractTwitter("https://x.com/elonmusk/status/1585341984679469056", {
        fetchHtml: mockFetchHtml
    });

    assert.ok(requestedUrl.includes("cdn.syndication.twimg.com/tweet-result?id=1585341984679469056"));
    assert.ok(requestedUrl.includes("token=3uchycv2wqc"));
    assert.equal(result.url, "https://video.twimg.com/example-high.mp4");
    assert.equal(result.type, "video");
    assert.equal(result.title, "Entering Twitter HQ – let that sink in!");

    const validated = validateExtractionResult(result, "twitter");
    assert.equal(validated.url, "https://video.twimg.com/example-high.mp4");
    assert.equal(validated.type, "video");
});

test("Twitter Integration: Animated GIF with MP4 variant extracted as video", async () => {
    const mockGifJson = {
        text: "Cool animation",
        user: { screen_name: "designer" },
        mediaDetails: [
            {
                type: "animated_gif",
                video_info: {
                    variants: [
                        { bitrate: 0, content_type: "video/mp4", url: "https://video.twimg.com/tweet_gif.mp4" }
                    ]
                }
            }
        ]
    };

    const result = await extractTwitter("https://twitter.com/designer/status/1122334455", {
        fetchHtml: async () => JSON.stringify(mockGifJson)
    });

    assert.equal(result.url, "https://video.twimg.com/tweet_gif.mp4");
    assert.equal(result.type, "video");
    assert.equal(result.title, "Cool animation");
});

test("Twitter Integration: Photo extraction works when no video is present", async () => {
    const mockPhotoJson = {
        text: "Beautiful sunset photo",
        user: { screen_name: "photographer" },
        mediaDetails: [
            {
                type: "photo",
                media_url_https: "https://pbs.twimg.com/media/sunset.jpg"
            }
        ]
    };

    const result = await extractTwitter("https://x.com/photographer/status/9988776655", {
        fetchHtml: async () => JSON.stringify(mockPhotoJson)
    });

    assert.equal(result.url, "https://pbs.twimg.com/media/sunset.jpg");
    assert.equal(result.type, "image");
    assert.equal(result.title, "Beautiful sunset photo");

    const validated = validateExtractionResult(result, "twitter");
    assert.equal(validated.url, "https://pbs.twimg.com/media/sunset.jpg");
    assert.equal(validated.type, "image");
});

test("Twitter Integration: Multiple media items prioritizes video over photos", async () => {
    const mockMixedJson = {
        text: "Post with photo and video",
        user: { screen_name: "multimedia" },
        mediaDetails: [
            {
                type: "photo",
                media_url_https: "https://pbs.twimg.com/media/preview.jpg"
            },
            {
                type: "video",
                video_info: {
                    variants: [
                        { bitrate: 500000, content_type: "video/mp4", url: "https://video.twimg.com/actual_video.mp4" }
                    ]
                }
            }
        ]
    };

    const result = await extractTwitter("https://x.com/multimedia/status/1234567890", {
        fetchHtml: async () => JSON.stringify(mockMixedJson)
    });

    assert.equal(result.url, "https://video.twimg.com/actual_video.mp4");
    assert.equal(result.type, "video");
});

test("Twitter Integration: Unapproved media domain rejected by validateMediaUrl", async () => {
    const mockMaliciousJson = {
        text: "Exploit attempt",
        mediaDetails: [
            {
                type: "video",
                video_info: {
                    variants: [
                        { bitrate: 1000, content_type: "video/mp4", url: "https://malicious-external-cdn.com/bad.mp4" }
                    ]
                }
            }
        ]
    };

    await assert.rejects(
        () => extractTwitter("https://x.com/attacker/status/1234567890", {
            fetchHtml: async () => JSON.stringify(mockMaliciousJson)
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.code, "UNAPPROVED_MEDIA_DOMAIN");
            return true;
        }
    );
});

test("Twitter Integration: HTTP/private/internal media URL rejected", async () => {
    const mockInternalJson = {
        text: "Internal exploit",
        mediaDetails: [
            {
                type: "video",
                video_info: {
                    variants: [
                        { bitrate: 1000, content_type: "video/mp4", url: "http://127.0.0.1:8080/internal.mp4" }
                    ]
                }
            }
        ]
    };

    await assert.rejects(
        () => extractTwitter("https://x.com/attacker/status/1234567890", {
            fetchHtml: async () => JSON.stringify(mockInternalJson)
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.code, "UNSUPPORTED_PROTOCOL");
            return true;
        }
    );
});

test("Twitter Integration: Tombstone response mapped to MEDIA_NOT_FOUND", async () => {
    const mockTombstone = {
        __typename: "TweetTombstone",
        tombstone: true
    };

    await assert.rejects(
        () => extractTwitter("https://x.com/user/status/1580661436132757506", {
            fetchHtml: async () => JSON.stringify(mockTombstone)
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND);
            assert.match(err.message, /deleted.*restricted/);
            return true;
        }
    );
});

test("Twitter Integration: Empty mediaDetails and no photos mapped to MEDIA_NOT_FOUND", async () => {
    const mockTextOnly = {
        __typename: "Tweet",
        text: "Just a text tweet without any media",
        user: { screen_name: "author" },
        mediaDetails: []
    };

    await assert.rejects(
        () => extractTwitter("https://x.com/author/status/850007368138018817", {
            fetchHtml: async () => JSON.stringify(mockTextOnly)
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND);
            return true;
        }
    );
});

test("Twitter Integration: Controlled fallback to token=0 when primary calculated token returns 404", async () => {
    const mockVideoJson = {
        text: "Video from fallback token",
        mediaDetails: [
            {
                type: "video",
                video_info: {
                    variants: [
                        { bitrate: 1000000, content_type: "video/mp4", url: "https://video.twimg.com/fallback_video.mp4" }
                    ]
                }
            }
        ]
    };

    const requestedUrls = [];
    const mockFetchHtml = async (url) => {
        requestedUrls.push(url);
        if (url.includes("token=0")) {
            return JSON.stringify(mockVideoJson);
        }
        throw new SecurityHTTPError("Page not found (404)", 404);
    };

    const result = await extractTwitter("https://x.com/user/status/1585341984679469056", {
        fetchHtml: mockFetchHtml
    });

    assert.equal(requestedUrls.length, 2);
    assert.ok(requestedUrls[0].includes("token="));
    assert.ok(requestedUrls[1].includes("token=0"));
    assert.equal(result.url, "https://video.twimg.com/fallback_video.mp4");
});

test("Twitter Integration: Upstream HTTP 401/403/429 mapped to PLATFORM_CHALLENGE", async () => {
    for (const code of [401, 403, 429]) {
        const mockFetchHtml = async () => {
            throw new SecurityHTTPError(`Blocked (${code})`, code);
        };

        await assert.rejects(
            () => extractTwitter("https://x.com/user/status/1234567890", {
                fetchHtml: mockFetchHtml
            }),
            (err) => {
                assert.ok(err instanceof ExtractionError);
                assert.equal(err.code, EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE);
                assert.equal(err.statusCode, 403);
                return true;
            }
        );
    }
});

test("Twitter Integration: Upstream timeout mapped to PROVIDER_TIMEOUT", async () => {
    const mockFetchHtml = async () => {
        const err = new SecurityHTTPError("Timeout", 504);
        err.code = "TIMEOUT";
        throw err;
    };

    await assert.rejects(
        () => extractTwitter("https://x.com/user/status/1234567890", {
            fetchHtml: mockFetchHtml,
            timeoutMs: 3000
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT);
            return true;
        }
    );
});

test("Twitter Integration: Security violation halts immediately without fallback to token=0", async () => {
    let callCount = 0;
    const mockFetchHtml = async () => {
        callCount++;
        throw new ValidationError("Destination resolves to prohibited IP", "SSRF_PROHIBITED");
    };

    await assert.rejects(
        () => extractTwitter("https://x.com/user/status/1234567890", {
            fetchHtml: mockFetchHtml
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.code, "SSRF_PROHIBITED");
            return true;
        }
    );

    assert.equal(callCount, 1, "Must never invoke fallback on security policy violation");
});

test("Twitter Integration: Regression test ensuring twitter-downloader is completely removed", () => {
    assert.throws(
        () => require("twitter-downloader"),
        { code: "MODULE_NOT_FOUND" },
        "twitter-downloader must not be installed or imported"
    );
});

// --- YOUTUBE ---
test("YouTube Integration: Adapter calls getInfo() and selects valid mp4 format", async () => {
    let getInfoCalledUrl = null;

    const mockYtdl = {
        getInfo: async (url) => {
            getInfoCalledUrl = url;
            return {
                videoDetails: { title: "YouTube Video Title" },
                formats: [
                    { container: "webm", hasVideo: true, hasAudio: false, url: "https://rr1---sn-abc.googlevideo.com/webm_video" },
                    { container: "mp4", hasVideo: true, hasAudio: true, url: "https://rr1---sn-abc.googlevideo.com/mp4_combined" }
                ]
            };
        }
    };

    const result = await extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
        provider: mockYtdl
    });

    assert.equal(getInfoCalledUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    assert.equal(result.url, "https://rr1---sn-abc.googlevideo.com/mp4_combined");
    assert.equal(result.type, "video");
    assert.equal(result.title, "YouTube Video Title");

    const validated = validateExtractionResult(result, "youtube");
    assert.equal(validated.url, "https://rr1---sn-abc.googlevideo.com/mp4_combined");
});

test("YouTube Integration: Rejects when no downloadable mp4 format is available", async () => {
    const mockYtdl = {
        getInfo: async () => ({
            videoDetails: { title: "Audio Only" },
            formats: [
                { container: "m4a", hasVideo: false, hasAudio: true, mimeType: "audio/mp4", url: "https://googlevideo.com/audio" }
            ]
        })
    };

    await assert.rejects(
        () => extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
            provider: mockYtdl
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA);
            return true;
        }
    );
});

// --- PINTEREST & FACEBOOK (REMOVED UNSAFE PACKAGES) ---
test("Pinterest Integration: Direct HTML extraction works with deterministic fixture and decodes &amp;", async () => {
    const fixtureHtml = `
        <!DOCTYPE html>
        <html>
            <head>
                <meta property="og:image" content="https://i.pinimg.com/736x/test_pin.jpg?token=abc&amp;width=736" />
            </head>
        </html>
    `;

    const result = await extractPinterest("https://www.pinterest.com/pin/123456789012345678/", {
        fetchHtml: async () => fixtureHtml
    });

    // Encoded &amp; must be decoded to clean &
    assert.equal(result.url, "https://i.pinimg.com/736x/test_pin.jpg?token=abc&width=736");
    assert.equal(result.type, "image");

    const validated = validateExtractionResult(result, "pinterest");
    assert.equal(validated.url, "https://i.pinimg.com/736x/test_pin.jpg?token=abc&width=736");
});

test("Facebook Integration: HTML with data-video-url extracts video URL", async () => {
    const fixtureHtml = `
        <!DOCTYPE html>
        <html>
            <body>
                <div data-video-url="https://video.famd5-3.fna.fbcdn.net/v/t42/data_video.mp4?token=abc&amp;id=123"></div>
                <meta property="og:title" content="Facebook Watch Video" />
            </body>
        </html>
    `;

    const result = await extractFacebook("https://www.facebook.com/watch/?v=10153231379946729", {
        fetchHtml: async () => fixtureHtml
    });

    assert.equal(result.url, "https://video.famd5-3.fna.fbcdn.net/v/t42/data_video.mp4?token=abc&id=123");
    assert.equal(result.type, "video");
    assert.equal(result.title, "Facebook Watch Video");

    const validated = validateExtractionResult(result, "facebook");
    assert.equal(validated.url, "https://video.famd5-3.fna.fbcdn.net/v/t42/data_video.mp4?token=abc&id=123");
});

test("Facebook Integration: Standard og:video meta tag extracts video URL and decodes &amp;", async () => {
    const fixtureHtml = `
        <!DOCTYPE html>
        <html>
            <head>
                <meta property="og:video" content="https://video.xx.fbcdn.net/v/t42/reel.mp4?token=abc&amp;sig=123" />
                <meta property="og:title" content="A Great Facebook Reel" />
            </head>
        </html>
    `;

    const result = await extractFacebook("https://www.facebook.com/watch?v=1020304050", {
        fetchHtml: async () => fixtureHtml
    });

    assert.equal(result.url, "https://video.xx.fbcdn.net/v/t42/reel.mp4?token=abc&sig=123");
    assert.equal(result.type, "video");
    assert.equal(result.title, "A Great Facebook Reel");

    const validated = validateExtractionResult(result, "facebook");
    assert.equal(validated.url, "https://video.xx.fbcdn.net/v/t42/reel.mp4?token=abc&sig=123");
});

test("Facebook Integration: Reversed meta attributes (content before property) extracts video URL", async () => {
    const fixtureHtml = `
        <!DOCTYPE html>
        <html>
            <head>
                <meta content="https://video.xx.fbcdn.net/v/t42/reversed_meta.mp4?token=xyz" property="og:video" />
                <title>Reversed Meta Video</title>
            </head>
        </html>
    `;

    const result = await extractFacebook("https://www.facebook.com/reel/10153231379946729/", {
        fetchHtml: async () => fixtureHtml
    });

    assert.equal(result.url, "https://video.xx.fbcdn.net/v/t42/reversed_meta.mp4?token=xyz");
    assert.equal(result.type, "video");
    assert.equal(result.title, "Reversed Meta Video");
});

test("Facebook Integration: Embedded playable_url extracted when meta tags are absent", async () => {
    const fixtureHtml = `
        <script>
            requireLazy(["ScheduledServerJS"], function(s) {
                s.handle({"define":[["ServerJSData",[],{"instances":[]},1]],"require":[["RelayPrefetchedStreamCache","next",[],["123",{"playable_url":"https:\\/\\/video.xx.fbcdn.net\\/v\\/t42\\/relay_stream.mp4?token=abc&amp;sig=def"}]]]});
            });
        </script>
    `;

    const result = await extractFacebook("https://www.facebook.com/watch/?v=10153231379946729", {
        fetchHtml: async () => fixtureHtml
    });

    assert.equal(result.url, "https://video.xx.fbcdn.net/v/t42/relay_stream.mp4?token=abc&sig=def");
    assert.equal(result.type, "video");
});

test("Facebook Integration: playable_url_quality_hd is preferred over playable_url", async () => {
    const fixtureHtml = `
        <script>
            var videoData = {
                "playable_url": "https:\\/\\/video.xx.fbcdn.net\\/v\\/t42\\/sd_quality.mp4",
                "playable_url_quality_hd": "https:\\/\\/video.xx.fbcdn.net\\/v\\/t42\\/hd_quality.mp4"
            };
        </script>
    `;

    const result = await extractFacebook("https://www.facebook.com/watch/?v=10153231379946729", {
        fetchHtml: async () => fixtureHtml
    });

    assert.equal(result.url, "https://video.xx.fbcdn.net/v/t42/hd_quality.mp4");
    assert.equal(result.type, "video");
});

test("Facebook Integration: Priority order enforces data-video-url over og:video and playable_url", async () => {
    const fixtureHtml = `
        <meta property="og:video" content="https://video.xx.fbcdn.net/v/t42/og_video.mp4" />
        <div data-video-url="https://video.xx.fbcdn.net/v/t42/priority_data_video.mp4"></div>
        <script>var x = {"playable_url": "https://video.xx.fbcdn.net/v/t42/playable.mp4"};</script>
    `;

    const result = await extractFacebook("https://www.facebook.com/watch/?v=10153231379946729", {
        fetchHtml: async () => fixtureHtml
    });

    assert.equal(result.url, "https://video.xx.fbcdn.net/v/t42/priority_data_video.mp4");
});

test("Facebook Integration: Video post with only og:image does NOT return image as video", async () => {
    const fixtureHtml = `
        <!DOCTYPE html>
        <html>
            <head>
                <meta property="og:image" content="https://scontent.xx.fbcdn.net/v/t15/preview.jpg" />
                <title>Some Facebook Post</title>
            </head>
            <body>No video here</body>
        </html>
    `;

    await assert.rejects(
        () => extractFacebook("https://www.facebook.com/watch/?v=10153231379946729", {
            fetchHtml: async () => fixtureHtml
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND);
            return true;
        }
    );
});

test("Facebook Integration: Candidate URL from unapproved domain is rejected by validateMediaUrl", async () => {
    const fixtureHtml = `
        <!DOCTYPE html>
        <html>
            <head>
                <meta property="og:video" content="https://malicious-external-domain.com/video.mp4" />
            </head>
        </html>
    `;

    await assert.rejects(
        () => extractFacebook("https://www.facebook.com/watch/?v=10153231379946729", {
            fetchHtml: async () => fixtureHtml
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.code, "UNAPPROVED_MEDIA_DOMAIN");
            return true;
        }
    );
});

test("Facebook Integration: Login barrier shell classified as PLATFORM_CHALLENGE (403)", async () => {
    const fixtureHtml = `
        <!DOCTYPE html>
        <html>
            <head><title>Facebook – log in or sign up</title></head>
            <body>
                <a href="/login_via/app">Log in</a>
            </body>
        </html>
    `;

    await assert.rejects(
        () => extractFacebook("https://www.facebook.com/watch/?v=10153231379946729", {
            fetchHtml: async () => fixtureHtml
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE);
            assert.equal(err.statusCode, 403);
            return true;
        }
    );
});

test("Facebook Integration: Upstream HTTP 401/403/429 classified as PLATFORM_CHALLENGE", async () => {
    const { SecurityHTTPError } = require("../lib/http-client.cjs");
    for (const code of [401, 403, 429]) {
        const mockFetchHtml = async () => {
            throw new SecurityHTTPError(`Upstream HTTP ${code}`, code);
        };

        await assert.rejects(
            () => extractFacebook("https://www.facebook.com/watch/?v=10153231379946729", {
                fetchHtml: mockFetchHtml
            }),
            (err) => {
                assert.ok(err instanceof ExtractionError);
                assert.equal(err.code, EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE);
                assert.equal(err.statusCode, 403);
                return true;
            }
        );
    }
});

test("Facebook Integration: Genuinely missing page (HTTP 404) returns MEDIA_NOT_FOUND (404)", async () => {
    const { SecurityHTTPError } = require("../lib/http-client.cjs");
    const mockFetchHtml = async () => {
        throw new SecurityHTTPError("Upstream HTTP 404", 404);
    };

    await assert.rejects(
        () => extractFacebook("https://www.facebook.com/watch/?v=99999999999999", {
            fetchHtml: mockFetchHtml
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND);
            assert.equal(err.statusCode, 404);
            return true;
        }
    );
});

test("Facebook Integration: Adapter passes mobile User-Agent and Sec-Fetch navigation headers to fetchHtml", async () => {
    let capturedOptions = null;
    const mockFetchHtml = async (url, domains, maxBytes, options) => {
        capturedOptions = options;
        return `<html><head><meta property="og:video" content="https://video.xx.fbcdn.net/v/t42/test.mp4" /></head></html>`;
    };

    const result = await extractFacebook("https://www.facebook.com/watch/?v=10153231379946729", {
        fetchHtml: mockFetchHtml
    });

    assert.ok(capturedOptions);
    assert.ok(capturedOptions.headers);
    assert.match(capturedOptions.headers["User-Agent"], /Android.*Chrome.*Mobile/);
    assert.equal(capturedOptions.headers["Sec-Fetch-Dest"], "document");
    assert.equal(capturedOptions.headers["Sec-Fetch-Mode"], "navigate");
    assert.equal(capturedOptions.headers["Sec-Fetch-Site"], "none");
    assert.equal(capturedOptions.headers["Sec-Fetch-User"], "?1");
    assert.equal(result.url, "https://video.xx.fbcdn.net/v/t42/test.mp4");
});

test("Facebook Integration: Security violation halts immediately without swallowing", async () => {
    const mockFetchHtml = () => {
        throw new ValidationError("Destination resolves to prohibited IP", "SSRF_PROHIBITED");
    };

    await assert.rejects(
        () => extractFacebook("https://www.facebook.com/watch/?v=10153231379946729", {
            fetchHtml: mockFetchHtml
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.code, "SSRF_PROHIBITED");
            return true;
        }
    );
});

test("Facebook Integration: Upstream timeout maps to PROVIDER_TIMEOUT", async () => {
    const { SecurityHTTPError } = require("../lib/http-client.cjs");
    const mockFetchHtml = async () => {
        const err = new SecurityHTTPError("Request timed out", 504);
        err.code = "TIMEOUT";
        throw err;
    };

    await assert.rejects(
        () => extractFacebook("https://www.facebook.com/watch/?v=10153231379946729", {
            fetchHtml: mockFetchHtml,
            timeoutMs: 5000
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT);
            return true;
        }
    );
});


// ==================== HTML ENTITY DECODING TESTS ====================

test("HTML Entity Decoding: decodeUrl decodes &amp;, escaped quotes, and unicode ampersands", () => {
    const input = "https://cdn.example.com/video.mp4?a=1&amp;b=2\\\"&amp;c=\\u0026d";
    const output = decodeUrl(input);
    assert.equal(output, "https://cdn.example.com/video.mp4?a=1&b=2\"&c=&d");
});

test("HTML Entity Decoding: decodeUrl decodes &quot;, &#39;, &#x27;, and escaped slashes", () => {
    const input = "https:\\/\\/cdn.example.com\\/video.mp4?name=&quot;test&quot;&amp;tag=&#39;cool&#39;&amp;flag=&#x27;ok&#x27;";
    assert.equal(decodeUrl(input), "https://cdn.example.com/video.mp4?name=\"test\"&tag='cool'&flag='ok'");
});

test("HTML Entity Decoding: extractFromMeta decodes &amp; correctly", () => {
    const html = `<meta property="og:video" content="https://video.xx.fbcdn.net/v/t42/test.mp4?a=1&amp;b=2" />`;
    assert.equal(extractFromMeta(html), "https://video.xx.fbcdn.net/v/t42/test.mp4?a=1&b=2");
});

test("HTML Entity Decoding: extractFromMeta supports reversed attribute order and decodes entities", () => {
    const html = `<meta content="https://video.xx.fbcdn.net/v/t42/reversed.mp4?a=1&amp;b=2" property="og:video" />`;
    assert.equal(extractFromMeta(html), "https://video.xx.fbcdn.net/v/t42/reversed.mp4?a=1&b=2");
});

test("HTML Entity Decoding: extractMediaFromHtml decodes &amp; correctly", () => {
    const html = `{"video_versions":[{"url":"https://scontent.cdninstagram.com/v/t50/vid.mp4?a=1&amp;b=2"}]}`;
    const result = extractMediaFromHtml(html);
    assert.ok(result);
    assert.equal(result.url, "https://scontent.cdninstagram.com/v/t50/vid.mp4?a=1&b=2");
});

// ==================== SECURITY SHORT-CIRCUIT TESTS ====================

test("Security Short-Circuit: Real Instagram adapter halts immediately on primary security violation without invoking secondary fallback", async () => {
    let fallbackProviderCalled = false;

    const mockPrimaryWithSecurityViolation = () => {
        throw new ValidationError("Destination resolves to prohibited IP", "SSRF_PROHIBITED");
    };

    const mockProvider = {
        instagramGetUrl: async () => {
            fallbackProviderCalled = true;
            return { results_number: 1, url_list: ["https://scontent.cdninstagram.com/fallback.mp4"] };
        }
    };

    await assert.rejects(
        () => extractInstagram("https://www.instagram.com/reel/DA123456789/", {
            fetchHtml: mockPrimaryWithSecurityViolation,
            provider: mockProvider
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.code, "SSRF_PROHIBITED");
            return true;
        }
    );

    assert.equal(fallbackProviderCalled, false, "Fallback MUST NOT execute when security policy is violated");
});

test("Security Short-Circuit: Secondary provider security violation halts immediately without swallowing", async () => {
    const mockFetchHtml = async () => "<html></html>";

    const mockProvider = {
        instagramGetUrl: async () => {
            throw new ValidationError("Destination resolves to prohibited IP", "SSRF_PROHIBITED");
        }
    };

    await assert.rejects(
        () => extractInstagram("https://www.instagram.com/reel/DA123456789/", {
            fetchHtml: mockFetchHtml,
            provider: mockProvider
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.code, "SSRF_PROHIBITED");
            return true;
        }
    );
});

// ==================== TIMEOUT SEMANTICS TESTS (TESTS A, B, C, D, E) ====================

// Test A: Cancellable mock operation receives AbortSignal
test("Timeout Test A: Cancellable mock operation receives AbortSignal and aborts on timeout", async () => {
    let providerSawAbort = false;

    const cancellableOp = ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
            providerSawAbort = true;
            reject(new Error("Operation aborted by controller"));
        });
    });

    await assert.rejects(
        () => withTimeout(cancellableOp, 50, "cancellable-test-provider"),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT);
            assert.equal(err.details.cancellable, true);
            assert.equal(err.details.cancelled, true);
            return true;
        }
    );

    assert.equal(providerSawAbort, true, "Provider operation must observe AbortSignal on timeout");
});

// Test B: Non-cancellable third-party promise
test("Timeout Test B: Non-cancellable third-party promise bounds waiting without claiming fake cancellation", async () => {
    const nonCancellablePromise = new Promise((resolve) => {
        setTimeout(resolve, 5000);
    });

    await assert.rejects(
        () => withTimeout(nonCancellablePromise, 50, "non-cancellable-library"),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT);
            assert.equal(err.details.cancellable, false);
            assert.equal(err.details.cancelled, false);
            return true;
        }
    );
});

// Test C: Provider completes before timeout
test("Timeout Test C: Provider completes successfully before timeout", async () => {
    const fastOp = async ({ signal }) => {
        assert.equal(signal.aborted, false);
        return { data: "success_data" };
    };

    const res = await withTimeout(fastOp, 500, "fast-provider");
    assert.deepEqual(res, { data: "success_data" });
});

// Test D: Provider fails before timeout
test("Timeout Test D: Provider fails before timeout with normal error", async () => {
    const failingOp = async () => {
        throw new Error("Immediate network disconnect");
    };

    await assert.rejects(
        () => withTimeout(failingOp, 500, "failing-provider"),
        (err) => {
            assert.equal(err.message, "Immediate network disconnect");
            return true;
        }
    );
});

// Test E: Unhandled rejection prevention on late failures
test("Timeout Test E: Late rejection on non-cancellable promise after timeout does not cause unhandled rejection", async () => {
    let rejectLate;
    const latePromise = new Promise((_, reject) => {
        rejectLate = reject;
    });

    await assert.rejects(
        () => withTimeout(latePromise, 30, "late-failing-provider"),
        (err) => {
            assert.equal(err.code, EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT);
            return true;
        }
    );

    // Emulate late upstream failure occurring after Reeva already timed out
    assert.doesNotThrow(() => {
        rejectLate(new Error("Late network crash after timeout"));
    });
});

// ==================== RESULT VALIDATOR TESTS ====================

test("Result Validator: Rejects unsupported media types", () => {
    assert.throws(
        () => validateExtractionResult({
            url: "https://scontent.cdninstagram.com/audio.mp3",
            type: "audio"
        }, "instagram"),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA);
            return true;
        }
    );
});

test("Result Validator: Truncates long titles to 200 chars", () => {
    const longTitle = "A".repeat(500);
    const validated = validateExtractionResult({
        url: "https://scontent.cdninstagram.com/v/t50/video.mp4",
        type: "video",
        title: longTitle
    }, "instagram");

    assert.equal(validated.title.length, 200);
});
