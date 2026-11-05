# Reeva Creator-Authorized Backup Capabilities & API Investigation

**Date:** October 30, 2026  
**Status:** Research & Architecture Specification (Phase 4.3 Staging Audit)  
**Governing Principle:** Do not implement creator backup features until official documented capabilities support them and developer review/permissions are established. Do not conflate public extraction capabilities with official API permissions.

---

## 1. Executive Summary & Objective

Reeva's core product goal is to provide a reliable, secure media download and preview service across supported platforms. While platforms like YouTube, Twitter/X, Pinterest, and Generic HTTP endpoints support direct media streaming within lawful parameters, platforms such as **TikTok**, **Instagram**, and **Facebook** enforce aggressive edge bot-detection (Akamai/Cloudflare/Pumbaa JS stubs) and strictly restrict unauthenticated scraping.

This document investigates the feasibility of **Creator-Authorized Personal Backups**—an architecture where content owners grant OAuth consent allowing Reeva to retrieve their own published content for backup and archiving. Every API investigated below is strictly audited against current official documentation, distinguishing metadata access from actual binary media retrieval and evaluating platform terms of service.

---

## 2. Platform-by-Platform API Investigation

### 2.1 YouTube (Google / YouTube Data API v3)

* **Official Documentation:**
  * [YouTube Data API v3 Overview](https://developers.google.com/youtube/v3/getting-started)
  * [YouTube API Reference: Videos](https://developers.google.com/youtube/v3/docs/videos)
  * [YouTube Terms of Service](https://www.youtube.com/t/terms)
  * [YouTube API Developer Policies](https://developers.google.com/youtube/terms/developer-policies)
* **Verification Date:** October 30, 2026
* **Current API Products:**
  * YouTube Data API v3 (`https://www.googleapis.com/youtube/v3/`)
  * YouTube Analytics and Reporting APIs
* **Account Types Supported:**
  * Any Google/YouTube account via OAuth 2.0.
* **Permissions / Scopes Available:**
  * `https://www.googleapis.com/auth/youtube.readonly` (read metadata, playlists, channel info)
  * `https://www.googleapis.com/auth/youtube.upload` (upload videos)
  * `https://www.googleapis.com/auth/youtube` (manage account)
* **Media Binary URL Availability:** **UNAVAILABLE (NOT SUPPORTED BY API).**
  * The `videos.list` endpoint returns snippet, contentDetails, status, and statistics metadata.
  * **YouTube Data API v3 does NOT provide any endpoint or field returning downloadable video binaries (`.mp4`, `.webm`, or raw stream URLs).**
  * Granting creator OAuth consent (`youtube.readonly` or `youtube`) does not provide a media binary download URL. Video files cannot be downloaded via the official YouTube API regardless of authentication.
* **Terms of Service Restrictions:**
  * Section 5.B of the YouTube Terms of Service and Section III.E of the Developer Policies state:
    > *"You shall not download any Content unless you see a 'download' or similar link displayed by YouTube on the Service for that Content."*
  * Developer policies explicitly forbid creating applications whose primary purpose is downloading, archiving, or offline caching of YouTube audio-visual streams.
* **Reeva Implementation Distinction:**
  * Reeva's working YouTube downloader relies entirely on the local, maintained `yt-dlp` subprocess extraction pipeline running in server-side isolation, not the official YouTube Data API.
* **Conclusion for YouTube:**
  * The official YouTube Data API v3 cannot be used as a video binary download or backup provider.

---

### 2.2 X / Twitter (X API v2)

* **Official Documentation:**
  * [X API v2 Tweet Lookup](https://developer.x.com/en/docs/x-api/tweets/lookup/api-reference/get-tweets-id)
  * [X Developer Agreement and Policy](https://developer.x.com/en/developer-terms/agreement-and-policy)
* **Verification Date:** October 30, 2026
* **Current API Products:**
  * X API v2 (`https://api.twitter.com/2/`)
* **Account Types Supported:**
  * Developer accounts on Free, Basic, Pro, or Enterprise tiers.
* **Permissions / Scopes Available:**
  * `tweet.read`, `users.read` via OAuth 2.0 Authorization Code with PKCE.
* **Media Binary URL Availability:** **METADATA EXPANSION ONLY (NOT A CREATOR BACKUP MECHANISM).**
  * When querying `GET /2/tweets/:id?expansions=attachments.media_keys&media.fields=variants,url,type`, the API returns public media variants for video tweets.
  * The `variants` array contains public bitrate options pointing to CDN URLs (`video.twimg.com`).
  * **Critical Distinction:** These CDN URLs are the same public syndication variants delivered to standard web clients. Authenticating as the tweet's creator does not yield master archives or uncompressed binaries beyond the public delivery stream.
* **Developer Agreement Restrictions:**
  * Section VII of the X Developer Agreement forbids mass caching, saving, or downloading of media assets for offline redistribution or permanent storage without explicit per-user rights.
  * Having access to a media variant URL does not automatically grant legal permission to archive or redistribute content.
* **Reeva Implementation Distinction:**
  * Reeva extracts public Twitter/X videos via secure syndication API endpoints and OpenGraph metadata directly to the client with live frame verification, remaining compliant with ephemeral streaming principles.
* **Conclusion for X / Twitter:**
  * X API v2 does not offer a dedicated creator backup endpoint; video variants returned in expansions are public CDN links subject to strict developer usage terms.

---

### 2.3 Instagram (Meta Graph API — Instagram Platform)

* **Official Documentation:**
  * [Instagram Platform Overview](https://developers.facebook.com/docs/instagram-platform)
  * [Instagram Media Graph API Reference](https://developers.facebook.com/docs/instagram-platform/reference/instagram-media)
  * [Meta Platform Terms](https://developers.facebook.com/terms)
* **Verification Date:** October 30, 2026
* **Current API Products:**
  * Instagram Graph API (`https://graph.facebook.com/v21.0/`)
  * *Deprecation Notice:* The consumer-facing **Instagram Basic Display API was permanently decommissioned by Meta on December 4, 2024**. Integrations targeting ordinary personal accounts are no longer possible.
* **Account Types Supported:**
  * **Instagram Professional Accounts only** (Creator or Business) linked to a Facebook Page. Personal consumer accounts cannot use the Graph API.
* **Permissions / Scopes Required:**
  * `instagram_basic`, `pages_show_list`, `pages_read_engagement`
* **OAuth & App Review Requirements:**
  * Mandatory Facebook Login OAuth 2.0 with Business Verification and Meta App Review for Live mode. Sandbox mode is restricted to users registered as Developers/Testers.
* **Media Binary URL Availability:** **CONDITIONALLY AVAILABLE (OWNED CONTENT ONLY).**
  * Endpoint: `GET /{ig-media-id}?fields=id,media_type,media_url,thumbnail_url,permalink`
  * When called with a valid creator access token for content owned by that account, `media_url` returns a signed HTTPS CDN URL (`*.cdninstagram.com` / `*.fbcdn.net`).
* **Critical Known Limitations:**
  * **24-Hour Expiration:** CDN URLs returned by `media_url` are signed with temporary tokens that expire after approximately 24 hours.
  * **Copyrighted Music Exclusion:** Meta's documentation explicitly states:
    > *"For Instagram Reels or videos containing copyrighted music from the Instagram audio library, the `media_url` field is completely omitted from the response, even when requested by the creator who published the Reel."*
    Reels created with trending or licensed library tracks cannot be downloaded via the official API.
* **Terms of Service Restrictions:**
  * Meta Platform Terms Section 3.a prohibits storing or archiving third-party content without express user consent. User Data Deletion Callback URL (`/api/auth/meta/data-deletion`) is mandatory.
* **Conclusion for Instagram:**
  * Feasible exclusively for Professional creators retrieving their own non-music Reels/videos. Ordinary personal accounts and third-party downloads are unsupported by the official API.

---

### 2.4 Facebook (Meta Graph API — Video & Page Endpoints)

* **Official Documentation:**
  * [Meta Graph API Video Node](https://developers.facebook.com/docs/graph-api/reference/video/)
  * [Meta Platform Terms](https://developers.facebook.com/terms)
* **Verification Date:** October 30, 2026
* **Current API Products:**
  * Meta Graph API v21.0 (`https://graph.facebook.com/v21.0/`)
* **Account Types Supported:**
  * Facebook Page Administrators or authenticated users with administrative permissions on the publishing Page.
* **Permissions / Scopes Required:**
  * `pages_read_engagement`, `pages_read_user_content`, `user_videos`
* **Media Binary URL Availability:** **RESTRICTED TO ADMINS/EDITORS.**
  * Endpoint: `GET /{page-video-id}?fields=id,title,description,source`
  * Meta's official Graph API documentation states:
    > *"The playable video `source` MP4 URL is only returned if the user making the request has an administrative or editor role on the Page that published the video. For non-admin callers, `source` is always omitted (null)."*
* **Known Limitations:**
  * Non-admin users cannot obtain video binary URLs for Facebook videos via the API.
  * Embedded video players (`https://www.facebook.com/plugins/video.php?href=...`) are the only officially supported display mechanism for non-admin requests.
* **Conclusion for Facebook:**
  * The official API supports downloads only for Page Administrators backing up their own Page video assets. Third-party video downloads are not supported via the API.

---

### 2.5 TikTok (TikTok for Developers — Display API v2)

* **Official Documentation:**
  * [TikTok Display API v2 Overview](https://developers.tiktok.com/doc/display-api-v2-overview)
  * [TikTok Display API Reference: Video List](https://developers.tiktok.com/doc/display-api-reference-get-video-list)
  * [TikTok Developer Terms of Service](https://developers.tiktok.com/doc/terms-of-service)
* **Verification Date:** October 30, 2026
* **Current API Products:**
  * TikTok Display API v2 (`https://open.tiktokapis.com/v2/`)
  * TikTok Content Posting API
  * TikTok Research API (Academic / Non-commercial only)
* **Account Types Supported:**
  * Any public TikTok account (Personal, Creator, or Business) via OAuth 2.0 PKCE flow.
* **Permissions / Scopes Required:**
  * `video.list`
* **OAuth & App Review Requirements:**
  * Mandatory TikTok Developer Portal App Review to release an application to Live mode. Sandbox mode is restricted to a maximum of 5 registered test TikTok accounts.
* **Media Binary URL Availability:** **UNAVAILABLE (EMBEDS AND METADATA ONLY).**
  * The `POST /v2/video/list/` endpoint returns:
    * `id` (video ID)
    * `title` (video description)
    * `embed_link` (HTTPS URL to iframe player)
    * `embed_html` (blockquote embed code)
    * `share_url` (canonical web link)
    * `cover_image_url` (thumbnail JPEG/PNG)
    * `duration`, `width`, `height`, `like_count`, `view_count`
  * **TikTok does NOT expose raw `.mp4` video binary URLs anywhere in the Display API.**
* **Terms of Service Restrictions:**
  * Section 5.1 of the TikTok Developer Terms strictly prohibits caching, saving, downloading, or archiving audio-visual content delivered via the Display API.
* **Conclusion for TikTok:**
  * Direct video binary download is not possible via official TikTok APIs. Official sandboxed iframe embeds (`https://www.tiktok.com/embed/v2/{video_id}`) are the only officially supported integration.

---

## 3. Four-Tier Capability & Access Matrix

Platforms are evaluated across four distinct content access tiers:
* **Category A:** Public content accessible without authentication.
* **Category B:** Creator-owned content accessible through officially authorized APIs.
* **Category C:** Content requiring authentication or additional permissions.
* **Category D:** Content that cannot currently be retrieved through a documented, permitted method.

| Platform | Category A: Public Content (Unauthenticated) | Category B: Creator-Owned Content (Authorized APIs) | Category C: Authenticated / Permissioned Content | Category D: Undocumented / Prohibited Content | Reeva Support Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **YouTube** | **DOWNLOADABLE** (Direct extraction & streaming via clean local yt-dlp pipeline) | **NOT SUPPORTED BY API** (Data API v3 provides metadata and upload only; raw MP4 download is omitted by design and prohibited by Terms §5.B) | Private / Unlisted videos (Manageable via OAuth, but video binaries still omitted by API) | DRM / Widevine protected streams | **WORKING (Baseline)** |
| **Twitter / X** | **DOWNLOADABLE** (Syndication endpoints & public mp4 CDN tracks) | **PUBLIC VARIANTS ONLY** (X API v2 returns public CDN variants; not a dedicated creator backup mechanism, restricted by Developer Agreement) | Protected / Followers-only tweets | Deleted / DMCA-takedown tweets | **WORKING (Baseline)** |
| **Pinterest** | **DOWNLOADABLE** (OpenGraph meta tags & public video CDN streams) | **PINS API** (Pinterest API provides pin metadata and URLs; downloads governed by standard terms) | Secret / Invite-only group boards | Deleted / Account-restricted pins | **WORKING (Baseline)** |
| **Generic** | **DOWNLOADABLE** (Direct HTTP/HTTPS stream validation & FFmpeg decode) | N/A (Standard web server endpoints) | HTTP Basic / Bearer token gated endpoints | Encrypted / DRM-protected media | **WORKING (Baseline)** |
| **TikTok** | **RESTRICTED** (yt-dlp public web extractor, subject to anti-bot WAF & regional blocks) | **EMBED ONLY** (Display API v2 returns metadata & embed iframe; raw MP4 omitted by design) | Friends-only / Private videos | Bulk scraping & offline archiving prohibited by Terms §5.1; Indian regional block (IT Act §69A) | **EMBED FALLBACK ACTIVE** |
| **Instagram** | **RESTRICTED** (OpenGraph meta & embedded JSON, subject to login walls & IP limits) | **DOWNLOADABLE (CONDITIONAL)** (Instagram Graph API `media_url` for Professional accounts only; omitted if post contains library music) | Private accounts, Stories, Close Friends | Third-party private content; Reels with licensed music library audio | **EMBED FALLBACK ACTIVE** |
| **Facebook** | **RESTRICTED** (OpenGraph & Relay JSON for public Watch/Reels, subject to login walls) | **DOWNLOADABLE (CONDITIONAL)** (Meta Graph API `source` field for Page Admins only) | Private timeline posts, closed Facebook Groups | Third-party private content without administrative consent | **EMBED FALLBACK ACTIVE** |

---

## 4. Proposed Architecture for Future Creator-Authorized Phase

Should Reeva proceed with implementing creator-authorized backups in a future release for supported platforms (Instagram Professional / Facebook Page Admins), the following architectural controls are required:

1. **OAuth 2.0 PKCE Flow:**
   * Implement strict state verification with encrypted HMAC cookies to prevent CSRF during authorization callback.
2. **Encrypted Token Vault:**
   * Access tokens and refresh tokens must never be written to logs or disk in plaintext.
   * Implement AES-256-GCM envelope encryption using a dedicated master key (`REEVA_OAUTH_TOKEN_ENCRYPTION_KEY`).
3. **Data Deletion Compliance:**
   * Mount a cryptographically signed endpoint `POST /api/auth/meta/data-deletion` to process user data deletion requests in real time according to Meta Platform Terms Section 6.
4. **Transient Streaming Pipeline:**
   * Media fetched via `media_url` or `source` must be piped ephemerally directly to the authenticated creator's client stream using `StreamMeter`, with zero persistent disk storage of copyrighted assets.
