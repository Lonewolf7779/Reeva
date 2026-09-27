# Security Policy — Reeva

## Overview
Reeva is a multi-platform media downloader designed to process public media URLs. This document outlines the security architecture, safeguards, threat model, and responsible disclosure policies implemented in Reeva Phase 1.

---

## Architecture & Request Flow

To eliminate arbitrary proxying and SSRF, Reeva enforces strict validation and decoupling across the request lifecycle:

```text
User Input URL
      │
      ▼
Platform & URL Validation (Strict Syntax, Protocol, Hostname Boundary)
      │
      ▼
Media Extractor (Secure Outbound Fetch / Local Parsers)
      │
      ▼
Media Destination Validation (Strict Approved Media CDN Allowlist)
      │
      ▼
Opaque Media Token Registration (Short-Lived, Process-Local In-Memory)
      │
      ▼
Client receives Opaque Reference (/api/media/:mediaId)
      │
      ▼
Controlled Media Streaming (Safe DNS Lookup, Size Metering, Content-Type Check)
      │
      ▼
User Stream / Download
```

Clients never interact with raw upstream CDN endpoints directly, and arbitrary URLs cannot be requested through the proxy.

---

## Server-Side Request Forgery (SSRF) Protection

Reeva implements a defense-in-depth model against SSRF and DNS rebinding:

1. **Protocol Restriction**: Only explicitly permitted `https:` URLs are accepted. Schemes including `http:`, `file:`, `ftp:`, `gopher:`, `data:`, and `javascript:` are rejected.
2. **Credential & Port Sanitization**: URLs containing embedded credentials (`user:pass@`) or non-standard ports (ports other than default 443) are rejected.
3. **Strict Hostname Boundaries**: Hostnames are validated using WHATWG `URL` parser against explicit platform allowlists. Subdomain trickery (e.g. `instagram.com.attacker.com` or `attackerinstagram.com`) is categorically blocked.
4. **Private Network & Metadata Filtering**:
   - Outbound connections to loopback (`127.0.0.0/8`, `::1`), private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`), link-local (`169.254.0.0/16`, `fe80::/10`), CGNAT (`100.64.0.0/10`), multicast, and cloud provider metadata services (AWS/GCP/Azure IMDS `169.254.169.254`, `fd00:ec2::254`) are blocked.
   - Dual-stack IPv6 addresses and IPv4-mapped IPv6 (`::ffff:0:0/96`) are normalized and checked.
5. **DNS Rebinding Prevention (TOCTOU)**:
   - Outbound HTTP agents utilize a custom DNS resolver (`safeLookup`) pinned directly to socket initialization. Hostnames that resolve to any internal address fail before the TCP handshake occurs, preventing time-of-check/time-of-use rebinding attacks.
6. **Controlled Redirects**:
   - HTTP redirects are handled manually. Every hop validates the target `Location` against the protocol, hostname allowlist, and IP restrictions. Maximum redirects are limited (default: 3).

---

## Destination Allowlists

Outbound network communication is segregated into two independent allowlists:

### 1. Supported Source Domains (`SUPPORTED_SOURCE_DOMAINS`)
- **Instagram**: `instagram.com`, `instagr.am`
- **Facebook**: `facebook.com`, `fb.watch`, `fb.com`
- **Twitter / X**: `twitter.com`, `x.com`
- **Pinterest**: `pinterest.com`, `pin.it`, regional Pinterest country domains
- **YouTube**: `youtube.com`, `youtu.be`

### 2. Supported Media CDNs (`SUPPORTED_MEDIA_DOMAINS`)
- **Instagram / Meta CDN**: `cdninstagram.com`, `fbcdn.net`, `instagram.com`
- **Facebook CDN**: `fbcdn.net`, `facebook.com`
- **Twitter / X CDN**: `twimg.com`
- **Pinterest CDN**: `pinimg.com`
- **YouTube CDN**: `googlevideo.com`, `ytimg.com`

Outbound retrieval is prohibited for any destination outside these boundaries.

---

## Rate Limiting & Resource Exhaustion Controls

Reeva protects itself against resource exhaustion and denial of service:

- **Tiered Rate Limiting**:
  - General routes: 100 requests per 15 minutes.
  - Extraction routes (`/api/download/:platform`): 15 requests per 1 minute.
  - Media streaming routes (`/api/media/:id`): 30 requests per 5 minutes.
- **Concurrency Limiting**:
  - Global concurrent extraction and streaming requests are capped (default: 50).
  - Per-IP simultaneous operations are strictly bounded (default: 3). Slots are guaranteed to release upon stream closure or disconnect via `res.on('finish' / 'close' / 'error')`.
- **Response Size Limits**:
  - Media streaming is capped at 250 MB (`MAX_MEDIA_SIZE_BYTES`).
  - Pre-flight `Content-Length` inspection rejects oversized files upfront.
  - A real-time `StreamMeter` monitors byte transfer and terminates the stream and upstream connection if the limit is exceeded.
- **Request Timeouts**:
  - Outbound fetches enforce connection and total timeouts (5s to 30s) via `AbortController`.
- **Content-Type Validation**:
  - Media streams must match approved media MIME types (`video/mp4`, `video/webm`, `image/jpeg`, etc.). Executable, HTML, and script MIME types are rejected.

---

## Memory & Cache Bounds

- The in-memory cache is bounded (default: 500 entries) with a 10-minute TTL.
- Cache entries use an LRU eviction strategy to prevent memory exhaustion under continuous unique-URL requests.
- Cache keys are canonicalized by stripping analytics and tracking parameters (`utm_*`, `igshid`, `fbclid`, etc.).
- The media registry holds a maximum of 1,000 entries with automatic expiration and LRU cleanup.

---

## Logging & Privacy

- Full raw user URLs, signed CDN URLs with session tokens, cookies, and authorization headers are never logged.
- URLs are redacted to origin and pathname before logging.
- Structured logs record operational metadata: `requestId`, `platform`, `operation`, `status`, `durationMs`.
- Every incoming request is assigned a unique `X-Request-Id` for correlation.
- Technical error stack traces are hidden from public API responses; generic, actionable error messages with codes and request IDs are returned to users.

---

## Security Headers

Reeva enforces modern HTTP security headers:
- `Content-Security-Policy`: Restricts scripts and connections to `'self'`. Disallows inline scripts, plugins, and framing.
- `X-Frame-Options: DENY`: Defends against clickjacking.
- `X-Content-Type-Options: nosniff`: Prevents MIME confusion attacks.
- `Referrer-Policy: strict-origin-when-cross-origin`: Minimizes referrer leakage.
- `Strict-Transport-Security`: Enforced for HTTPS deployments.
- `Permissions-Policy`: Restricts browser sensor and device access.

---

## Dependency Management & Vulnerabilities

- Dependencies are monitored and audited for known CVEs.
- Vulnerable, unmaintained, or superseded packages (such as legacy `ytdl-core` and security holding placeholders) are removed.
- Transitive dependencies are kept up to date via npm audit remediation.

---

## Reporting a Security Vulnerability

If you discover a security vulnerability in Reeva, please report it responsibly:

- **Email**: Send vulnerability details to `security@reeva.app` (or contact project maintainers).
- **Details to Include**:
  - Description of the vulnerability.
  - Steps to reproduce or proof-of-concept.
  - Impact assessment.
- **Policy**: We ask that you do not disclose issues publicly until we have had an opportunity to address them.
