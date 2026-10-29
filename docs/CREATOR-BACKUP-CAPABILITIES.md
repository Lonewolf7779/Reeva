# Reeva Creator-Authorized Backup Capabilities & API Investigation

**Date:** October 28, 2026  
**Status:** Research & Architecture Specification (Priority 3)  
**Governing Principle:** Do not implement creator backup features until official documented capabilities support them and developer review/permissions are established.

---

## 1. Executive Summary & Objective

Reeva's core mission is providing a reliable, secure media download and preview service. While YouTube, Twitter/X, Pinterest, and Generic HTTP endpoints support direct media streaming within lawful parameters, platforms such as **TikTok**, **Instagram**, and **Facebook** enforce aggressive edge bot-detection (Akamai/Cloudflare/Pumbaa JS stubs) and strictly prohibit unauthenticated scraping.

This investigation explores the feasibility of **Creator-Authorized Personal Backups**—a potential architecture where creators grant OAuth consent allowing Reeva to retrieve their own published content for backup and archiving.

---

## 2. Platform-by-Platform API Investigation

### 2.1 TikTok (TikTok for Developers — Display API v2)

* **Current API Products:**
  * TikTok Display API v2 (`https://open.tiktokapis.com/v2/`)
  * TikTok Content Posting API
  * TikTok Research API (Academic / Non-commercial only)
* **Account Types Supported:**
  * Any public TikTok account (Personal, Creator, or Business) via OAuth 2.0 PKCE flow.
* **Permissions / Scopes Required:**
  * `video.list` (Grants read access to a user's public video list and metadata).
* **OAuth & App Review Requirements:**
  * Mandatory TikTok Developer Portal App Review to release an application to Live mode.
  * Sandbox mode is restricted to a maximum of 5 registered test TikTok accounts.
* **Media Binary URL Availability:** **UNAVAILABLE.**
  * The `POST /v2/video/list/` endpoint returns the following fields:
    * `id` (video ID)
    * `title` (video description)
    * `embed_link` (HTTPS URL to iframe player)
    * `embed_html` (blockquote embed code)
    * `share_url` (canonical web link)
    * `cover_image_url` (thumbnail JPEG/PNG)
    * `duration`, `width`, `height`, `like_count`, `view_count`
  * **TikTok does NOT return raw `.mp4` video binary URLs in the Display API.**
* **Terms of Service Restrictions:**
  * Section 5.1 of the TikTok Developer Terms strictly prohibits caching, saving, downloading, or archiving audio-visual content delivered via the Display API.
* **Conclusion for TikTok:**
  * **Direct video binary download is not possible via official TikTok APIs.**
  * Only official sandboxed iframe embeds (`https://www.tiktok.com/embed/v2/{video_id}`) are officially sanctioned.

---

### 2.2 Instagram (Meta Graph API — Instagram Platform)

* **Current API Products:**
  * Instagram Graph API (`https://graph.facebook.com/v21.0/`)
  * *Important Deprecation Notice:* The consumer-facing **Instagram Basic Display API was officially decommissioned by Meta on December 4, 2024**. Any integration targeting standard personal Instagram accounts is permanently unavailable.
* **Account Types Supported:**
  * **Instagram Professional Accounts only** (Creator or Business accounts) that are linked to a Facebook Page. Personal consumer accounts cannot use the Instagram Graph API.
* **Permissions / Scopes Required:**
  * `instagram_basic`
  * `pages_show_list`
  * `pages_read_engagement`
* **OAuth & App Review Requirements:**
  * Facebook Login OAuth 2.0 with Business Verification and Meta App Review for Live mode access.
  * Development mode is strictly limited to users who have accepted Developer or Tester roles on the Meta App Dashboard.
* **Media Binary URL Availability:** **CONDITIONALLY AVAILABLE.**
  * Endpoint: `GET /{ig-media-id}?fields=id,media_type,media_url,thumbnail_url,permalink`
  * When requested by the owning account, `media_url` returns an HTTPS URL to the video file (`.mp4`) hosted on Meta's CDN (`*.cdninstagram.com` / `*.fbcdn.net`).
* **URL Expiration:**
  * CDN links returned by `media_url` are signed and **expire after approximately 24 hours**. They cannot be stored as permanent identifiers.
* **Licensed Audio / Music Restriction:** **CRITICAL LIMITATION.**
  * Meta's official documentation explicitly specifies:
    > *"For Instagram Reels or videos containing copyrighted music from the Instagram audio library, the `media_url` field is completely omitted from the response, even when requested by the creator who published the Reel."*
  * Consequently, any Reel using trending or licensed audio cannot be retrieved as an MP4 binary via the API.
* **Token Storage & Security Requirements:**
  * Short-lived tokens must be exchanged for 60-day long-lived access tokens.
  * Tokens must be stored server-side encrypted with AES-256-GCM.
  * Meta requires all applications to expose a publicly accessible Data Deletion Callback URL (`/api/auth/meta/data-deletion`) and handle webhook notifications.
* **Conclusion for Instagram:**
  * **Conditionally feasible ONLY for Instagram Professional accounts** whose videos do not contain library music. Requires extensive Meta App Review, Business Verification, and encryption infrastructure.

---

### 2.3 Facebook (Meta Graph API — Video & Page Endpoints)

* **Current API Products:**
  * Meta Graph API v21.0 (`https://graph.facebook.com/v21.0/`)
* **Account Types Supported:**
  * Facebook Page Administrators or authenticated users with administrative permissions.
* **Permissions / Scopes Required:**
  * `pages_read_engagement`, `pages_read_user_content`, `user_videos`.
* **Media Binary URL Availability:** **RESTRICTED TO ADMINS.**
  * Endpoint: `GET /{page-video-id}?fields=id,title,description,source`
  * Meta's official Graph API documentation states:
    > *"The playable video `source` MP4 URL is only returned if the user making the request has an administrative or editor role on the Page that published the video. For non-admin callers, `source` is always omitted (null)."*
* **Terms of Service Restrictions:**
  * Meta Platform Terms Section 3.a explicitly prohibits building tools that download or store content published by third parties without their explicit consent.
* **Conclusion for Facebook:**
  * **Feasible only for Page Administrators retrieving their own Page videos.** Third-party video downloads remain restricted to official sandboxed embed plugins.

---

## 3. Four-Tier Capability & Access Matrix

Platforms are evaluated across four distinct content access tiers:
* **Category A:** Public content accessible without authentication.
* **Category B:** Creator-owned content accessible through officially authorized APIs.
* **Category C:** Content requiring authentication or additional permissions.
* **Category D:** Content that cannot currently be retrieved through a documented, permitted method.

| Platform | Category A: Public Content (Unauthenticated) | Category B: Creator-Owned Content (Authorized APIs) | Category C: Authenticated / Permissioned Content | Category D: Undocumented / Prohibited Content | Reeva Support Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **YouTube** | **DOWNLOADABLE** (Direct extraction & streaming via clean local pipeline) | **DOWNLOADABLE** (YouTube Data API v3 / OAuth for channel owners) | Private / Unlisted videos (Requires channel owner OAuth) | DRM / Widevine protected streams | **WORKING (Baseline)** |
| **Twitter / X** | **DOWNLOADABLE** (Syndication endpoints & public mp4 CDN tracks) | **DOWNLOADABLE** (X API v2 with OAuth 2.0 user context) | Protected / Followers-only tweets | Deleted / DMCA-takedown tweets | **WORKING (Baseline)** |
| **Pinterest** | **DOWNLOADABLE** (OpenGraph meta tags & public video CDN streams) | **DOWNLOADABLE** (Pinterest Business API pins endpoint) | Secret / Invite-only group boards | Deleted / Account-restricted pins | **WORKING (Baseline)** |
| **Generic** | **DOWNLOADABLE** (Direct HTTP/HTTPS stream validation & FFmpeg decode) | N/A (Standard web server endpoints) | HTTP Basic / Bearer token gated endpoints | Encrypted / DRM-protected media | **WORKING (Baseline)** |
| **TikTok** | **RESTRICTED** (yt-dlp public web extractor, subject to anti-bot WAF & regional blocks) | **EMBED ONLY** (Display API v2 returns metadata & embed iframe; raw MP4 omitted) | Friends-only / Private videos | Bulk scraping & offline archiving prohibited by Terms §5.1; Indian regional block (IT Act §69A) | **EMBED FALLBACK ACTIVE** |
| **Instagram** | **RESTRICTED** (OpenGraph meta & embedded JSON, subject to login walls & IP limits) | **DOWNLOADABLE** (Instagram Graph API `media_url` for Professional accounts without library audio) | Private accounts, Stories, Close Friends | Third-party private content; Reels with licensed music library audio | **EMBED FALLBACK ACTIVE** |
| **Facebook** | **RESTRICTED** (OpenGraph & Relay JSON for public Watch/Reels, subject to login walls) | **DOWNLOADABLE** (Meta Graph API `source` field for Page Admins) | Private timeline posts, closed Facebook Groups | Third-party private content without administrative consent | **EMBED FALLBACK ACTIVE** |

---

## 4. Proposed Architecture for Future Creator-Authorized Phase

Should Reeva proceed with implementing creator-authorized backups in a future release, the following architectural controls are required:

1. **OAuth 2.0 PKCE Flow:**
   * Implement strict state verification with encrypted HMAC cookies to prevent CSRF during authorization callback.
2. **Encrypted Token Vault:**
   * Access tokens and refresh tokens must never be written to logs or disk in plaintext.
   * Implement AES-256-GCM envelope encryption using a dedicated master key (`REEVA_OAUTH_TOKEN_ENCRYPTION_KEY`).
3. **Data Deletion Compliance:**
   * Mount a cryptographically signed endpoint `POST /api/auth/meta/data-deletion` to process user data deletion requests in real time according to Meta Platform Terms Section 6.
4. **Transient Streaming Pipeline:**
   * Media fetched via `media_url` or `source` must be piped ephemerally directly to the authenticated creator's client stream using `StreamMeter`, with zero persistent disk storage of copyrighted assets.
