// lib/concurrency-limiter.cjs — Bounded Concurrency Limiter for Expensive Operations
"use strict";

const { ipKeyGenerator } = require("express-rate-limit");

const MAX_GLOBAL_CONCURRENCY = parseInt(process.env.MAX_GLOBAL_CONCURRENCY || "50", 10);
const MAX_IP_CONCURRENCY = parseInt(process.env.MAX_IP_CONCURRENCY || "3", 10);

/**
 * Normalizes an incoming client IP address for consistent rate and concurrency limiting.
 * Handles:
 * - IPv6 subnets (collapsing /56 or configured subnet to prevent address rotation bypasses)
 * - IPv4-mapped IPv6 addresses (e.g. ::ffff:192.0.2.1 -> 192.0.2.1, preventing IPv4 collision)
 * - Direct IPv4 addresses (preserved as distinct client IPs)
 *
 * @param {object|string} req - Express request object or raw IP string
 * @param {number} [ipv6Subnet=56] - Subnet bit length for IPv6 masking
 * @returns {string} Normalized IP or subnet string
 */
function normalizeClientIp(req, ipv6Subnet = 56) {
    const rawIp = typeof req === "string" ? req : (req?.ip || req?.socket?.remoteAddress || "unknown");
    if (!rawIp || rawIp === "unknown") return "unknown";
    try {
        if (typeof ipKeyGenerator === "function") {
            return ipKeyGenerator(rawIp, ipv6Subnet);
        }
    } catch (_) {}
    return rawIp;
}

/**
 * Creates Express middleware to strictly limit simultaneous in-flight requests
 * globally and per client IP address.
 *
 * All acquired slots are guaranteed to be released via res.on('finish' / 'close' / 'error').
 */
function createConcurrencyLimiter(options = {}) {
    const maxGlobal = options.maxGlobal || MAX_GLOBAL_CONCURRENCY;
    const maxPerIp = options.maxPerIp || MAX_IP_CONCURRENCY;
    const ipv6Subnet = options.ipv6Subnet !== undefined ? options.ipv6Subnet : 56;

    let globalActive = 0;
    const ipActive = new Map();

    const middleware = function concurrencyLimiter(req, res, next) {
        const clientIp = normalizeClientIp(req, ipv6Subnet);

        if (globalActive >= maxGlobal) {
            return res.status(503).json({
                error: {
                    code: "CONCURRENCY_GLOBAL_LIMIT",
                    message: "The server is currently handling maximum capacity. Please wait a moment and try again."
                },
                requestId: req.id
            });
        }

        const currentIpCount = ipActive.get(clientIp) || 0;
        if (currentIpCount >= maxPerIp) {
            return res.status(429).json({
                error: {
                    code: "CONCURRENCY_IP_LIMIT",
                    message: "Too many concurrent requests from your IP address. Please wait for current operations to finish."
                },
                requestId: req.id
            });
        }

        // Acquire slot
        globalActive++;
        ipActive.set(clientIp, currentIpCount + 1);

        let released = false;
        const releaseSlot = () => {
            if (released) return;
            released = true;

            globalActive = Math.max(0, globalActive - 1);
            const count = ipActive.get(clientIp) || 1;
            if (count <= 1) {
                ipActive.delete(clientIp);
            } else {
                ipActive.set(clientIp, count - 1);
            }
        };

        // Guarantee release on finish, close (disconnect/abort), or error
        res.on("finish", releaseSlot);
        res.on("close", releaseSlot);
        res.on("error", releaseSlot);

        next();
    };

    // Diagnostic helpers for testing
    middleware.getGlobalActive = () => globalActive;
    middleware.getIpActive = (ip) => ipActive.get(normalizeClientIp(ip, ipv6Subnet)) || 0;
    middleware.reset = () => {
        globalActive = 0;
        ipActive.clear();
    };

    return middleware;
}

module.exports = {
    createConcurrencyLimiter,
    normalizeClientIp
};
