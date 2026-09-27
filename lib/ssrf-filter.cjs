// lib/ssrf-filter.cjs — SSRF and Private Network Protection
"use strict";

const dns = require("dns");
const net = require("net");

class SSRFError extends Error {
    constructor(message, code = "SSRF_BLOCKED") {
        super(message);
        this.name = "SSRFError";
        this.code = code;
    }
}

/**
 * Converts a standard IPv4 string to an unsigned 32-bit integer.
 * Returns null if not a valid 4-octet IPv4 address.
 *
 * @param {string} ip
 * @returns {number|null}
 */
function ipv4ToInt(ip) {
    if (!net.isIPv4(ip)) return null;
    const parts = ip.split(".");
    if (parts.length !== 4) return null;

    let int = 0;
    for (let i = 0; i < 4; i++) {
        const octet = Number(parts[i]);
        if (isNaN(octet) || octet < 0 || octet > 255 || parts[i] !== String(octet)) {
            return null;
        }
        int = ((int << 8) | octet) >>> 0;
    }
    return int;
}

/**
 * Determines whether an IPv4 address falls within private, loopback, link-local,
 * multicast, or other restricted ranges.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isRestrictedIPv4(ip) {
    const int = ipv4ToInt(ip);
    if (int === null) return true; // Malformed IPs are rejected

    // 0.0.0.0/8 (Current network / "this" network)
    if ((int >>> 24) === 0) return true;

    // 10.0.0.0/8 (Private-Use RFC 1918)
    if ((int >>> 24) === 10) return true;

    // 100.64.0.0/10 (Shared Address Space / CGNAT RFC 6598: 100.64.0.0 - 100.127.255.255)
    if ((int >>> 22) === (0x64400000 >>> 22)) return true;

    // 127.0.0.0/8 (Loopback RFC 1122)
    if ((int >>> 24) === 127) return true;

    // 169.254.0.0/16 (Link-Local RFC 3927 & Cloud Metadata 169.254.169.254)
    if ((int >>> 16) === ((169 << 8) | 254)) return true;

    // 172.16.0.0/12 (Private-Use RFC 1918: 172.16.0.0 - 172.31.255.255)
    if ((int >>> 20) === (0xAC100000 >>> 20)) return true;

    // 192.0.0.0/24 (IETF Protocol Assignments RFC 6890)
    if ((int >>> 8) === (0xC0000000 >>> 8)) return true;

    // 192.0.2.0/24 (TEST-NET-1 RFC 5737)
    if ((int >>> 8) === (0xC0000200 >>> 8)) return true;

    // 192.88.99.0/24 (6to4 Relay Anycast RFC 3068)
    if ((int >>> 8) === (0xC0586300 >>> 8)) return true;

    // 192.168.0.0/16 (Private-Use RFC 1918)
    if ((int >>> 16) === ((192 << 8) | 168)) return true;

    // 198.18.0.0/15 (Network Interconnect Benchmark Testing RFC 2544: 198.18.0.0 - 198.19.255.255)
    if ((int >>> 17) === (0xC6120000 >>> 17)) return true;

    // 198.51.100.0/24 (TEST-NET-2 RFC 5737)
    if ((int >>> 8) === (0xC6336400 >>> 8)) return true;

    // 203.0.113.0/24 (TEST-NET-3 RFC 5737)
    if ((int >>> 8) === (0xCB007100 >>> 8)) return true;

    // 224.0.0.0/4 (Multicast RFC 5771: 224.0.0.0 - 239.255.255.255)
    if ((int >>> 28) === 14) return true;

    // 240.0.0.0/4 (Reserved / Future Use RFC 1112: 240.0.0.0 - 255.255.255.255)
    if ((int >>> 28) === 15) return true;

    // 255.255.255.255 (Limited Broadcast)
    if (int === 0xFFFFFFFF) return true;

    return false;
}

/**
 * Expands an IPv6 address string into 8 16-bit hex integers.
 * Returns null if invalid.
 *
 * @param {string} ip
 * @returns {number[]|null}
 */
function parseIPv6(ip) {
    if (!net.isIPv6(ip)) return null;

    let address = ip.toLowerCase();

    // Check for IPv4-mapped IPv6 (e.g. ::ffff:192.0.2.128)
    if (address.includes(".")) {
        const lastColon = address.lastIndexOf(":");
        if (lastColon === -1) return null;
        const v4Str = address.slice(lastColon + 1);
        const v4Int = ipv4ToInt(v4Str);
        if (v4Int === null) return null;
        const high16 = ((v4Int >>> 16) & 0xFFFF).toString(16);
        const low16 = (v4Int & 0xFFFF).toString(16);
        address = address.slice(0, lastColon + 1) + high16 + ":" + low16;
    }

    const doubleColon = address.indexOf("::");
    let parts;

    if (doubleColon !== -1) {
        const left = address.slice(0, doubleColon).split(":").filter(Boolean);
        const right = address.slice(doubleColon + 2).split(":").filter(Boolean);
        const missing = 8 - (left.length + right.length);
        if (missing < 0) return null;
        const zeros = new Array(missing).fill("0");
        parts = [...left, ...zeros, ...right];
    } else {
        parts = address.split(":");
    }

    if (parts.length !== 8) return null;

    const blocks = [];
    for (const p of parts) {
        const val = parseInt(p, 16);
        if (isNaN(val) || val < 0 || val > 0xFFFF) return null;
        blocks.push(val);
    }
    return blocks;
}

/**
 * Determines whether an IPv6 address falls within private, loopback, link-local,
 * ULA, or other restricted ranges.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isRestrictedIPv6(ip) {
    const blocks = parseIPv6(ip);
    if (!blocks) return true;

    // Check for IPv4-mapped IPv6 (::ffff:0:0/96 or ::ffff:x.x.x.x)
    const isIPv4Mapped =
        blocks[0] === 0 &&
        blocks[1] === 0 &&
        blocks[2] === 0 &&
        blocks[3] === 0 &&
        blocks[4] === 0 &&
        blocks[5] === 0xFFFF;

    if (isIPv4Mapped) {
        const v4Int = ((blocks[6] << 16) | blocks[7]) >>> 0;
        const octets = [
            (v4Int >>> 24) & 0xFF,
            (v4Int >>> 16) & 0xFF,
            (v4Int >>> 8) & 0xFF,
            v4Int & 0xFF
        ];
        return isRestrictedIPv4(octets.join("."));
    }

    // :: (Unspecified)
    if (blocks.every(b => b === 0)) return true;

    // ::1 (Loopback RFC 4291)
    if (
        blocks[0] === 0 &&
        blocks[1] === 0 &&
        blocks[2] === 0 &&
        blocks[3] === 0 &&
        blocks[4] === 0 &&
        blocks[5] === 0 &&
        blocks[6] === 0 &&
        blocks[7] === 1
    ) {
        return true;
    }

    // fc00::/7 (Unique Local Address RFC 4193: fc00:: - fdff:ffff:...)
    // High 7 bits must be 1111110 -> 0xFC00
    if ((blocks[0] & 0xFE00) === 0xFC00) return true;

    // fe80::/10 (Link-Local Unicast RFC 4291: fe80:: - febf:ffff:...)
    // High 10 bits must be 1111111010 -> 0xFE80
    if ((blocks[0] & 0xFFC0) === 0xFE80) return true;

    // ff00::/8 (Multicast RFC 4291)
    // High 8 bits must be 11111111 -> 0xFF00
    if ((blocks[0] & 0xFF00) === 0xFF00) return true;

    // 2001:db8::/32 (Documentation RFC 3849)
    if (blocks[0] === 0x2001 && blocks[1] === 0x0DB8) return true;

    // 64:ff9b::/96 (IPv4/IPv6 translation RFC 6052)
    if (blocks[0] === 0x0064 && blocks[1] === 0xFF9B && blocks[2] === 0 && blocks[3] === 0 && blocks[4] === 0 && blocks[5] === 0) {
        const v4Int = ((blocks[6] << 16) | blocks[7]) >>> 0;
        const octets = [
            (v4Int >>> 24) & 0xFF,
            (v4Int >>> 16) & 0xFF,
            (v4Int >>> 8) & 0xFF,
            v4Int & 0xFF
        ];
        return isRestrictedIPv4(octets.join("."));
    }

    return false;
}

/**
 * Universal check: returns true if an IP string is private, loopback, link-local,
 * cloud metadata, multicast, or otherwise forbidden.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateOrBlockedIP(ip) {
    if (!ip || typeof ip !== "string") return true;
    const clean = ip.trim();

    if (net.isIPv4(clean)) {
        return isRestrictedIPv4(clean);
    }
    if (net.isIPv6(clean)) {
        return isRestrictedIPv6(clean);
    }
    return true; // Not a recognized IP
}

/**
 * Custom DNS lookup handler to prevent SSRF and DNS Rebinding (TOCTOU).
 *
 * When passed to Node's http.Agent or https.Agent ({ lookup: safeLookup }),
 * Node calls this function during the actual socket connection phase.
 * If the hostname resolves to any private or internal IP, the connection is
 * aborted before the TCP handshake occurs.
 */
function safeLookup(hostname, options, callback) {
    if (typeof options === "function") {
        callback = options;
        options = {};
    }

    // Direct IP address in hostname
    if (net.isIP(hostname)) {
        if (isPrivateOrBlockedIP(hostname)) {
            const err = new SSRFError(
                `Direct connection to restricted IP address '${hostname}' is forbidden.`,
                "RESTRICTED_IP"
            );
            return callback(err);
        }
        if (options && options.all) {
            return callback(null, [{ address: hostname, family: net.isIPv4(hostname) ? 4 : 6 }]);
        }
        return callback(null, hostname, net.isIPv4(hostname) ? 4 : 6);
    }

    // Perform DNS lookup for all addresses
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
        if (err) return callback(err);

        if (!addresses || addresses.length === 0) {
            const noAddrErr = new Error(`No DNS records found for host '${hostname}'.`);
            noAddrErr.code = "ENOTFOUND";
            return callback(noAddrErr);
        }

        for (const item of addresses) {
            if (isPrivateOrBlockedIP(item.address)) {
                const ssrfErr = new SSRFError(
                    `Destination '${hostname}' resolved to forbidden address '${item.address}'. Request blocked.`,
                    "RESTRICTED_IP"
                );
                return callback(ssrfErr);
            }
        }

        if (options && options.all) {
            return callback(null, addresses);
        }
        return callback(null, addresses[0].address, addresses[0].family);
    });
}

/**
 * Pre-flight DNS validation: resolves all IPs for a hostname and asserts all are public.
 *
 * @param {string} hostname
 * @returns {Promise<string[]>} Validated public IP addresses
 */
async function assertSafeDestination(hostname) {
    if (!hostname || typeof hostname !== "string") {
        throw new SSRFError("Invalid hostname.", "INVALID_HOST");
    }

    const clean = hostname.toLowerCase().trim().replace(/\.$/, "");

    // If hostname is already an IP
    if (net.isIP(clean)) {
        if (isPrivateOrBlockedIP(clean)) {
            throw new SSRFError(
                `Access to private/restricted IP address '${clean}' is forbidden.`,
                "RESTRICTED_IP"
            );
        }
        return [clean];
    }

    // Resolve via DNS
    const addresses = await dns.promises.lookup(clean, { all: true, verbatim: true });
    if (!addresses || addresses.length === 0) {
        throw new Error(`Hostname '${clean}' could not be resolved.`);
    }

    for (const record of addresses) {
        if (isPrivateOrBlockedIP(record.address)) {
            throw new SSRFError(
                `Hostname '${clean}' resolved to restricted address '${record.address}'.`,
                "RESTRICTED_IP"
            );
        }
    }

    return addresses.map(a => a.address);
}

module.exports = {
    SSRFError,
    ipv4ToInt,
    isRestrictedIPv4,
    isRestrictedIPv6,
    isPrivateOrBlockedIP,
    safeLookup,
    assertSafeDestination
};
