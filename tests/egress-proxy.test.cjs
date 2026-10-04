// tests/egress-proxy.test.cjs — Deterministic Security Tests for yt-dlp Egress Proxy
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");
const fs = require("fs");
const {
    ALLOWED_PORTS,
    MAX_CONCURRENT_CONNECTIONS,
    EgressSecurityError,
    isLoopbackClient,
    isInternalHostname,
    parseConnectTarget,
    validateEgressDestination,
    createEgressProxy,
    ensureEgressProxy,
    stopDefaultEgressProxy
} = require("../lib/extraction/egress-proxy.cjs");
const { validateGenericSourceUrl, ValidationError } = require("../lib/url-validator.cjs");
const { extractGeneric } = require("../lib/extraction/adapters/generic.cjs");
const { ExtractionError } = require("../lib/extraction/types.cjs");
const { defaultCommandRunner } = require("../lib/extraction/adapters/youtube.cjs");

// Helper to send raw HTTP/CONNECT requests over a TCP socket
function sendRawSocketRequest(port, rawRequest) {
    return new Promise((resolve, reject) => {
        let finished = false;
        const client = net.createConnection({ host: "127.0.0.1", port }, () => {
            client.write(rawRequest);
        });

        let data = "";
        client.on("data", chunk => {
            data += chunk.toString("utf8");
            if (data.includes("\r\n\r\n") && (data.includes("Forbidden") || data.includes("Bad Request") || data.includes("Connection Established") || data.includes("Connection: close"))) {
                if (!finished) {
                    finished = true;
                    client.destroy();
                    resolve(data);
                }
            }
        });
        client.on("end", () => {
            if (!finished) {
                finished = true;
                resolve(data);
            }
        });
        client.on("error", (err) => {
            if (!finished) {
                finished = true;
                reject(err);
            }
        });
    });
}

// ==============================================================================
// 1. SOURCE VALIDATION TESTS (URL level)
// ==============================================================================

test("Egress Source: Public hostname accepted", async () => {
    const url = "https://commons.wikimedia.org/wiki/File:Example.webm";
    const res = await validateGenericSourceUrl(url);
    assert.equal(res, url);
});

test("Egress Source: Private IP rejected", async () => {
    await assert.rejects(
        () => validateGenericSourceUrl("https://192.168.1.1/video.mp4"),
        ValidationError
    );
});

test("Egress Source: Localhost rejected", async () => {
    await assert.rejects(
        () => validateGenericSourceUrl("https://localhost/video.mp4"),
        ValidationError
    );
});

test("Egress Source: Metadata IP rejected", async () => {
    await assert.rejects(
        () => validateGenericSourceUrl("https://169.254.169.254/video.mp4"),
        ValidationError
    );
});

// ==============================================================================
// 2. EGRESS DESTINATION VALIDATION TESTS (Target host and port level)
// ==============================================================================

test("Egress Destination: Public destination allowed", async () => {
    await assert.doesNotReject(
        () => validateEgressDestination("commons.wikimedia.org", 443)
    );
    await assert.doesNotReject(
        () => validateEgressDestination("commons.wikimedia.org", 80)
    );
});

test("Egress Destination: Loopback destination blocked", async () => {
    await assert.rejects(
        () => validateEgressDestination("127.0.0.1", 80),
        (err) => err instanceof EgressSecurityError && err.code === "RESTRICTED_IP"
    );
    await assert.rejects(
        () => validateEgressDestination("localhost", 443),
        (err) => err instanceof EgressSecurityError && err.code === "RESTRICTED_DOMAIN"
    );
});

test("Egress Destination: RFC1918 private IP blocked", async () => {
    const privateIps = ["10.0.0.1", "172.16.0.1", "192.168.1.100"];
    for (const ip of privateIps) {
        await assert.rejects(
            () => validateEgressDestination(ip, 443),
            (err) => err instanceof EgressSecurityError && err.code === "RESTRICTED_IP",
            `Expected ${ip} to be blocked`
        );
    }
});

test("Egress Destination: Link-local and cloud metadata blocked", async () => {
    await assert.rejects(
        () => validateEgressDestination("169.254.169.254", 80),
        (err) => err instanceof EgressSecurityError && err.code === "RESTRICTED_IP"
    );
    await assert.rejects(
        () => validateEgressDestination("169.254.1.1", 443),
        (err) => err instanceof EgressSecurityError && err.code === "RESTRICTED_IP"
    );
});

test("Egress Destination: IPv6 loopback blocked", async () => {
    await assert.rejects(
        () => validateEgressDestination("::1", 443),
        (err) => err instanceof EgressSecurityError && err.code === "RESTRICTED_IP"
    );
});

test("Egress Destination: IPv6 ULA blocked", async () => {
    await assert.rejects(
        () => validateEgressDestination("fc00::1", 443),
        (err) => err instanceof EgressSecurityError && err.code === "RESTRICTED_IP"
    );
});

test("Egress Destination: Unsafe ports blocked", async () => {
    const unsafePorts = [22, 25, 3000, 5432, 6379, 8080, 8443, 27017];
    for (const port of unsafePorts) {
        await assert.rejects(
            () => validateEgressDestination("commons.wikimedia.org", port),
            (err) => err instanceof EgressSecurityError && err.code === "FORBIDDEN_PORT",
            `Expected port ${port} to be forbidden`
        );
    }
});

// ==============================================================================
// 3. HTTPS CONNECT TUNNELING TESTS
// ==============================================================================

test("Egress CONNECT: Private IP CONNECT blocked with 403", async () => {
    const proxy = await createEgressProxy();
    try {
        const rawReq = "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n";
        const response = await sendRawSocketRequest(proxy.port, rawReq);
        assert.ok(response.includes("403 Forbidden"), `Expected 403 Forbidden, got: ${response}`);
        assert.ok(response.includes("restricted IP"));
    } finally {
        await proxy.close();
    }
});

test("Egress CONNECT: Localhost CONNECT blocked with 403", async () => {
    const proxy = await createEgressProxy();
    try {
        const rawReq = "CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n";
        const response = await sendRawSocketRequest(proxy.port, rawReq);
        assert.ok(response.includes("403 Forbidden"));
        assert.ok(response.includes("internal or loopback domain"));
    } finally {
        await proxy.close();
    }
});

test("Egress CONNECT: Metadata service CONNECT blocked with 403", async () => {
    const proxy = await createEgressProxy();
    try {
        const rawReq = "CONNECT 169.254.169.254:443 HTTP/1.1\r\nHost: 169.254.169.254:443\r\n\r\n";
        const response = await sendRawSocketRequest(proxy.port, rawReq);
        assert.ok(response.includes("403 Forbidden"));
    } finally {
        await proxy.close();
    }
});

test("Egress CONNECT: RFC1918 CONNECT blocked with 403", async () => {
    const proxy = await createEgressProxy();
    try {
        const rawReq = "CONNECT 10.0.0.1:443 HTTP/1.1\r\nHost: 10.0.0.1:443\r\n\r\n";
        const response = await sendRawSocketRequest(proxy.port, rawReq);
        assert.ok(response.includes("403 Forbidden"));
    } finally {
        await proxy.close();
    }
});

test("Egress CONNECT: IPv6 loopback CONNECT blocked with 403", async () => {
    const proxy = await createEgressProxy();
    try {
        const rawReq = "CONNECT [::1]:443 HTTP/1.1\r\nHost: [::1]:443\r\n\r\n";
        const response = await sendRawSocketRequest(proxy.port, rawReq);
        assert.ok(response.includes("403 Forbidden"));
    } finally {
        await proxy.close();
    }
});

test("Egress CONNECT: Unsafe port CONNECT blocked with 403", async () => {
    const proxy = await createEgressProxy();
    try {
        const rawReq = "CONNECT commons.wikimedia.org:3000 HTTP/1.1\r\nHost: commons.wikimedia.org:3000\r\n\r\n";
        const response = await sendRawSocketRequest(proxy.port, rawReq);
        assert.ok(response.includes("403 Forbidden"));
        assert.ok(response.includes("port 3000 is forbidden"));
    } finally {
        await proxy.close();
    }
});

// ==============================================================================
// 4. CLEARTEXT HTTP PROXY FORWARDING TESTS
// ==============================================================================

test("Egress HTTP Proxy: Blocks loopback and private IP requests", async () => {
    const proxy = await createEgressProxy();
    try {
        const rawReq = "GET http://127.0.0.1:80/secret HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        const response = await sendRawSocketRequest(proxy.port, rawReq);
        assert.ok(response.includes("403 Forbidden"));
        assert.ok(response.includes("Egress destination blocked"));
    } finally {
        await proxy.close();
    }
});

test("Egress HTTP Proxy: Blocks metadata IP requests", async () => {
    const proxy = await createEgressProxy();
    try {
        const rawReq = "GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n";
        const response = await sendRawSocketRequest(proxy.port, rawReq);
        assert.ok(response.includes("403 Forbidden"));
    } finally {
        await proxy.close();
    }
});

test("Egress HTTP Proxy: Blocks forbidden ports", async () => {
    const proxy = await createEgressProxy();
    try {
        const rawReq = "GET http://commons.wikimedia.org:8080/data HTTP/1.1\r\nHost: commons.wikimedia.org:8080\r\n\r\n";
        const response = await sendRawSocketRequest(proxy.port, rawReq);
        assert.ok(response.includes("403 Forbidden"));
        assert.ok(response.includes("port 8080 is forbidden"));
    } finally {
        await proxy.close();
    }
});

// ==============================================================================
// 5. REDIRECT INTERCEPTION & PROTECTION TESTS
// ==============================================================================

test("Egress Redirects: Blocks redirect from public source to 127.0.0.1 internal server", async () => {
    let secretAccessed = false;

    // Secret internal server that must never be reached
    const secretServer = http.createServer((req, res) => {
        secretAccessed = true;
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("INTERNAL_SECRET_DATA");
    });
    await new Promise(r => secretServer.listen(0, "127.0.0.1", r));
    const secretPort = secretServer.address().port;

    const proxy = await createEgressProxy();

    try {
        // Request directed at secret server through proxy (as happens when a 302 is followed)
        const redirectedReq = `GET http://127.0.0.1:${secretPort}/secret HTTP/1.1\r\nHost: 127.0.0.1:${secretPort}\r\n\r\n`;
        const res = await sendRawSocketRequest(proxy.port, redirectedReq);

        assert.ok(res.includes("403 Forbidden"), `Expected 403 Forbidden, got: ${res}`);
        assert.equal(secretAccessed, false, "Internal secret server was reached through proxy redirect!");
    } finally {
        secretServer.close();
        await proxy.close();
    }
});

test("Egress Redirects: Blocks redirect to metadata service (169.254.169.254)", async () => {
    const proxy = await createEgressProxy();
    try {
        const redirectedReq = "GET http://169.254.169.254/latest/meta-data/ HTTP/1.1\r\nHost: 169.254.169.254\r\n\r\n";
        const res = await sendRawSocketRequest(proxy.port, redirectedReq);
        assert.ok(res.includes("403 Forbidden"));
    } finally {
        await proxy.close();
    }
});

test("Egress Redirects: Blocks redirect to RFC1918 address", async () => {
    const proxy = await createEgressProxy();
    try {
        const redirectedReq = "GET http://10.1.2.3:80/internal.mp4 HTTP/1.1\r\nHost: 10.1.2.3\r\n\r\n";
        const res = await sendRawSocketRequest(proxy.port, redirectedReq);
        assert.ok(res.includes("403 Forbidden"));
    } finally {
        await proxy.close();
    }
});

test("Egress Redirects: Blocks redirect to IPv6 loopback", async () => {
    const proxy = await createEgressProxy();
    try {
        const redirectedReq = "GET http://[::1]:80/secret HTTP/1.1\r\nHost: [::1]\r\n\r\n";
        const res = await sendRawSocketRequest(proxy.port, redirectedReq);
        assert.ok(res.includes("403 Forbidden"));
    } finally {
        await proxy.close();
    }
});

test("Egress Redirects: Blocks redirect to 192.168.x.x RFC1918 address", async () => {
    const proxy = await createEgressProxy();
    try {
        const redirectedReq = "GET http://192.168.1.1:80/admin HTTP/1.1\r\nHost: 192.168.1.1\r\n\r\n";
        const res = await sendRawSocketRequest(proxy.port, redirectedReq);
        assert.ok(res.includes("403 Forbidden"));
    } finally {
        await proxy.close();
    }
});

test("Egress Redirects: Blocks redirect to HTTPS 127.0.0.1 loopback via CONNECT", async () => {
    const proxy = await createEgressProxy();
    try {
        const rawReq = "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n";
        const res = await sendRawSocketRequest(proxy.port, rawReq);
        assert.ok(res.includes("403 Forbidden"));
    } finally {
        await proxy.close();
    }
});

test("Egress Redirects: Blocks redirect to HTTPS [::1] IPv6 loopback via CONNECT", async () => {
    const proxy = await createEgressProxy();
    try {
        const rawReq = "CONNECT [::1]:443 HTTP/1.1\r\nHost: [::1]:443\r\n\r\n";
        const res = await sendRawSocketRequest(proxy.port, rawReq);
        assert.ok(res.includes("403 Forbidden"));
    } finally {
        await proxy.close();
    }
});

// ==============================================================================
// 6. PROCESS SECURITY & YT-DLP INTEGRATION
// ==============================================================================

test("Process Security: Generic extraction passes --proxy flag pointing to loopback egress proxy", async () => {
    let capturedArgs = [];
    const capturingRunner = async ({ args }) => {
        capturedArgs = args;
        const outIdx = args.indexOf("-o");
        if (outIdx !== -1 && args[outIdx + 1]) {
            fs.writeFileSync(args[outIdx + 1], Buffer.alloc(1024));
        }
        return {
            exitCode: 0,
            stdout: JSON.stringify({
                id: "test_vid",
                title: "Test Video",
                url: "https://commons.wikimedia.org/test.mp4"
            }),
            stderr: ""
        };
    };

    await extractGeneric("https://commons.wikimedia.org/wiki/File:Test.webm", {
        commandRunner: capturingRunner,
        metadataTimeoutMs: 5000
    });

    assert.ok(capturedArgs.includes("--proxy"), "yt-dlp args must include --proxy");
    const proxyIdx = capturedArgs.indexOf("--proxy");
    const passedProxyUrl = capturedArgs[proxyIdx + 1];
    assert.ok(passedProxyUrl.startsWith("http://127.0.0.1:"), "Proxy must be bound to 127.0.0.1");
    assert.ok(capturedArgs.includes("--no-playlist"));
    assert.ok(capturedArgs.includes("--ignore-config"));
    assert.ok(capturedArgs.includes("--no-plugin-dirs"));
});

test("Process Security: User cannot inject or override proxy configuration", async () => {
    let capturedArgs = [];
    const capturingRunner = async ({ args }) => {
        capturedArgs = args;
        return {
            exitCode: 0,
            stdout: JSON.stringify({ id: "vid", title: "Vid", url: "https://example.com/v.mp4" }),
            stderr: ""
        };
    };

    // User attempt to append arguments or proxy options in URL will be rejected by validation
    await assert.rejects(
        () => validateGenericSourceUrl("https://commons.wikimedia.org/video --proxy http://evil.com"),
        ValidationError
    );
});

// ==============================================================================
// 7. RESOURCE LIMITS & CONCURRENCY
// ==============================================================================

test("Resource Limits: Enforces max concurrent proxy connections cleanly", async () => {
    const proxy = await createEgressProxy();
    const sockets = [];

    try {
        // Saturate connection capacity
        for (let i = 0; i < MAX_CONCURRENT_CONNECTIONS; i++) {
            const s = net.createConnection({ host: "127.0.0.1", port: proxy.port });
            sockets.push(s);
        }

        // Wait brief tick for connections to register
        await new Promise(r => setTimeout(r, 50));

        // Attempt one extra connection beyond limit
        const extraSocket = net.createConnection({ host: "127.0.0.1", port: proxy.port });
        let destroyed = false;
        extraSocket.on("close", () => { destroyed = true; });

        await new Promise(r => setTimeout(r, 50));
        assert.ok(destroyed || extraSocket.destroyed, "Connection exceeding limit should be destroyed");
        extraSocket.destroy();
    } finally {
        for (const s of sockets) {
            try { s.destroy(); } catch (_) {}
        }
        await proxy.close();
    }
});

// ==============================================================================
// 8. CONFIGURATION & SUBPROCESS ENVIRONMENT SECURITY
// ==============================================================================

test("Configuration Security: Disabling egress proxy in production is strictly rejected", async () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origDisable = process.env.REEVA_DISABLE_EGRESS_PROXY;
    process.env.NODE_ENV = "production";
    process.env.REEVA_DISABLE_EGRESS_PROXY = "true";

    try {
        await assert.rejects(
            () => extractGeneric("https://commons.wikimedia.org/wiki/File:Test.webm", {
                commandRunner: async () => ({ exitCode: 0, stdout: "{}", stderr: "" })
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

test("Configuration Security: Malformed REEVA_EGRESS_PROXY_URL is rejected", async () => {
    const origProxyUrl = process.env.REEVA_EGRESS_PROXY_URL;
    process.env.REEVA_EGRESS_PROXY_URL = "not-a-valid-url";

    try {
        await assert.rejects(
            () => extractGeneric("https://commons.wikimedia.org/wiki/File:Test.webm", {
                commandRunner: async () => ({ exitCode: 0, stdout: "{}", stderr: "" })
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

test("Subprocess Security: defaultCommandRunner sanitizes proxy bypass environment variables", async () => {
    // Set dirty proxy bypass environment variables
    process.env.NO_PROXY = "127.0.0.1,localhost";
    process.env.HTTP_PROXY = "http://attacker-controlled.net";

    try {
        // Run a lightweight command printing python environment to verify sanitization
        const res = await defaultCommandRunner({
            command: "python",
            args: ["-c", "import os; print('NO_PROXY' in os.environ, 'HTTP_PROXY' in os.environ)"],
            timeoutMs: 5000
        });

        assert.equal(res.exitCode, 0);
        assert.ok(res.stdout.includes("False False"), `Expected False False, got: ${res.stdout}`);
    } finally {
        delete process.env.NO_PROXY;
        delete process.env.HTTP_PROXY;
    }
});
