// tests/instagram-fallback.test.cjs — Deterministic Security and Regression Tests for Reeva-Controlled Instagram Fallback
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("stream");
const {
    extractInstagram,
    extractShortcode,
    resolveInstagramShareUrl,
    fetchInstagramCsrfToken,
    fetchInstagramGraphQL,
    extractInstagramNativeFallback
} = require("../lib/extraction/adapters/instagram.cjs");
const { validateSourceUrl, ValidationError } = require("../lib/url-validator.cjs");
const { SecurityHTTPError, secureFetch, ResponseTooLargeError } = require("../lib/http-client.cjs");
const { ExtractionError, EXTRACTION_ERROR_CODES } = require("../lib/extraction/types.cjs");

// Helper to create a readable stream from string
function stringToStream(str) {
    return Readable.from([Buffer.from(str, "utf8")]);
}

// ==============================================================================
// 1. INPUT BOUNDARY TESTS
// ==============================================================================

test("Instagram Input Boundary: Valid Instagram URLs are accepted", () => {
    const valid = [
        "https://www.instagram.com/reel/DA123456789/",
        "https://instagram.com/p/DA123456789/",
        "https://instagr.am/tv/DA123456789/",
        "https://www.instagram.com/reels/DA123456789/?igsh=test123"
    ];
    for (const url of valid) {
        assert.doesNotThrow(() => validateSourceUrl(url, "instagram"));
    }
});

test("Instagram Input Boundary: Non-Instagram domains are rejected", () => {
    const invalid = [
        "https://evil-instagram.com/reel/123",
        "https://instagram.com.attacker.com/reel/123",
        "https://example.com/reel/123"
    ];
    for (const url of invalid) {
        assert.throws(
            () => validateSourceUrl(url, "instagram"),
            (err) => err instanceof ValidationError && err.code === "DISALLOWED_DOMAIN"
        );
    }
});

test("Instagram Input Boundary: Localhost, loopback, and private IPs are rejected", () => {
    const localTargets = [
        "https://localhost/reel/123",
        "https://127.0.0.1/reel/123",
        "https://[::1]/reel/123",
        "https://192.168.1.1/reel/123",
        "https://10.0.0.1/reel/123",
        "https://169.254.169.254/reel/123"
    ];
    for (const url of localTargets) {
        assert.throws(
            () => validateSourceUrl(url, "instagram"),
            (err) => err instanceof ValidationError && err.code === "DISALLOWED_DOMAIN"
        );
    }
});

test("Instagram Input Boundary: Credentials and non-standard ports are rejected", () => {
    assert.throws(
        () => validateSourceUrl("https://user:pass@www.instagram.com/reel/123", "instagram"),
        (err) => err instanceof ValidationError && err.code === "CREDENTIALS_IN_URL"
    );
    assert.throws(
        () => validateSourceUrl("https://www.instagram.com:8443/reel/123", "instagram"),
        (err) => err instanceof ValidationError && err.code === "INVALID_PORT"
    );
});

test("Instagram Input Boundary: Insecure HTTP protocol is rejected", () => {
    assert.throws(
        () => validateSourceUrl("http://www.instagram.com/reel/123", "instagram"),
        (err) => err instanceof ValidationError && err.code === "UNSUPPORTED_PROTOCOL"
    );
});

// ==============================================================================
// 2. SHORTCODE EXTRACTION TESTS
// ==============================================================================

test("Shortcode Extraction: Parses post, reel, tv, reels shortcodes", () => {
    assert.equal(extractShortcode("https://www.instagram.com/reel/DA123456789/"), "DA123456789");
    assert.equal(extractShortcode("https://instagram.com/p/C-xyz_123/?utm_source=ig"), "C-xyz_123");
    assert.equal(extractShortcode("https://instagr.am/tv/B_987#hash"), "B_987");
    assert.equal(extractShortcode("https://www.instagram.com/reels/DA123456789"), "DA123456789");
    assert.equal(extractShortcode("https://www.instagram.com/share/abc/"), null);
    assert.equal(extractShortcode("invalid-url"), null);
});

// ==============================================================================
// 3. REDIRECT SECURITY TESTS (/share resolution)
// ==============================================================================

test("Redirect Security: Allowed Instagram redirect is followed and resolves target", async () => {
    const mockFetchFn = async (url) => {
        return {
            finalUrl: "https://www.instagram.com/reel/DA123456789/",
            abort: () => {},
            clearTimeout: () => {}
        };
    };

    const finalUrl = await resolveInstagramShareUrl("https://www.instagram.com/share/abc123", {
        fetchFn: mockFetchFn
    });
    assert.equal(finalUrl, "https://www.instagram.com/reel/DA123456789/");
    assert.equal(extractShortcode(finalUrl), "DA123456789");
});

test("Redirect Security: secureFetch rejects redirect to external or private destinations", async () => {
    // secureFetch uses real validation on target URLs: test with unapproved domain
    await assert.rejects(
        () => secureFetch("https://evil.com/test", {
            allowedDomains: ["instagram.com"]
        }),
        (err) => err instanceof SecurityHTTPError && err.code === "DISALLOWED_DESTINATION"
    );

    // Test with private IP literal
    await assert.rejects(
        () => secureFetch("https://127.0.0.1/test", {
            allowedDomains: ["instagram.com"]
        }),
        (err) => err instanceof SecurityHTTPError && err.code === "DISALLOWED_DESTINATION"
    );
});

// ==============================================================================
// 4. CSRF TOKEN EXTRACTION TESTS
// ==============================================================================

test("CSRF Token: Extracts token safely from set-cookie header", async () => {
    let streamAborted = false;
    const mockFetchFn = async (url) => {
        return {
            response: {
                headers: {
                    get: (name) => name === "set-cookie" ? "csrftoken=mock_csrf_token_12345; Path=/; Domain=.instagram.com" : null,
                    raw: () => ({ "set-cookie": ["csrftoken=mock_csrf_token_12345; Path=/; Domain=.instagram.com", "mid=abc; Path=/"] })
                }
            },
            abort: () => { streamAborted = true; },
            clearTimeout: () => {}
        };
    };

    const token = await fetchInstagramCsrfToken({ fetchFn: mockFetchFn });
    assert.equal(token, "mock_csrf_token_12345");
    assert.equal(streamAborted, true, "Homepage response stream must be aborted immediately after headers");
});

test("CSRF Token: Handles missing set-cookie gracefully without throwing", async () => {
    const mockFetchFn = async () => ({
        response: { headers: { get: () => null, raw: () => ({}) } },
        abort: () => {},
        clearTimeout: () => {}
    });

    const token = await fetchInstagramCsrfToken({ fetchFn: mockFetchFn });
    assert.equal(token, "");
});

// ==============================================================================
// 5. GRAPHQL QUERY AND RESPONSE SAFETY TESTS
// ==============================================================================

test("GraphQL Query: Valid response parses video candidate and caption", async () => {
    const mockGqlResponse = {
        data: {
            xdt_shortcode_media: {
                __typename: "XDTGraphVideo",
                is_video: true,
                video_url: "https://scontent.cdninstagram.com/v/t50/reel.mp4",
                edge_media_to_caption: {
                    edges: [{ node: { text: "Awesome Reel Title" } }]
                }
            }
        }
    };

    const mockFetchFn = async (url, options) => {
        assert.equal(url, "https://www.instagram.com/graphql/query");
        assert.equal(options.method, "POST");
        assert.ok(options.body.includes("DA123456789"));
        return {
            response: {
                ok: true,
                status: 200,
                body: stringToStream(JSON.stringify(mockGqlResponse))
            },
            abort: () => {},
            clearTimeout: () => {}
        };
    };

    const media = await fetchInstagramGraphQL("DA123456789", { fetchFn: mockFetchFn });
    assert.ok(media);
    assert.equal(media.is_video, true);
    assert.equal(media.video_url, "https://scontent.cdninstagram.com/v/t50/reel.mp4");
});

test("GraphQL Query: Sidecar carousel selects video item over image", async () => {
    const mockGqlResponse = {
        data: {
            xdt_shortcode_media: {
                __typename: "XDTGraphSidecar",
                edge_media_to_caption: { edges: [{ node: { text: "Carousel" } }] },
                edge_sidecar_to_children: {
                    edges: [
                        { node: { is_video: false, display_url: "https://scontent.cdninstagram.com/p1.jpg" } },
                        { node: { is_video: true, video_url: "https://scontent.cdninstagram.com/v/t50/p2.mp4" } }
                    ]
                }
            }
        }
    };

    const mockFetchFn = async () => ({
        response: { ok: true, status: 200, body: stringToStream(JSON.stringify(mockGqlResponse)) },
        abort: () => {},
        clearTimeout: () => {}
    });

    const result = await extractInstagramNativeFallback("https://www.instagram.com/p/DA123456789/", {
        fetchFn: mockFetchFn
    });
    assert.equal(result.url, "https://scontent.cdninstagram.com/v/t50/p2.mp4");
    assert.equal(result.type, "video");
});

test("GraphQL Query: Upstream 401/403/429 status throws SecurityHTTPError", async () => {
    for (const status of [401, 403, 429]) {
        const mockFetchFn = async () => ({
            response: { ok: false, status, body: stringToStream("{}") },
            abort: () => {},
            clearTimeout: () => {}
        });

        await assert.rejects(
            () => fetchInstagramGraphQL("DA123456789", { fetchFn: mockFetchFn }),
            (err) => err instanceof SecurityHTTPError && err.statusCode === status
        );
    }
});

test("GraphQL Query: Malformed JSON throws ExtractionError", async () => {
    const mockFetchFn = async () => ({
        response: { ok: true, status: 200, body: stringToStream("NOT_JSON") },
        abort: () => {},
        clearTimeout: () => {}
    });

    await assert.rejects(
        () => fetchInstagramGraphQL("DA123456789", { fetchFn: mockFetchFn }),
        (err) => err instanceof ExtractionError && err.code === EXTRACTION_ERROR_CODES.EXTRACTION_FAILED
    );
});

// ==============================================================================
// 6. CANCELLATION AND TIMEOUT TESTS
// ==============================================================================

test("Cancellation: Pre-aborted signal aborts immediately before any request", async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        () => extractInstagramNativeFallback("https://www.instagram.com/reel/DA123456789/", {
            signal: controller.signal
        }),
        (err) => err instanceof ExtractionError && err.code === EXTRACTION_ERROR_CODES.PROVIDER_TIMEOUT
    );
});

test("Cancellation: Signal abort during request terminates execution cleanly", async () => {
    const controller = new AbortController();

    const mockFetchFn = async (url, options) => {
        if (options.signal) {
            return new Promise((_, reject) => {
                options.signal.addEventListener("abort", () => {
                    reject(new SecurityHTTPError("Request aborted by client.", 499, "CLIENT_ABORTED"));
                });
            });
        }
        return { response: {}, abort: () => {}, clearTimeout: () => {} };
    };

    const fallbackPromise = extractInstagramNativeFallback("https://www.instagram.com/reel/DA123456789/", {
        signal: controller.signal,
        fetchFn: mockFetchFn
    });

    setTimeout(() => {
        controller.abort();
    }, 20);

    await assert.rejects(
        () => fallbackPromise,
        (err) => err instanceof SecurityHTTPError && err.code === "CLIENT_ABORTED"
    );
});

// ==============================================================================
// 7. OUTPUT SECURITY TESTS
// ==============================================================================

test("Output Security: Candidate URL from unapproved domain is rejected by validateMediaUrl", async () => {
    const mockGqlResponse = {
        data: {
            xdt_shortcode_media: {
                is_video: true,
                video_url: "https://evil-unapproved.com/video.mp4"
            }
        }
    };

    const mockFetchFn = async () => ({
        response: { ok: true, status: 200, body: stringToStream(JSON.stringify(mockGqlResponse)) },
        abort: () => {},
        clearTimeout: () => {}
    });

    await assert.rejects(
        () => extractInstagramNativeFallback("https://www.instagram.com/reel/DA123456789/", {
            fetchFn: mockFetchFn
        }),
        (err) => err instanceof ValidationError && err.code === "UNAPPROVED_MEDIA_DOMAIN"
    );
});

test("Output Security: Candidate URL with private IP is rejected by validateMediaUrl", async () => {
    const mockGqlResponse = {
        data: {
            xdt_shortcode_media: {
                is_video: true,
                video_url: "https://127.0.0.1/video.mp4"
            }
        }
    };

    const mockFetchFn = async () => ({
        response: { ok: true, status: 200, body: stringToStream(JSON.stringify(mockGqlResponse)) },
        abort: () => {},
        clearTimeout: () => {}
    });

    await assert.rejects(
        () => extractInstagramNativeFallback("https://www.instagram.com/reel/DA123456789/", {
            fetchFn: mockFetchFn
        }),
        (err) => err instanceof ValidationError && err.code === "UNAPPROVED_MEDIA_DOMAIN"
    );
});

// ==============================================================================
// 8. E2E EXTRACTION INTEGRATION TESTS (Primary HTML failure -> Native fallback)
// ==============================================================================

test("Instagram E2E Fallback: Primary HTML yields no media -> Native fallback succeeds", async () => {
    const mockGqlResponse = {
        data: {
            xdt_shortcode_media: {
                is_video: true,
                video_url: "https://scontent.cdninstagram.com/v/t50/fallback_reel.mp4",
                edge_media_to_caption: { edges: [{ node: { text: "Native Fallback Reel" } }] }
            }
        }
    };

    const mockFetchFn = async (url) => {
        if (url === "https://www.instagram.com/") {
            return {
                response: { headers: { get: () => "csrftoken=valid_token; Path=/" } },
                abort: () => {},
                clearTimeout: () => {}
            };
        }
        return {
            response: { ok: true, status: 200, body: stringToStream(JSON.stringify(mockGqlResponse)) },
            abort: () => {},
            clearTimeout: () => {}
        };
    };

    // Primary HTML returns empty page (no og:video/og:image)
    const result = await extractInstagram("https://www.instagram.com/reel/DA123456789/", {
        fetchHtml: async () => "<html><head><title>Instagram</title></head><body></body></html>",
        fetchFn: mockFetchFn
    });

    assert.equal(result.url, "https://scontent.cdninstagram.com/v/t50/fallback_reel.mp4");
    assert.equal(result.type, "video");
    assert.equal(result.title, "Native Fallback Reel");
});
