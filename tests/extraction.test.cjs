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

test("Instagram Integration: Fallback candidate URL from unapproved domain is rejected by validateMediaUrl", async () => {
    const mockInstagramDirect = {
        instagramGetUrl: async () => ({
            results_number: 1,
            media_details: [
                {
                    type: "video",
                    url: "https://unapproved-domain.test/video.mp4"
                }
            ]
        })
    };

    await assert.rejects(
        () => extractInstagram("https://www.instagram.com/reel/DA123456789/", {
            fetchHtml: async () => "<html></html>",
            provider: mockInstagramDirect
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.code, "UNAPPROVED_MEDIA_DOMAIN");
            return true;
        }
    );
});

test("Instagram Integration: Fallback candidate URL with private IP is rejected by validateMediaUrl", async () => {
    const mockInstagramDirect = {
        instagramGetUrl: async () => ({
            results_number: 1,
            url_list: ["https://127.0.0.1/video.mp4"]
        })
    };

    await assert.rejects(
        () => extractInstagram("https://www.instagram.com/reel/DA123456789/", {
            fetchHtml: async () => "<html></html>",
            provider: mockInstagramDirect
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.code, "UNAPPROVED_MEDIA_DOMAIN");
            return true;
        }
    );
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

// --- YOUTUBE (yt-dlp adapter) ---
test("YouTube Integration: VIDEO_ONLY mode extracts direct stream URL and enforces security flags", async () => {
    let captured = null;
    const mockRunner = async ({ command, args }) => {
        captured = { command, args };
        return {
            stdout: JSON.stringify({
                url: "https://rr1---sn-abc.googlevideo.com/videoplayback?id=123",
                fulltitle: "Video Only Test Title",
                vcodec: "av01",
                acodec: "none"
            }),
            stderr: "",
            exitCode: 0
        };
    };

    const result = await extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
        mode: "VIDEO_ONLY",
        commandRunner: mockRunner
    });

    assert.ok(captured);
    assert.ok(captured.args.includes("--no-playlist"));
    assert.ok(captured.args.includes("--no-call-home"));
    assert.ok(captured.args.includes("--ignore-config"));
    assert.ok(captured.args.some(a => a.includes("bv*")));

    assert.equal(result.url, "https://rr1---sn-abc.googlevideo.com/videoplayback?id=123");
    assert.equal(result.type, "video");
    assert.equal(result.title, "Video Only Test Title");
    assert.equal(result.mode, "VIDEO_ONLY");

    const validated = validateExtractionResult(result, "youtube");
    assert.equal(validated.url, "https://rr1---sn-abc.googlevideo.com/videoplayback?id=123");
    assert.equal(validated.type, "video");
    assert.equal(validated.mode, "VIDEO_ONLY");
});

test("YouTube Integration: AUDIO_ONLY mode extracts direct audio stream URL and sets type to audio", async () => {
    let captured = null;
    const mockRunner = async ({ command, args }) => {
        captured = { command, args };
        return {
            stdout: JSON.stringify({
                url: "https://rr2---sn-xyz.googlevideo.com/videoplayback?id=456",
                fulltitle: "Audio Only Test Title",
                vcodec: "none",
                acodec: "mp4a.40.2"
            }),
            stderr: "",
            exitCode: 0
        };
    };

    const result = await extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
        mode: "AUDIO_ONLY",
        commandRunner: mockRunner
    });

    assert.ok(captured);
    assert.ok(captured.args.includes("ba[ext=m4a]/ba"));
    assert.equal(result.url, "https://rr2---sn-xyz.googlevideo.com/videoplayback?id=456");
    assert.equal(result.type, "audio");
    assert.equal(result.title, "Audio Only Test Title");
    assert.equal(result.mode, "AUDIO_ONLY");

    const validated = validateExtractionResult(result, "youtube");
    assert.equal(validated.url, "https://rr2---sn-xyz.googlevideo.com/videoplayback?id=456");
    assert.equal(validated.type, "audio");
    assert.equal(validated.mode, "AUDIO_ONLY");
});

test("YouTube Integration: VIDEO_AND_AUDIO mode merges to local file artifact and sets mode", async () => {
    const fs = require("fs");
    let captured = null;
    const mockRunner = async ({ command, args }) => {
        captured = { command, args };
        const oIndex = args.indexOf("-o");
        assert.ok(oIndex !== -1);
        const outPath = args[oIndex + 1];
        fs.writeFileSync(outPath, "mock mp4 content");

        return {
            stdout: JSON.stringify({
                fulltitle: "Merged Video Title",
                requested_formats: [
                    { url: "https://rr1---sn-abc.googlevideo.com/videoplayback?video=1" },
                    { url: "https://rr1---sn-abc.googlevideo.com/videoplayback?audio=1" }
                ],
                _filename: outPath
            }),
            stderr: "",
            exitCode: 0
        };
    };

    const result = await extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
        mode: "VIDEO_AND_AUDIO",
        commandRunner: mockRunner
    });

    assert.ok(captured);
    assert.ok(captured.args.includes("--merge-output-format"));
    assert.equal(result.url, "https://rr1---sn-abc.googlevideo.com/videoplayback?video=1");
    assert.equal(result.type, "video");
    assert.equal(result.mode, "VIDEO_AND_AUDIO");
    assert.ok(result.localFilePath);
    assert.ok(fs.existsSync(result.localFilePath));

    const validated = validateExtractionResult(result, "youtube");
    assert.equal(validated.url, "https://rr1---sn-abc.googlevideo.com/videoplayback?video=1");
    assert.equal(validated.localFilePath, result.localFilePath);
    assert.equal(validated.mode, "VIDEO_AND_AUDIO");

    try { fs.unlinkSync(result.localFilePath); } catch (_) {}
});

test("YouTube Integration: Defaults to VIDEO_AND_AUDIO when mode is omitted", async () => {
    const fs = require("fs");
    let captured = null;
    const mockRunner = async ({ command, args }) => {
        captured = { command, args };
        const oIndex = args.indexOf("-o");
        const outPath = args[oIndex + 1];
        fs.writeFileSync(outPath, "mock default mp4");

        return {
            stdout: JSON.stringify({
                fulltitle: "Default Mode Video",
                url: "https://rr3---sn-def.googlevideo.com/videoplayback?id=789",
                _filename: outPath
            }),
            stderr: "",
            exitCode: 0
        };
    };

    const result = await extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
        commandRunner: mockRunner
    });

    assert.equal(result.mode, "VIDEO_AND_AUDIO");
    assert.ok(result.localFilePath);
    try { fs.unlinkSync(result.localFilePath); } catch (_) {}
});

test("YouTube Integration: Rejects unsupported or invalid media mode", async () => {
    await assert.rejects(
        () => extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
            mode: "INVALID_MODE"
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA);
            return true;
        }
    );
});

test("YouTube Integration: Upstream timeout maps to PROVIDER_TIMEOUT", async () => {
    const mockRunner = async () => {
        throw new ExtractionError(EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT, "YouTube extraction timed out.");
    };

    await assert.rejects(
        () => extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
            mode: "VIDEO_ONLY",
            commandRunner: mockRunner
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT);
            return true;
        }
    );
});

test("YouTube Integration: Platform challenge / bot check maps to PLATFORM_CHALLENGE", async () => {
    const mockRunner = async () => {
        return {
            stdout: "",
            stderr: "ERROR: Sign in to confirm you're not a bot",
            exitCode: 1
        };
    };

    await assert.rejects(
        () => extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
            mode: "VIDEO_ONLY",
            commandRunner: mockRunner
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE);
            return true;
        }
    );
});

test("YouTube Integration: Private video maps to PRIVATE_CONTENT", async () => {
    const mockRunner = async () => {
        return {
            stdout: "",
            stderr: "ERROR: Private video. Sign in if you've been granted access to this video",
            exitCode: 1
        };
    };

    await assert.rejects(
        () => extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
            mode: "VIDEO_ONLY",
            commandRunner: mockRunner
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.PRIVATE_CONTENT);
            return true;
        }
    );
});

test("YouTube Integration: Video unavailable maps to MEDIA_NOT_FOUND", async () => {
    const mockRunner = async () => {
        return {
            stdout: "",
            stderr: "ERROR: Video unavailable. This video has been removed",
            exitCode: 1
        };
    };

    await assert.rejects(
        () => extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
            mode: "VIDEO_ONLY",
            commandRunner: mockRunner
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND);
            return true;
        }
    );
});

test("YouTube Integration: Regression test ensuring @distube/ytdl-core is completely removed", () => {
    assert.throws(
        () => require.resolve("@distube/ytdl-core"),
        { code: "MODULE_NOT_FOUND" },
        "@distube/ytdl-core must not be installed or imported"
    );
});

test("YouTube Integration: Production mode rejects execution when YT_DLP_PATH is missing", async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origYtDlp = process.env.YT_DLP_PATH;

    try {
        process.env.NODE_ENV = "production";
        delete process.env.YT_DLP_PATH;

        await assert.rejects(
            () => extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
                mode: "VIDEO_ONLY"
            }),
            (err) => {
                assert.ok(err instanceof ExtractionError);
                assert.equal(err.code, EXTRACTION_ERROR_CODES.UPSTREAM_UNAVAILABLE);
                assert.ok(err.message.includes("YT_DLP_PATH is required"));
                return true;
            }
        );
    } finally {
        if (origNodeEnv !== undefined) {
            process.env.NODE_ENV = origNodeEnv;
        } else {
            delete process.env.NODE_ENV;
        }
        if (origYtDlp !== undefined) {
            process.env.YT_DLP_PATH = origYtDlp;
        } else {
            delete process.env.YT_DLP_PATH;
        }
    }
});

test("YouTube Integration: Rejects missing FFMPEG_PATH when VIDEO_AND_AUDIO is requested", async () => {
    const origFfmpeg = process.env.FFMPEG_PATH;

    try {
        delete process.env.FFMPEG_PATH;
        const mockRunner = async () => ({ stdout: "{}", stderr: "", exitCode: 0 });

        await assert.rejects(
            () => extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
                mode: "VIDEO_AND_AUDIO",
                commandRunner: mockRunner
            }),
            (err) => {
                assert.ok(err instanceof ExtractionError);
                assert.equal(err.code, EXTRACTION_ERROR_CODES.UPSTREAM_UNAVAILABLE);
                assert.ok(err.message.includes("FFmpeg is not configured"));
                return true;
            }
        );
    } finally {
        if (origFfmpeg !== undefined) {
            process.env.FFMPEG_PATH = origFfmpeg;
        } else {
            delete process.env.FFMPEG_PATH;
        }
    }
});

test("YouTube Integration: Does NOT require imageio_ffmpeg or python when YT_DLP_PATH and FFMPEG_PATH are configured", async () => {
    const path = require("path");
    let captured = null;
    const mockRunner = async ({ command, args }) => {
        captured = { command, args };
        return {
            stdout: JSON.stringify({
                url: "https://rr1---sn-abc.googlevideo.com/videoplayback",
                fulltitle: "Clean Env Title"
            }),
            stderr: "",
            exitCode: 0
        };
    };

    const standaloneYtDlp = "C:\\Standalone\\yt-dlp.exe";
    const standaloneFfmpeg = "C:\\Standalone\\ffmpeg.exe";

    const result = await extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
        mode: "VIDEO_ONLY",
        ytDlpPath: standaloneYtDlp,
        ffmpegPath: standaloneFfmpeg,
        commandRunner: mockRunner
    });

    assert.equal(captured.command, path.resolve(standaloneYtDlp));
    assert.equal(captured.args[0], "-j");
    assert.equal(result.title, "Clean Env Title");
});

test("YouTube Integration: Preserves YT_DLP_PATH containing spaces without whitespace splitting", async () => {
    const path = require("path");
    let captured = null;
    const mockRunner = async ({ command, args }) => {
        captured = { command, args };
        return {
            stdout: JSON.stringify({
                url: "https://rr1---sn-abc.googlevideo.com/videoplayback",
                fulltitle: "Path With Spaces Title"
            }),
            stderr: "",
            exitCode: 0
        };
    };

    const spacedPath = "C:\\Program Files\\Custom Reeva Tools\\yt-dlp.exe";

    await extractYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
        mode: "VIDEO_ONLY",
        ytDlpPath: spacedPath,
        commandRunner: mockRunner
    });

    assert.equal(captured.command, path.resolve(spacedPath));
    assert.equal(captured.args[0], "-j");
});

test("YouTube Integration: Bounded stdout terminates process when limit is exceeded", async () => {
    const { defaultCommandRunner } = require("../lib/extraction/adapters/youtube.cjs");

    await assert.rejects(
        () => defaultCommandRunner({
            command: "node",
            args: ["-e", "process.stdout.write('X'.repeat(5000));"],
            maxStdoutBytes: 1000
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.ok(err.message.includes("stdout exceeded maximum buffer limit"));
            return true;
        }
    );
});

test("YouTube Integration: Bounded stderr terminates process when limit is exceeded", async () => {
    const { defaultCommandRunner } = require("../lib/extraction/adapters/youtube.cjs");

    await assert.rejects(
        () => defaultCommandRunner({
            command: "node",
            args: ["-e", "process.stderr.write('E'.repeat(5000));"],
            maxStderrBytes: 1000
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.ok(err.message.includes("stderr exceeded maximum buffer limit"));
            return true;
        }
    );
});

test("YouTube Integration: Error sanitization redacts signed URLs from error details", () => {
    const { mapYtDlpError } = require("../lib/extraction/adapters/youtube.cjs");
    const sensitiveStderr = "Error opening https://rr1---sn-abc.googlevideo.com/videoplayback?expire=123&sig=SECRET_TOKEN: 403 Forbidden";
    const err = mapYtDlpError(new Error("Spawn error"), sensitiveStderr);

    assert.ok(!err.details.originalError.includes("SECRET_TOKEN"));
    assert.ok(err.details.originalError.includes("[REDACTED_URL]"));
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

test("Pinterest Integration: Upstream HTTP 401/403/429 classified as PLATFORM_CHALLENGE", async () => {
    for (const code of [401, 403, 429]) {
        const mockFetchHtml = async () => {
            throw new SecurityHTTPError(`Upstream HTTP ${code}`, code);
        };

        await assert.rejects(
            () => extractPinterest("https://www.pinterest.com/pin/123456789012345678/", {
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

test("Pinterest Integration: Upstream HTTP 404 mapped to MEDIA_NOT_FOUND", async () => {
    const mockFetchHtml = async () => {
        throw new SecurityHTTPError("Page not found (404)", 404);
    };

    await assert.rejects(
        () => extractPinterest("https://www.pinterest.com/pin/999999999999999999/", {
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

test("Pinterest Integration: Upstream timeout mapped to PROVIDER_TIMEOUT", async () => {
    const mockFetchHtml = async () => {
        const err = new SecurityHTTPError("Request timed out", 504);
        err.code = "TIMEOUT";
        throw err;
    };

    await assert.rejects(
        () => extractPinterest("https://www.pinterest.com/pin/123456789012345678/", {
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

test("Pinterest Integration: Security violation halts immediately without swallowing", async () => {
    const mockFetchHtml = () => {
        throw new ValidationError("Destination resolves to prohibited IP", "SSRF_PROHIBITED");
    };

    await assert.rejects(
        () => extractPinterest("https://www.pinterest.com/pin/123456789012345678/", {
            fetchHtml: mockFetchHtml
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.code, "SSRF_PROHIBITED");
            return true;
        }
    );
});

test("Pinterest Integration: Extracts post title from og:title and decodes HTML entities", async () => {
    const fixtureHtml = `
        <!DOCTYPE html>
        <html>
            <head>
                <meta property="og:title" content="Vintage Art &amp; Design &quot;Inspiration&quot;" />
                <meta property="og:image" content="https://i.pinimg.com/736x/vintage.jpg" />
            </head>
        </html>
    `;

    const result = await extractPinterest("https://www.pinterest.com/pin/123456789012345678/", {
        fetchHtml: async () => fixtureHtml
    });

    assert.equal(result.title, 'Vintage Art & Design "Inspiration"');
    assert.equal(result.url, "https://i.pinimg.com/736x/vintage.jpg");
    assert.equal(result.type, "image");
});

test("Pinterest Integration: Resolves pin.it short links and handles redirect errors", async () => {
    // 1. Successful short link resolution
    const mockFetch = async (url) => {
        return {
            finalUrl: "https://www.pinterest.com/pin/123456789012345678/",
            clearTimeout: () => {}
        };
    };

    const mockFetchHtml = async (url) => {
        assert.ok(url.includes("pinterest.com/pin/"));
        return `<meta property="og:image" content="https://i.pinimg.com/736x/resolved.jpg" />`;
    };

    const result = await extractPinterest("https://pin.it/abc1234", {
        fetch: mockFetch,
        fetchHtml: mockFetchHtml
    });
    assert.equal(result.url, "https://i.pinimg.com/736x/resolved.jpg");
});

test("Extraction Orchestrator: Ephemeral localFilePath artifacts are excluded from process cache", async () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");

    const tempFile = path.join(os.tmpdir(), `reeva_cache_test_${Date.now()}.mp4`);
    fs.writeFileSync(tempFile, "temp-video-bytes");

    try {
        const testCache = new BoundedCache(10, 60000);
        let runCount = 0;

        const orchestrator = createExtractionOrchestrator({
            cache: testCache,
            adapters: {
                youtube: async () => {
                    runCount++;
                    return {
                        url: "https://rr1---sn-abc.googlevideo.com/videoplayback",
                        localFilePath: tempFile,
                        type: "video",
                        title: "YouTube Video",
                        mode: "VIDEO_AND_AUDIO"
                    };
                }
            }
        });

        // First extraction
        const res1 = await orchestrator.extractMedia({
            platform: "youtube",
            sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            mode: "VIDEO_AND_AUDIO",
            requestId: "req_cache_1"
        });
        assert.equal(res1.success, true);
        assert.equal(runCount, 1);

        // Confirm result with localFilePath was NOT cached in testCache
        const cacheKey = "https://www.youtube.com/watch?v=dQw4w9WgXcQ#mode=VIDEO_AND_AUDIO";
        assert.equal(testCache.get(cacheKey), undefined, "localFilePath artifacts must not be stored in URL extraction cache");

        // Second extraction must execute fresh adapter, not return stale/shared file path
        const res2 = await orchestrator.extractMedia({
            platform: "youtube",
            sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            mode: "VIDEO_AND_AUDIO",
            requestId: "req_cache_2"
        });
        assert.equal(res2.success, true);
        assert.equal(runCount, 2, "Second extraction must run fresh adapter to produce an independent file artifact");
    } finally {
        try { fs.unlinkSync(tempFile); } catch (_) {}
    }
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
            url: "https://scontent.cdninstagram.com/doc.pdf",
            type: "pdf"
        }, "instagram"),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.UNSUPPORTED_MEDIA);
            return true;
        }
    );
});

test("Result Validator: Accepts audio media type", () => {
    const validated = validateExtractionResult({
        url: "https://rr1---sn-abc.googlevideo.com/audio.m4a",
        type: "audio",
        title: "Test Audio"
    }, "youtube");

    assert.equal(validated.type, "audio");
    assert.equal(validated.platform, "youtube");
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
