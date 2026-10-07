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
const { SSRFError } = require("../lib/ssrf-filter.cjs");
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

test("Cancellation: Pre-aborted signal produces CLIENT_ABORTED with zero network operations", async () => {
    const controller = new AbortController();
    controller.abort();
    let networkCalls = 0;

    const mockFetchFn = async () => {
        networkCalls++;
        return { response: {}, abort: () => {}, clearTimeout: () => {} };
    };

    await assert.rejects(
        () => extractInstagramNativeFallback("https://www.instagram.com/reel/DA123456789/", {
            signal: controller.signal,
            fetchFn: mockFetchFn
        }),
        (err) => err instanceof SecurityHTTPError && err.code === "CLIENT_ABORTED"
    );

    assert.equal(networkCalls, 0, "No network operations should be initiated when signal is pre-aborted");
});

test("Cancellation: Abort during CSRF terminates request and GraphQL does not start", async () => {
    const controller = new AbortController();
    let csrfStarted = false;
    let gqlStarted = false;

    const mockFetchFn = async (url, options) => {
        if (url === "https://www.instagram.com/") {
            csrfStarted = true;
            return new Promise((_, reject) => {
                if (options.signal) {
                    options.signal.addEventListener("abort", () => {
                        reject(new SecurityHTTPError("Request aborted by client.", 499, "CLIENT_ABORTED"));
                    }, { once: true });
                }
            });
        }
        if (url.includes("/graphql/query")) {
            gqlStarted = true;
            return { response: {}, abort: () => {}, clearTimeout: () => {} };
        }
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

    assert.equal(csrfStarted, true, "CSRF request should have started");
    assert.equal(gqlStarted, false, "GraphQL request must NEVER start when aborted during CSRF");
});

test("Cancellation: Abort between CSRF and GraphQL prevents GraphQL from starting", async () => {
    const controller = new AbortController();
    let gqlStarted = false;

    const mockFetchFn = async (url) => {
        if (url === "https://www.instagram.com/") {
            controller.abort();
            return {
                response: { headers: { get: () => "csrftoken=token123;" } },
                abort: () => {},
                clearTimeout: () => {}
            };
        }
        if (url.includes("/graphql/query")) {
            gqlStarted = true;
            return { response: {}, abort: () => {}, clearTimeout: () => {} };
        }
    };

    await assert.rejects(
        () => extractInstagramNativeFallback("https://www.instagram.com/reel/DA123456789/", {
            signal: controller.signal,
            fetchFn: mockFetchFn
        }),
        (err) => err instanceof SecurityHTTPError && err.code === "CLIENT_ABORTED"
    );

    assert.equal(gqlStarted, false, "GraphQL request must NOT start if aborted between phases");
});

test("Overall Deadline: Fallback terminates within overall budget when CSRF consumes budget", async () => {
    const totalBudget = 100;

    const mockFetchFn = async (url, options) => {
        if (url === "https://www.instagram.com/") {
            // CSRF takes 60ms of the 100ms budget
            await new Promise((r) => setTimeout(r, 60));
            return {
                response: { headers: { get: () => "csrftoken=mock_token;" } },
                abort: () => {},
                clearTimeout: () => {}
            };
        }
        if (url.includes("/graphql/query")) {
            // Budget remaining should be bounded
            assert.ok(options.timeoutMs <= 50, `GraphQL timeoutMs (${options.timeoutMs}) should reflect remaining budget`);
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, 100);
                if (options.timeoutMs) {
                    setTimeout(() => {
                        clearTimeout(timer);
                        reject(new SecurityHTTPError(`Request timed out after ${options.timeoutMs}ms.`, 504, "TIMEOUT"));
                    }, options.timeoutMs);
                }
            });
            return {
                response: { ok: true, status: 200, body: stringToStream("{}") },
                abort: () => {},
                clearTimeout: () => {}
            };
        }
    };

    const start = Date.now();
    await assert.rejects(
        () => extractInstagramNativeFallback("https://www.instagram.com/reel/DA123456789/", {
            timeoutMs: totalBudget,
            fetchFn: mockFetchFn
        }),
        (err) => err instanceof SecurityHTTPError && err.code === "TIMEOUT"
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `Elapsed time (${elapsed}ms) must remain bounded by overall budget`);
});

test("Overall Deadline: Sequential operations do not each receive the full timeoutMs", async () => {
    const receivedTimeouts = [];

    const mockFetchFn = async (url, options) => {
        receivedTimeouts.push({ url, timeoutMs: options.timeoutMs });
        if (url === "https://www.instagram.com/") {
            await new Promise((r) => setTimeout(r, 150));
            return {
                response: { headers: { get: () => "csrftoken=test_token;" } },
                abort: () => {},
                clearTimeout: () => {}
            };
        }
        if (url.includes("/graphql/query")) {
            const mockGql = {
                data: {
                    xdt_shortcode_media: {
                        is_video: true,
                        video_url: "https://scontent.cdninstagram.com/v/t50/test.mp4"
                    }
                }
            };
            return {
                response: { ok: true, status: 200, body: stringToStream(JSON.stringify(mockGql)) },
                abort: () => {},
                clearTimeout: () => {}
            };
        }
    };

    await extractInstagramNativeFallback("https://www.instagram.com/reel/DA123456789/", {
        timeoutMs: 1000,
        fetchFn: mockFetchFn
    });

    assert.equal(receivedTimeouts.length, 2);
    assert.ok(receivedTimeouts[0].timeoutMs <= 1000);
    assert.ok(
        receivedTimeouts[1].timeoutMs <= 860,
        `GraphQL timeoutMs (${receivedTimeouts[1].timeoutMs}) must be decreased by time consumed by CSRF (~150ms)`
    );
    assert.ok(
        receivedTimeouts[1].timeoutMs < receivedTimeouts[0].timeoutMs,
        "Subsequent operation must have strictly less timeout than initial operation"
    );
});

test("Security vs Timeout: Security violations remain security errors and are not converted to timeout", async () => {
    // 1. SSRFError must remain SSRFError
    const mockSsrfFetch = async () => {
        throw new SSRFError("Target resolves to private network address.");
    };

    await assert.rejects(
        () => extractInstagramNativeFallback("https://www.instagram.com/reel/DA123456789/", {
            fetchFn: mockSsrfFetch
        }),
        (err) => {
            assert.ok(err instanceof SSRFError);
            assert.notEqual(err.code, "TIMEOUT");
            return true;
        }
    );

    // 2. DISALLOWED_DESTINATION must remain SecurityHTTPError with DISALLOWED_DESTINATION
    const mockDisallowedFetch = async () => {
        throw new SecurityHTTPError("Destination host is not in the approved allowlist.", 403, "DISALLOWED_DESTINATION");
    };

    await assert.rejects(
        () => extractInstagramNativeFallback("https://www.instagram.com/reel/DA123456789/", {
            fetchFn: mockDisallowedFetch
        }),
        (err) => {
            assert.ok(err instanceof SecurityHTTPError);
            assert.equal(err.code, "DISALLOWED_DESTINATION");
            return true;
        }
    );

    // 3. Unapproved CDN must remain ValidationError with UNAPPROVED_MEDIA_DOMAIN
    const mockGqlUnapproved = {
        data: {
            xdt_shortcode_media: {
                is_video: true,
                video_url: "https://evil-unapproved.com/video.mp4"
            }
        }
    };
    const mockFetchUnapproved = async (url) => {
        if (url === "https://www.instagram.com/") {
            return {
                response: { headers: { get: () => "csrftoken=token;" } },
                abort: () => {},
                clearTimeout: () => {}
            };
        }
        return {
            response: { ok: true, status: 200, body: stringToStream(JSON.stringify(mockGqlUnapproved)) },
            abort: () => {},
            clearTimeout: () => {}
        };
    };

    await assert.rejects(
        () => extractInstagramNativeFallback("https://www.instagram.com/reel/DA123456789/", {
            fetchFn: mockFetchUnapproved
        }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.code, "UNAPPROVED_MEDIA_DOMAIN");
            return true;
        }
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
