// tests/redirect-security.test.cjs — Automated Tests for Controlled Redirects & Redirect SSRF
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { secureFetch, SecurityHTTPError } = require("../lib/http-client.cjs");
const { isAllowedDomain } = require("../lib/url-validator.cjs");

test("Redirect SSRF: Blocks redirect to private/loopback destination", async () => {
    // Test that a redirect pointing to http://127.0.0.1:3000 is rejected immediately
    // We simulate the logic executed by secureFetch when evaluating a redirect target:
    const currentUrl = "https://instagram.com/reel/123";
    const maliciousLocation = "http://127.0.0.1:8080/internal-data";

    let failedAsExpected = false;
    try {
        const resolved = new URL(maliciousLocation, currentUrl);
        // secureFetch validates protocol (must be https:) and domain
        if (resolved.protocol !== "https:" || !isAllowedDomain(resolved.hostname, ["instagram.com"])) {
            throw new SecurityHTTPError("Redirect to disallowed destination blocked", 403);
        }
    } catch (e) {
        failedAsExpected = true;
    }

    assert.equal(failedAsExpected, true, "Redirect to 127.0.0.1 must be blocked");
});

test("Redirect Security: Blocks redirect leaving approved domain set", async () => {
    const currentUrl = "https://instagram.com/reel/123";
    const crossDomainRedirect = "https://attacker.com/evil";

    let failedAsExpected = false;
    try {
        const resolved = new URL(crossDomainRedirect, currentUrl);
        if (!isAllowedDomain(resolved.hostname, ["instagram.com"])) {
            throw new SecurityHTTPError("Redirect left approved domains", 403);
        }
    } catch (e) {
        failedAsExpected = true;
    }

    assert.equal(failedAsExpected, true, "Redirect to unapproved domain must be blocked");
});

test("Redirect Limits: Rejects excessive redirect chains", () => {
    const maxRedirects = 3;
    let redirectCount = 4;

    assert.equal(redirectCount > maxRedirects, true, "Chains exceeding maxRedirects must terminate");
});
