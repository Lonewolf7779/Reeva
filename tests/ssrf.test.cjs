// tests/ssrf.test.cjs — Automated Tests for SSRF & Private Network Controls
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { isPrivateOrBlockedIP, isRestrictedIPv4, isRestrictedIPv6 } = require("../lib/ssrf-filter.cjs");
const { validateSourceUrl, validateMediaUrl, ValidationError } = require("../lib/url-validator.cjs");

test("SSRF Filter: Blocks all forbidden IPv4 ranges", () => {
    const blockedIps = [
        "127.0.0.1",
        "127.0.0.2",
        "127.255.255.255",
        "10.0.0.1",
        "10.254.254.254",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.0.1",
        "192.168.1.1",
        "192.168.254.254",
        "169.254.169.254", // AWS/GCP/Azure IMDS metadata
        "169.254.0.1",
        "0.0.0.0",
        "100.64.0.1", // CGNAT RFC 6598
        "100.127.255.254",
        "192.0.0.1",
        "192.0.2.1", // TEST-NET-1
        "198.18.0.1", // Benchmark
        "198.51.100.1", // TEST-NET-2
        "203.0.113.1", // TEST-NET-3
        "224.0.0.1", // Multicast
        "240.0.0.1", // Reserved
        "255.255.255.255" // Broadcast
    ];

    for (const ip of blockedIps) {
        assert.equal(isPrivateOrBlockedIP(ip), true, `Expected ${ip} to be blocked`);
    }
});

test("SSRF Filter: Allows public IPv4 addresses", () => {
    const publicIps = [
        "8.8.8.8",
        "1.1.1.1",
        "157.240.22.35",
        "142.250.190.46"
    ];

    for (const ip of publicIps) {
        assert.equal(isPrivateOrBlockedIP(ip), false, `Expected ${ip} to be allowed`);
    }
});

test("SSRF Filter: Blocks all forbidden IPv6 ranges", () => {
    const blockedIpv6 = [
        "::1", // Loopback
        "::", // Unspecified
        "::ffff:127.0.0.1", // IPv4-mapped loopback
        "::ffff:169.254.169.254", // IPv4-mapped metadata
        "::ffff:10.0.0.1", // IPv4-mapped private
        "::ffff:192.168.1.1",
        "fc00::1", // ULA
        "fd00::1",
        "fd00:ec2::254", // AWS IMDSv6
        "fe80::1", // Link-local
        "ff02::1" // Multicast
    ];

    for (const ip of blockedIpv6) {
        assert.equal(isPrivateOrBlockedIP(ip), true, `Expected IPv6 ${ip} to be blocked`);
    }
});

test("Protocol Attacks: Rejects non-HTTPS schemes", () => {
    const forbiddenUrls = [
        "http://instagram.com/reel/123",
        "file:///etc/passwd",
        "file:///C:/Windows/win.ini",
        "ftp://instagram.com/files",
        "gopher://127.0.0.1:70/",
        "data:text/html,<script>alert(1)</script>",
        "javascript:alert(1)"
    ];

    for (const url of forbiddenUrls) {
        assert.throws(
            () => validateSourceUrl(url, "instagram"),
            ValidationError,
            `Expected ${url} to be rejected`
        );
    }
});

test("SSRF: Rejects localhost and loopback hostnames", () => {
    const loopbacks = [
        "https://localhost/test",
        "https://127.0.0.1/test",
        "https://127.0.0.1:3000/test",
        "https://169.254.169.254/test",
        "https://10.0.0.1/test",
        "https://192.168.1.1/test",
        "https://172.16.0.1/test",
        "https://[::1]/test"
    ];

    for (const url of loopbacks) {
        assert.throws(
            () => validateSourceUrl(url, "instagram"),
            ValidationError,
            `Expected ${url} to fail validation`
        );
    }
});
