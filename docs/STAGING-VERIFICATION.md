# Reeva Staging Verification Guide

This guide provides instructions and diagnostic procedures for verifying Reeva's extraction and embed capabilities on staging and production environments.

---

## 1. Environment & Network Requirements

| Requirement | Specification | Rationale |
| :--- | :--- | :--- |
| **Node.js** | `>= 20.18.0` | Uses Node test runner and standard fetch/stream APIs. |
| **FFmpeg** | `>= 6.0` (with ffprobe) | Required for local video container sniffing, audio/video merging, and frame decode verification. |
| **Python** | `>= 3.10` with `yt-dlp >= 2026.10.26` | Required for YouTube and TikTok fallback extractors. |
| **Network Egress** | Direct outbound port 443 | Outbound HTTPS without SSL/TLS Deep Packet Inspection (DPI) or middlebox proxy re-signing. |
| **CA Trust Store** | Mozilla / NSS Public Root CA bundle | TLS certificate verification must remain strictly enabled (`rejectUnauthorized: true`). Self-signed or local MITM proxy CAs are rejected. |
| **Geographic Region** | Non-embargoed / unrestricted region | Egress IPs must not be in jurisdictions subject to national regulatory blocks (e.g., Section 69A IT Act in India for TikTok). |

---

## 2. Pre-Flight Network Diagnostics

Before testing platform extractors, execute this diagnostic script to verify unblocked DNS, TCP, and TLS connectivity:

```bash
node -e "
const tls = require('tls');
const net = require('net');
const dns = require('dns').promises;

async function checkHost(host) {
    console.log('\n--- Checking ' + host + ' ---');
    try {
        const addrs = await dns.lookup(host, { all: true });
        console.log('1. DNS: OK (' + addrs.map(a => a.address).join(', ') + ')');
    } catch (e) {
        return console.log('1. DNS: FAILED (' + e.message + ')');
    }

    const s = tls.connect(443, host, { servername: host, rejectUnauthorized: true }, () => {
        const cert = s.getPeerCertificate();
        console.log('2. TCP & TLS Handshake: OK');
        console.log('   Issuer: ' + cert.issuer.O + ' (' + cert.issuer.CN + ')');
        console.log('   Authorized: ' + s.authorized);
        s.end();
    });
    s.on('error', err => console.log('2. TLS: FAILED (' + err.code + ': ' + err.message + ')'));
}

(async () => {
    await checkHost('www.youtube.com');
    await checkHost('api.twitter.com');
    await checkHost('www.pinterest.com');
    await checkHost('www.instagram.com');
    await checkHost('www.facebook.com');
    await checkHost('www.tiktok.com');
})();
"
```

### Interpreting Diagnostic Output

* **Instagram:**
  * Expected Staging: `Issuer: DigiCert Inc` or `Meta Platforms, Inc.`, `Authorized: true`.
  * Corporate/Firewall Block: `Issuer: Sophos`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
* **Facebook:**
  * Expected Staging: `Issuer: DigiCert Inc`, `Authorized: true`.
  * Firewall Reset: `ECONNRESET read ECONNRESET`.
* **TikTok:**
  * Expected Staging: HTTP status 200 or direct video challenge.
  * Regional Block: HTTP 302 redirecting to `/in/about`.

---

## 3. Automated Staging Verification Harness

Reeva includes a dedicated verification harness in `scripts/verify-staging-platforms.cjs` that executes full-pipeline testing with strict certificate verification:

```bash
# Verify all remaining platforms (Instagram, Facebook, TikTok)
node scripts/verify-staging-platforms.cjs

# Verify a single platform
node scripts/verify-staging-platforms.cjs instagram
node scripts/verify-staging-platforms.cjs facebook
node scripts/verify-staging-platforms.cjs tiktok
```

The harness automatically distinguishes:
1. **Network Diagnostics:** DNS resolution, TCP port 443 connectivity, strict TLS handshake (`rejectUnauthorized: true`), peer certificate verification.
2. **Adapter Extraction:** OpenGraph parsing, JSON state traversal, yt-dlp child process isolation.
3. **Media Streaming:** Secure HTTP stream retrieval into temporary storage.
4. **Media Validation:** Magic byte sniffing (MP4 `ftyp`, WebM EBML) and FFmpeg null-mux decode (`ffmpeg -v error -i ... -f null -`).

---

## 4. Manual Platform Verification Commands

### A. Instagram Extraction Verification
Execute against a staging server running with unintercepted egress:
```bash
node -e "
const { extractInstagram } = require('./lib/extraction/adapters/instagram.cjs');
const { secureFetch } = require('./lib/http-client.cjs');
const { SUPPORTED_MEDIA_DOMAINS } = require('./lib/url-validator.cjs');

async function test() {
    const url = 'https://www.instagram.com/reel/C8oP4qNtxZ7/';
    console.log('Extracting Instagram Reel:', url);
    const result = await extractInstagram(url);
    console.log('Extraction Result:', result);

    const handle = await secureFetch(result.url, { allowedDomains: SUPPORTED_MEDIA_DOMAINS });
    console.log('Stream HTTP Status:', handle.response.status);
    console.log('Stream Content-Type:', handle.response.headers.get('content-type'));
    handle.abort();
}
test().catch(console.error);
"
```

### B. Facebook Extraction Verification
Execute against a staging server with unblocked Meta egress:
```bash
node -e "
const { extractFacebook } = require('./lib/extraction/adapters/facebook.cjs');
const { secureFetch } = require('./lib/http-client.cjs');
const { SUPPORTED_MEDIA_DOMAINS } = require('./lib/url-validator.cjs');

async function test() {
    const url = 'https://www.facebook.com/watch/?v=10153231379946729';
    console.log('Extracting Facebook Video:', url);
    const result = await extractFacebook(url);
    console.log('Extraction Result:', result);

    const handle = await secureFetch(result.url, { allowedDomains: SUPPORTED_MEDIA_DOMAINS });
    console.log('Stream HTTP Status:', handle.response.status);
    console.log('Stream Content-Type:', handle.response.headers.get('content-type'));
    handle.abort();
}
test().catch(console.error);
"
```

### C. Live Baseline Download Verification
To re-verify the established 4-platform baseline (YouTube, Twitter/X, Pinterest, Generic Video) end-to-end with FFmpeg decoding:
```bash
node scripts/run-tests.cjs
```
