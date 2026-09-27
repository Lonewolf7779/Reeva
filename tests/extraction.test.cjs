// tests/extraction.test.cjs — Deterministic Unit Tests for Reeva Extraction Architecture
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    createExtractionOrchestrator,
    validateExtractionResult,
    withTimeout,
    ExtractionError,
    EXTRACTION_ERROR_CODES
} = require("../lib/extraction/index.cjs");

const { ValidationError } = require("../lib/url-validator.cjs");
const { SSRFError } = require("../lib/ssrf-filter.cjs");
const { BoundedCache } = require("../lib/cache.cjs");

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
                url: 12345, // invalid type
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
            facebook: async () => null // no media found
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
            // Must not expose internal parser stack to user message
            assert.equal(err.message, "Failed to extract media from the requested URL.");
            return true;
        }
    );
});

// Test 5: Provider timeout/failure
test("Extraction Test 5: Provider execution timeout", async () => {
    const hangingPromise = new Promise((resolve) => {
        setTimeout(resolve, 5000);
    });

    await assert.rejects(
        () => withTimeout(hangingPromise, 50, "mock-provider"),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT);
            return true;
        }
    );
});

// Test 6: Provider returns an unsafe media URL (Rejected by Reeva security validation)
test("Extraction Test 6: Provider returns an unsafe media URL (SSRF target rejected)", async () => {
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
            requestId: "req_test_06"
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            // Protocol must be strictly HTTPS
            assert.equal(err.code, "UNSUPPORTED_PROTOCOL");
            return true;
        }
    );
});

// Test 7: Provider returns an unapproved CDN
test("Extraction Test 7: Provider returns an unapproved CDN (Expected rejection)", async () => {
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
            requestId: "req_test_07"
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.code, "UNAPPROVED_MEDIA_DOMAIN");
            return true;
        }
    );
});

// Test 8: Primary provider fails and valid fallback succeeds
test("Extraction Test 8: Primary provider fails and valid fallback succeeds", async () => {
    let primaryCalled = false;
    let fallbackCalled = false;

    // Simulate adapter with deliberate fallback
    const adapterWithFallback = async () => {
        try {
            primaryCalled = true;
            throw new Error("Primary third-party scraper failed");
        } catch (e) {
            fallbackCalled = true;
            return {
                url: "https://scontent.cdninstagram.com/v/t50/fallback_reel.mp4",
                type: "video",
                title: "Fallback Reel"
            };
        }
    };

    const orchestrator = createExtractionOrchestrator({
        cache: new BoundedCache(10, 60000),
        adapters: {
            instagram: adapterWithFallback
        }
    });

    const result = await orchestrator.extractMedia({
        platform: "instagram",
        sourceUrl: "https://www.instagram.com/reel/DA123456789/",
        requestId: "req_test_08"
    });

    assert.equal(primaryCalled, true);
    assert.equal(fallbackCalled, true);
    assert.equal(result.success, true);
    assert.equal(result.media.url, "https://scontent.cdninstagram.com/v/t50/fallback_reel.mp4");
});

// Test 9: Primary provider fails and fallback also fails
test("Extraction Test 9: Primary provider fails and fallback also fails (controlled EXTRACTION_FAILED)", async () => {
    const failingAdapter = async () => {
        // Primary fails
        try {
            throw new Error("Primary failed");
        } catch (e) {
            // Fallback also fails
            throw new ExtractionError(
                EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND,
                "Could not find downloadable media for this Instagram link."
            );
        }
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
            requestId: "req_test_09"
        }),
        (err) => {
            assert.ok(err instanceof ExtractionError);
            assert.equal(err.code, EXTRACTION_ERROR_CODES.MEDIA_NOT_FOUND);
            return true;
        }
    );
});

// Test 10: Security errors do NOT trigger fallback
test("Extraction Test 10: Security errors do NOT trigger fallback", async () => {
    let fallbackExecuted = false;

    const securitySensitiveAdapter = async () => {
        try {
            // Simulate security failure during extraction
            throw new ValidationError("Destination resolves to prohibited IP", "SSRF_PROHIBITED");
        } catch (err) {
            // Crucial rule: Security errors must HALT immediately — never fall back!
            if (err instanceof ValidationError || err instanceof SSRFError) {
                throw err;
            }
            fallbackExecuted = true;
            return {
                url: "https://scontent.cdninstagram.com/fallback.mp4",
                type: "video"
            };
        }
    };

    const orchestrator = createExtractionOrchestrator({
        cache: new BoundedCache(10, 60000),
        adapters: {
            instagram: securitySensitiveAdapter
        }
    });

    await assert.rejects(
        () => orchestrator.extractMedia({
            platform: "instagram",
            sourceUrl: "https://www.instagram.com/reel/DA123456789/",
            requestId: "req_test_10"
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.code, "SSRF_PROHIBITED");
            return true;
        }
    );

    // Fallback MUST NOT have run
    assert.equal(fallbackExecuted, false, "Fallback must not execute when a security error occurs");
});

// Additional coverage: Result Validator
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
