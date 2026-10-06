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
- **Decoupled Concurrency Limiting**:
  - Independent concurrency limiters protect extraction operations (CPU- and subprocess-bound) from media streaming operations (I/O-bound):
    - Extraction pool: `MAX_GLOBAL_EXTRACTION_CONCURRENCY` (default: 30), `MAX_IP_EXTRACTION_CONCURRENCY` (default: 3).
    - Streaming pool: `MAX_GLOBAL_STREAM_CONCURRENCY` (default: 50), `MAX_IP_STREAM_CONCURRENCY` (default: 5).
  - Prevents slow client downloads from starving extraction operations or vice versa.
  - Slots are guaranteed to release upon stream closure or client disconnect via `res.on('finish' / 'close' / 'error')`.
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

Reeva implements privacy-preserving structured logging and error normalization designed to prevent sensitive data leakage and log injection:

- **Redacted URLs & Parameters**:
  - URLs passed via metadata or embedded in message strings are redacted to protocol, host, and pathname, appending `?[redacted]` when query parameters exist.
  - Basic authentication credentials (`user:password`) and URI fragments (`#fragment`) are stripped prior to formatting.
- **Log Injection & CRLF Prevention**:
  - Formatted log lines are strictly single-line.
  - Newlines (`\n`), carriage returns (`\r`), and tabs (`\t`) in messages are normalized to single spaces.
  - Non-printable ASCII control characters (`\x00-\x1F`, `\x7F-\x9F`) are stripped.
  - Message lengths are bounded (default: 256 characters) with truncation indicators.
- **Bounded Error Code & Identifier Sanitization**:
  - Structured fields (`code`, `platform`, `operation`, `status`) are strictly bounded and sanitized to approved alphanumeric characters, hyphens, and underscores.
  - Non-scalar objects passed as error codes or messages default to safe fallbacks (`UNKNOWN_ERROR`, `[object]`) rather than arbitrary serialization.
- **Key Whitelisting**:
  - The structured log formatter inspects only an explicit whitelist of supported operational keys (`requestId`, `platform`, `operation`, `status`, `code`, `durationMs`, `clientIp`, `url`, `message`). Unrecognized metadata properties, complex objects, and cyclic structures are omitted.
- **Request Correlation**:
  - Inbound `X-Request-Id` headers are validated against `/^[a-zA-Z0-9_\-]{8,64}$/`. Valid IDs are preserved; absent or non-conforming values are replaced with freshly generated `req_<hex>` identifiers.
- **Media Stream Observability**:
  - Media streaming operations emit structured lifecycle events (`operation=stream`, `status=start|success|error`, `durationMs`).
  - Terminal stream errors classify client disconnects (`CLIENT_DISCONNECTED`), server aborts (`STREAM_ABORTED`), and policy rejections without logging media IDs, upstream CDN URLs, query parameters, or response payloads.
- **Error Response Normalization**:
  - Public API responses return sanitized error codes, human-readable user messages, and request correlation IDs.
  - Internal technical stack traces, local filesystem paths, subprocess invocation details, provider credentials, and raw upstream response bodies are suppressed from HTTP error responses.

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

## Production Deployment Boundary & Trust Proxy (`TRUST_PROXY`)

In production environments behind reverse proxies (e.g. NGINX, HAProxy, AWS ALB, Cloudflare, Traefik), Express must know which upstream hops are trusted to correctly determine `req.ip` for rate limiting and concurrency controls.

Reeva enforces strict, fail-fast configuration validation at startup:
- **Default (`false` / `0` / unset)**: Assumes direct Internet traffic. `X-Forwarded-*` headers are completely ignored. This prevents attackers from spoofing their IP to bypass per-IP rate limits and concurrency throttles.
- **Hop Count (e.g., `TRUST_PROXY=1`, `TRUST_PROXY=2`)**: Recommended for single or multi-layer reverse proxies. Express trusts exactly the specified number of upstream hops, reading client IP from the appropriate position in `X-Forwarded-For`.
- **Subnets & CIDRs (e.g., `'loopback'`, `'10.0.0.0/8'`)**: Express trusts requests originating only from the specified CIDR or trusted subnet ranges.
- **High-Trust (`TRUST_PROXY=true`)**: Express trusts all upstream hops. **WARNING**: Only use this mode if the application server is in a private network or VPC where direct access from the public Internet is impossible.

Invalid values fail fast on startup and prevent the server from binding.

---

## Server Lifecycle, Container Probes & Graceful Shutdown

Reeva implements a production-grade lifecycle state machine for container orchestrators (Kubernetes, Nomad, Docker Swarm):

1. **Liveness Probe (`GET /health`)**:
   - Returns HTTP 200 JSON `{ "status": "ok", "timestamp": "..." }`.
   - Fast, unthrottled, and mounted before rate limiters.
   - Contains no environment variables, internal paths, or secrets.

2. **Readiness Probe (`GET /ready`)**:
   - Returns HTTP 200 JSON `{ "status": "ready" }` during normal operation.
   - Returns HTTP 503 JSON `{ "status": "shutting_down" }` once graceful shutdown is initiated.
   - Independent of extraction limiters, allowing container orchestrators to remove the instance from active service endpoints.

3. **Graceful Shutdown (`SIGTERM` / `SIGINT`)**:
   - **Idempotent**: Multiple signals or shutdown invocations return the identical in-progress promise.
   - **Readiness Drop**: Marks the server unready (`/ready` returns 503).
   - **Rejection of New Work**: Rejects new extraction requests (`/api/download/:platform`) and new streaming requests (`/api/media/:mediaId`, `/api/proxy`) with HTTP 503 (`SERVICE_UNAVAILABLE`).
   - **Dual In-Flight Tracking**: Both active extraction operations and active media streaming operations (local-file reads and remote upstream streams) are tracked using `AbortController` in dedicated Sets.
   - **Bounded Grace Period (`SHUTDOWN_TIMEOUT_MS`)**: Gives active extractions and streams up to `SHUTDOWN_TIMEOUT_MS` (default: 10,000ms) to complete draining. If in-flight work completes earlier, shutdown finishes immediately.
   - **Forced Abort on Timeout**: If active extractions or streams exceed the grace deadline, lingering controllers are signaled to abort. This terminates extraction child processes (yt-dlp), destroys local file read streams, aborts upstream `fetch` requests, destroys client response sockets, and releases all acquired concurrency slots.
   - **Socket Closure & Bound Guarantee**: Closes idle keep-alive connections via `closeIdleConnections()` and uses a safety timeout with `closeAllConnections()` so lingering client sockets can never keep `server.close()` blocked indefinitely.
   - **Disk Cleanup**: Clears periodic sweep timers, wipes the media registry, and unlinks all temporary disk files without file-locking contention, leaving zero orphan files on disk.
   - Exits cleanly with code 0.

---

## Multi-Instance Scaling & In-Memory Registry Constraints

Reeva's media token registry (`defaultRegistry`) and merged video/audio files (`REEVA_TEMP_DIR`) are process-local:
- When a client performs an extraction, the resulting opaque media ID (`med_...`) and any merged media files reside in that specific instance's memory and local disk.
- In a horizontally scaled cluster (multiple container replicas), requests to `/api/media/:mediaId` or `/api/proxy` must be routed to the instance that performed the extraction.
- **Architectural Requirement**: Multi-instance deployments require **sticky sessions** (session affinity based on client IP or cookie) at the load balancer / ingress layer, unless a distributed shared registry (e.g. Redis) and shared storage volume are implemented.

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
