// tests/url-validator.test.cjs — Automated Tests for URL Validation & Hostname Bypasses
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    validatePlatform,
    validateSourceUrl,
    validateMediaUrl,
    isAllowedDomain,
    ValidationError
} = require("../lib/url-validator.cjs");

test("Hostname Bypasses: Rejects suffix, prefix, and parser collision attacks", () => {
    const maliciousCases = [
        "https://instagram.com.attacker.com/p/123",
        "https://attackerinstagram.com/p/123",
        "https://fake-instagram.com/p/123",
        "https://instagram.com@attacker.com/p/123",
        "https://attacker.com/?redirect=https://instagram.com",
        "https://facebook.com.evil.io/watch",
        "https://evilfacebook.com/video",
        "https://twitter.com.attacker.com/status/1",
        "https://eviltwitter.com/status/1",
        "https://youtube.com.attacker.com/watch?v=1",
        "https://fakeyoutube.com/watch?v=1",
        "https://pin.it.attacker.com/pin/1",
        "https://attacker-pinterest.com/pin/1"
    ];

    for (const url of maliciousCases) {
        assert.throws(
            () => validateSourceUrl(url, "instagram"),
            ValidationError,
            `Expected ${url} to be rejected as an unapproved hostname`
        );
    }
});

test("Credentials and Port Injection: Rejects userinfo and non-standard ports", () => {
    assert.throws(
        () => validateSourceUrl("https://admin:secret@instagram.com/p/123", "instagram"),
        ValidationError
    );

    assert.throws(
        () => validateSourceUrl("https://instagram.com:8080/p/123", "instagram"),
        ValidationError
    );

    assert.throws(
        () => validateSourceUrl("https://instagram.com:22/p/123", "instagram"),
        ValidationError
    );
});

test("Platform Validation: Allows only explicit supported platforms", () => {
    const valid = ["instagram", "facebook", "twitter", "x", "pinterest", "youtube"];
    for (const p of valid) {
        assert.equal(typeof validatePlatform(p), "string");
    }

    const invalid = ["tiktok", "reddit", "linkedin", "snapchat", "telegram", "../../etc", ""];
    for (const p of invalid) {
        assert.throws(() => validatePlatform(p), ValidationError);
    }
});

test("Input Validation: Handles length and malformed strings", () => {
    assert.throws(() => validateSourceUrl("", "instagram"), ValidationError);
    assert.throws(() => validateSourceUrl("   ", "instagram"), ValidationError);
    assert.throws(() => validateSourceUrl(null, "instagram"), ValidationError);
    assert.throws(() => validateSourceUrl(undefined, "instagram"), ValidationError);
    assert.throws(() => validateSourceUrl("not-a-url", "instagram"), ValidationError);

    // Overly long URL (> 2048 chars)
    const longUrl = "https://instagram.com/p/" + "a".repeat(2100);
    assert.throws(() => validateSourceUrl(longUrl, "instagram"), ValidationError);
});

test("Media Allowlist: Rejects arbitrary and unapproved media destinations", () => {
    const unapprovedMediaUrls = [
        "https://attacker.com/video.mp4",
        "https://evil.net/media.jpg",
        "https://cdninstagram.com.evil.com/video.mp4",
        "https://googlevideo.com.attacker.com/videoplayback",
        "https://fbcdn.net.attacker.com/v/t39.123/video.mp4"
    ];

    for (const url of unapprovedMediaUrls) {
        assert.throws(
            () => validateMediaUrl(url),
            ValidationError,
            `Expected unapproved media URL ${url} to be rejected`
        );
    }

    // Approved media destinations
    const validMedia = [
        "https://scontent.cdninstagram.com/v/t50/video.mp4",
        "https://video.twimg.com/ext_tw_video/123/pu/vid/720x1280/video.mp4",
        "https://v.pinimg.com/videos/mc/720p/video.mp4",
        "https://rr1---sn-4g5ednls.googlevideo.com/videoplayback"
    ];

    for (const url of validMedia) {
        const parsed = validateMediaUrl(url);
        assert.equal(typeof parsed.hostname, "string");
    }
});
