// lib/extraction/egress-proxy.cjs — Controlled Loopback Egress Proxy for yt-dlp Network Isolation
"use strict";

const http = require("http");
const net = require("net");
const { URL } = require("url");
const { isPrivateOrBlockedIP, assertSafeDestination, safeLookup } = require("../ssrf-filter.cjs");
const { logger } = require("../logger.cjs");

const ALLOWED_PORTS = Object.freeze(new Set([80, 443]));
const MAX_CONCURRENT_CONNECTIONS = 50;
const SOCKET_IDLE_TIMEOUT_MS = 60000; // 60s idle timeout
const CONNECT_TIMEOUT_MS = 15000; // 15s handshake timeout

class EgressSecurityError extends Error {
    constructor(message, code = "EGRESS_BLOCKED", statusCode = 403) {
        super(message);
        this.name = "EgressSecurityError";
        this.code = code;
        this.statusCode = statusCode;
    }
}

/**
 * Verifies if an incoming connection originated strictly from loopback.
 *
 * @param {string|undefined} remoteAddress
 * @returns {boolean}
 */
function isLoopbackClient(remoteAddress) {
    if (!remoteAddress || typeof remoteAddress !== "string") return false;
    const clean = remoteAddress.trim();
    return clean === "127.0.0.1" || clean === "::1" || clean === "::ffff:127.0.0.1";
}

/**
 * Checks if a hostname matches forbidden local/internal suffixes.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isInternalHostname(hostname) {
    if (!hostname || typeof hostname !== "string") return true;
    const lower = hostname.toLowerCase().trim().replace(/\.$/, "");
    if (lower === "localhost") return true;
    if (lower.endsWith(".localhost")) return true;
    if (lower.endsWith(".local")) return true;
    if (lower.endsWith(".internal")) return true;
    if (lower.endsWith(".lan")) return true;
    if (lower.endsWith(".home")) return true;
    if (lower.endsWith(".corp")) return true;
    if (lower.endsWith(".onion")) return true;
    return false;
}

/**
 * Parses and validates an HTTPS CONNECT target string (e.g. "example.com:443" or "[::1]:443").
 *
 * @param {string} rawUrl
 * @returns {{ host: string, port: number }}
 */
function parseConnectTarget(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") {
        throw new EgressSecurityError("Missing or invalid CONNECT target", "INVALID_TARGET", 400);
    }

    const clean = rawUrl.trim();
    let host;
    let port = 443;

    if (clean.startsWith("[")) {
        // IPv6 literal syntax: [::1]:443 or [::1]
        const closeIdx = clean.indexOf("]");
        if (closeIdx === -1) {
            throw new EgressSecurityError("Malformed IPv6 CONNECT target", "MALFORMED_TARGET", 400);
        }
        host = clean.slice(1, closeIdx);
        const after = clean.slice(closeIdx + 1);
        if (after.startsWith(":")) {
            port = parseInt(after.slice(1), 10);
        }
    } else {
        const colonIdx = clean.lastIndexOf(":");
        if (colonIdx !== -1) {
            host = clean.slice(0, colonIdx);
            port = parseInt(clean.slice(colonIdx + 1), 10);
        } else {
            host = clean;
        }
    }

    if (isNaN(port) || port < 1 || port > 65535) {
        throw new EgressSecurityError(`Invalid destination port '${port}' in CONNECT target`, "INVALID_PORT", 400);
    }

    return { host, port };
}

/**
 * Evaluates whether an egress target host and port are permitted.
 * Throws EgressSecurityError if target is forbidden or resolves to private/internal IPs.
 *
 * @param {string} host
 * @param {number} port
 * @returns {Promise<void>}
 */
async function validateEgressDestination(host, port) {
    // 1. Port restriction: Only ports 80 and 443 are allowed
    if (!ALLOWED_PORTS.has(port)) {
        throw new EgressSecurityError(
            `Egress to destination port ${port} is forbidden by security policy.`,
            "FORBIDDEN_PORT",
            403
        );
    }

    if (!host || typeof host !== "string") {
        throw new EgressSecurityError("Invalid egress host.", "INVALID_HOST", 400);
    }

    const cleanHost = host.trim().replace(/^\[|\]$/g, "");

    // 2. Direct IP literal checks (IPv4 and IPv6)
    if (net.isIP(cleanHost)) {
        if (isPrivateOrBlockedIP(cleanHost)) {
            throw new EgressSecurityError(
                `Direct egress to restricted IP address '${cleanHost}' is forbidden.`,
                "RESTRICTED_IP",
                403
            );
        }
        return;
    }

    // 3. Domain checks
    if (isInternalHostname(cleanHost)) {
        throw new EgressSecurityError(
            `Egress to internal or loopback domain '${cleanHost}' is forbidden.`,
            "RESTRICTED_DOMAIN",
            403
        );
    }

    // 4. DNS preflight resolution via ssrf-filter (verifies all resolved addresses are public)
    try {
        await assertSafeDestination(cleanHost);
    } catch (err) {
        throw new EgressSecurityError(
            `Egress destination '${cleanHost}' failed security resolution: ${err.message}`,
            "RESTRICTED_DESTINATION",
            403
        );
    }
}

/**
 * Creates and starts a controlled loopback egress proxy server.
 *
 * @param {object} [options]
 * @param {number} [options.port=0] - Port to listen on (0 for ephemeral)
 * @param {string} [options.host="127.0.0.1"] - Bind host (must be loopback)
 * @returns {Promise<{ server: http.Server, port: number, proxyUrl: string, close: () => Promise<void> }>}
 */
function createEgressProxy(options = {}) {
    return new Promise((resolve, reject) => {
        const bindHost = options.host || "127.0.0.1";
        const bindPort = options.port !== undefined ? options.port : 0;

        if (!isLoopbackClient(bindHost)) {
            return reject(new Error("Egress proxy must bind exclusively to loopback (127.0.0.1)."));
        }

        const activeSockets = new Set();

        const server = http.createServer({
            maxHeaderSize: 16 * 1024 // 16 KB max header size
        });

        // Track active client sockets and enforce loopback-only client origin
        server.on("connection", (socket) => {
            const clientIp = socket.remoteAddress;
            if (!isLoopbackClient(clientIp)) {
                logger.warn({
                    message: "Rejected non-loopback connection to egress proxy",
                    clientIp: clientIp || "unknown"
                });
                socket.destroy();
                return;
            }

            if (activeSockets.size >= MAX_CONCURRENT_CONNECTIONS) {
                logger.warn({
                    message: "Egress proxy connection limit reached, rejecting connection"
                });
                socket.destroy();
                return;
            }

            activeSockets.add(socket);
            socket.on("close", () => activeSockets.delete(socket));
            socket.on("error", () => activeSockets.delete(socket));
        });

        // Handler for cleartext HTTP proxy requests (GET http://example.com/...)
        server.on("request", async (req, res) => {
            try {
                let parsedUrl;
                try {
                    parsedUrl = new URL(req.url);
                } catch (_) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ error: "Invalid proxy request URL" }));
                }

                if (parsedUrl.protocol !== "http:") {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ error: "Only http protocol is permitted for cleartext proxying" }));
                }

                const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 80;
                await validateEgressDestination(parsedUrl.hostname, port);

                // Forward request to verified public destination
                const forwardHeaders = { ...req.headers };
                forwardHeaders.host = parsedUrl.host;
                delete forwardHeaders["proxy-connection"];
                delete forwardHeaders["proxy-authorization"];

                const forwardReq = http.request({
                    hostname: parsedUrl.hostname,
                    port,
                    path: parsedUrl.pathname + parsedUrl.search,
                    method: req.method,
                    headers: forwardHeaders,
                    lookup: safeLookup, // TOCTOU / DNS rebinding guard at connection time
                    timeout: SOCKET_IDLE_TIMEOUT_MS
                }, (forwardRes) => {
                    res.writeHead(forwardRes.statusCode, forwardRes.headers);
                    forwardRes.pipe(res);
                });

                forwardReq.on("timeout", () => {
                    forwardReq.destroy(new Error("Upstream request timed out"));
                });

                forwardReq.on("error", (err) => {
                    if (!res.headersSent) {
                        res.writeHead(502, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Upstream gateway error", detail: err.message }));
                    }
                });

                req.pipe(forwardReq);
            } catch (err) {
                const status = err instanceof EgressSecurityError ? err.statusCode : 403;
                if (!res.headersSent) {
                    res.writeHead(status, {
                        "Content-Type": "application/json",
                        "Connection": "close"
                    });
                    res.end(JSON.stringify({
                        error: "Egress destination blocked",
                        code: err.code || "EGRESS_BLOCKED",
                        message: err.message
                    }));
                }
            }
        });

        // Handler for HTTPS CONNECT tunneling (CONNECT example.com:443 HTTP/1.1)
        server.on("connect", async (req, clientSocket, head) => {
            try {
                const target = parseConnectTarget(req.url);
                await validateEgressDestination(target.host, target.port);

                // Destination validated: Establish outbound TCP tunnel
                const targetSocket = net.connect({
                    host: target.host,
                    port: target.port,
                    lookup: safeLookup // Enforces safeLookup at connect time (TOCTOU protection)
                });

                activeSockets.add(targetSocket);
                targetSocket.on("close", () => activeSockets.delete(targetSocket));

                let isCleanedUp = false;
                const cleanup = () => {
                    if (isCleanedUp) return;
                    isCleanedUp = true;
                    activeSockets.delete(clientSocket);
                    activeSockets.delete(targetSocket);
                    try { clientSocket.destroy(); } catch (_) {}
                    try { targetSocket.destroy(); } catch (_) {}
                };

                clientSocket.setTimeout(SOCKET_IDLE_TIMEOUT_MS, cleanup);
                targetSocket.setTimeout(SOCKET_IDLE_TIMEOUT_MS, cleanup);

                clientSocket.on("close", cleanup);
                clientSocket.on("error", cleanup);
                targetSocket.on("error", (err) => {
                    try {
                        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
                    } catch (_) {}
                    cleanup();
                });

                const connectTimer = setTimeout(() => {
                    try {
                        clientSocket.write("HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n");
                    } catch (_) {}
                    cleanup();
                }, CONNECT_TIMEOUT_MS);

                targetSocket.on("connect", () => {
                    clearTimeout(connectTimer);
                    try {
                        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                        if (head && head.length > 0) {
                            targetSocket.write(head);
                        }
                        clientSocket.pipe(targetSocket);
                        targetSocket.pipe(clientSocket);
                    } catch (_) {
                        cleanup();
                    }
                });
            } catch (err) {
                try {
                    const status = err instanceof EgressSecurityError ? err.statusCode : 403;
                    const message = err.message || "Destination forbidden";
                    clientSocket.write(`HTTP/1.1 ${status} Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}\r\n`);
                } catch (_) {}
                try {
                    clientSocket.destroy();
                } catch (_) {}
            }
        });

        server.on("error", (err) => {
            reject(err);
        });

        server.listen(bindPort, bindHost, () => {
            try {
                server.unref();
            } catch (_) {}
            const addr = server.address();
            const actualPort = typeof addr === "object" && addr ? addr.port : bindPort;
            const proxyUrl = `http://127.0.0.1:${actualPort}`;

            const close = () => new Promise((res) => {
                // Destroy all active client and target sockets
                for (const socket of activeSockets) {
                    try { socket.destroy(); } catch (_) {}
                }
                activeSockets.clear();
                server.close(() => res());
            });

            resolve({
                server,
                port: actualPort,
                proxyUrl,
                close
            });
        });
    });
}

// Singleton state for application-wide egress proxy
let defaultProxyInstance = null;
let defaultProxyPromise = null;

/**
 * Ensures the singleton loopback egress proxy is running and returns its URL.
 *
 * @param {object} [options]
 * @returns {Promise<string>} Egress proxy URL (e.g. "http://127.0.0.1:54321")
 */
async function ensureEgressProxy(options = {}) {
    if (defaultProxyInstance && defaultProxyInstance.server.listening) {
        return defaultProxyInstance.proxyUrl;
    }

    if (defaultProxyPromise) {
        return defaultProxyPromise;
    }

    defaultProxyPromise = (async () => {
        try {
            defaultProxyInstance = await createEgressProxy(options);
            return defaultProxyInstance.proxyUrl;
        } finally {
            defaultProxyPromise = null;
        }
    })();

    return defaultProxyPromise;
}

/**
 * Shuts down the singleton egress proxy if active.
 *
 * @returns {Promise<void>}
 */
async function stopDefaultEgressProxy() {
    if (defaultProxyInstance) {
        const instance = defaultProxyInstance;
        defaultProxyInstance = null;
        await instance.close();
    }
}

module.exports = {
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
};
