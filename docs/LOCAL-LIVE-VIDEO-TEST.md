# Local Live Video Smoke Test

This procedure tests the actual Reeva HTTP pipeline on your development computer. It does not require a public deployment or a public domain.

## Safety and scope

- Use a public test video you own or are expressly authorized to download.
- Do not use login cookies or attempt to bypass login walls, CAPTCHA, DRM, or other access restrictions.
- A passing result confirms a non-empty recognized video-container signature was returned through Reeva. It does not prove every codec works or that the file plays to completion.
- Never paste your `.env` contents, access tokens, or other secrets into an issue or chat.

## 1. Start Reeva locally

Open PowerShell in the repository root. Install dependencies if needed:

```powershell
npm ci
```

Start the app in a separate PowerShell terminal using development mode:

```powershell
$env:NODE_ENV = "development"
npm start
```

Keep this terminal open. Confirm the app is listening on port 3000, or use the port configured by your local environment.

Development mode enables integrations by default unless a platform flag explicitly disables one. This is a local-development convenience, not a production recommendation. The YouTube adapter also needs a working yt-dlp installation and may need FFmpeg for combined video-and-audio downloads.

## 2. Run the smoke test from a second PowerShell terminal

In a second terminal, change to the same repository root. Replace the example URL with a video you are authorized to download:

```powershell
$env:REEVA_BASE_URL = "http://127.0.0.1:3000"
$env:REEVA_TEST_PLATFORM = "youtube"
$env:REEVA_TEST_VIDEO_URL = "https://www.youtube.com/watch?v=REPLACE_WITH_AUTHORIZED_VIDEO_ID"
$env:REEVA_TEST_MAX_BYTES = "104857600"
node scripts/live-video-smoke.cjs
```

The maximum is 100 MiB by default. If the authorized test video is larger, choose a deliberate byte limit that remains within the local resource budget. Do not set an unbounded limit.

## 3. Interpret the result

A pass should report the platform, Content-Type, bytes downloaded, and a recognized MP4, WebM, FLV, or AVI container signature.

A failure should be investigated using its actual HTTP status and structured error code. Common categories include:

- `503 PLATFORM_DISABLED`: the selected platform is disabled by configuration.
- Readiness failure: Reeva is not listening on the configured base URL or is still starting.
- Upstream timeout/challenge/private content: the provider did not permit the extraction; do not attempt to bypass the restriction.
- Missing yt-dlp or FFmpeg: the local extraction runtime is not configured for the selected mode.
- Byte-limit failure: the result exceeded the configured test limit.

Do not change application code merely to turn a failed test green. Record the actual error first, then identify the smallest justified fix.

## 4. What a pass does and does not prove

A passing smoke test establishes that one chosen test URL traversed the local Reeva extraction and media-response path and produced a file with a recognized container signature. It is not proof of full playback, long-video reliability, platform authorization, or support for other platforms. Repeat separately for each platform using an authorized test asset.

The script removes its temporary downloaded test artifact after completion.
