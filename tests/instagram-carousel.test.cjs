// tests/instagram-carousel.test.cjs — Complete Instagram Carousel Test Suite
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("stream");

const {
    extractInstagram,
    extractInstagramNativeFallback,
    extractCarouselItemsFromMedia,
    extractCarouselFromHtml
} = require("../lib/extraction/adapters/instagram.cjs");

const { validateExtractionResult } = require("../lib/extraction/result-validator.cjs");
const { defaultRegistry } = require("../lib/media-registry.cjs");
const { createUiController } = require("../public/js/ui.js");

function stringToStream(str) {
    return Readable.from([Buffer.from(str, "utf8")]);
}

// ==============================================================================
// 1. ADAPTER LEVEL: CAROUSEL EXTRACTION & ORDERING TESTS
// ==============================================================================

test("Carousel Adapter: Multi-image carousel extracts all items in original order", () => {
    const mockMedia = {
        __typename: "XDTGraphSidecar",
        edge_sidecar_to_children: {
            edges: [
                { node: { id: "101", is_video: false, display_url: "https://scontent.cdninstagram.com/img1.jpg", dimensions: { width: 1080, height: 1080 } } },
                { node: { id: "102", is_video: false, display_url: "https://scontent.cdninstagram.com/img2.jpg", dimensions: { width: 1080, height: 1350 } } },
                { node: { id: "103", is_video: false, display_url: "https://scontent.cdninstagram.com/img3.jpg", dimensions: { width: 1080, height: 1080 } } }
            ]
        }
    };

    const items = extractCarouselItemsFromMedia(mockMedia, "Test Multi-Image");
    assert.ok(Array.isArray(items), "Should return array of items");
    assert.equal(items.length, 3, "All 3 items extracted");

    assert.equal(items[0].index, 0);
    assert.equal(items[0].type, "image");
    assert.equal(items[0].url, "https://scontent.cdninstagram.com/img1.jpg");
    assert.equal(items[0].width, 1080);
    assert.equal(items[0].height, 1080);

    assert.equal(items[1].index, 1);
    assert.equal(items[1].type, "image");
    assert.equal(items[1].url, "https://scontent.cdninstagram.com/img2.jpg");
    assert.equal(items[1].height, 1350);

    assert.equal(items[2].index, 2);
    assert.equal(items[2].type, "image");
    assert.equal(items[2].url, "https://scontent.cdninstagram.com/img3.jpg");
});

test("Carousel Adapter: Multi-video carousel extracts all videos in original order", () => {
    const mockMedia = {
        __typename: "XDTGraphSidecar",
        edge_sidecar_to_children: {
            edges: [
                {
                    node: {
                        id: "201",
                        is_video: true,
                        video_url: "https://scontent.cdninstagram.com/v1.mp4",
                        display_url: "https://scontent.cdninstagram.com/thumb1.jpg",
                        dimensions: { width: 1080, height: 1920 }
                    }
                },
                {
                    node: {
                        id: "202",
                        is_video: true,
                        video_url: "https://scontent.cdninstagram.com/v2.mp4",
                        display_url: "https://scontent.cdninstagram.com/thumb2.jpg",
                        dimensions: { width: 720, height: 1280 }
                    }
                }
            ]
        }
    };

    const items = extractCarouselItemsFromMedia(mockMedia, "Multi-Video");
    assert.equal(items.length, 2);
    assert.equal(items[0].type, "video");
    assert.equal(items[0].url, "https://scontent.cdninstagram.com/v1.mp4");
    assert.equal(items[0].thumbnailUrl, "https://scontent.cdninstagram.com/thumb1.jpg");
    assert.equal(items[1].type, "video");
    assert.equal(items[1].url, "https://scontent.cdninstagram.com/v2.mp4");
    assert.equal(items[1].thumbnailUrl, "https://scontent.cdninstagram.com/thumb2.jpg");
});

test("Carousel Adapter: Mixed video and image carousel correctly distinguishes types", () => {
    const mockMedia = {
        __typename: "XDTGraphSidecar",
        edge_sidecar_to_children: {
            edges: [
                { node: { id: "301", is_video: false, display_url: "https://scontent.cdninstagram.com/slide1.jpg" } },
                { node: { id: "302", is_video: true, video_url: "https://scontent.cdninstagram.com/slide2.mp4", display_url: "https://scontent.cdninstagram.com/slide2_thumb.jpg" } },
                { node: { id: "303", is_video: false, display_url: "https://scontent.cdninstagram.com/slide3.jpg" } }
            ]
        }
    };

    const items = extractCarouselItemsFromMedia(mockMedia, "Mixed Carousel");
    assert.equal(items.length, 3);
    assert.equal(items[0].type, "image");
    assert.equal(items[0].url, "https://scontent.cdninstagram.com/slide1.jpg");

    assert.equal(items[1].type, "video");
    assert.equal(items[1].url, "https://scontent.cdninstagram.com/slide2.mp4");
    assert.equal(items[1].thumbnailUrl, "https://scontent.cdninstagram.com/slide2_thumb.jpg");

    assert.equal(items[2].type, "image");
    assert.equal(items[2].url, "https://scontent.cdninstagram.com/slide3.jpg");
});

test("Carousel Adapter: Handles carousel_media REST format structure", () => {
    const mockMedia = {
        carousel_media: [
            {
                id: "c1",
                media_type: 1,
                image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/rest1.jpg", width: 1080, height: 1080 }] }
            },
            {
                id: "c2",
                media_type: 2,
                video_versions: [{ url: "https://scontent.cdninstagram.com/rest2.mp4", width: 720, height: 1280 }],
                image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/rest2_thumb.jpg" }] }
            }
        ]
    };

    const items = extractCarouselItemsFromMedia(mockMedia, "REST Carousel");
    assert.equal(items.length, 2);
    assert.equal(items[0].type, "image");
    assert.equal(items[0].url, "https://scontent.cdninstagram.com/rest1.jpg");
    assert.equal(items[1].type, "video");
    assert.equal(items[1].url, "https://scontent.cdninstagram.com/rest2.mp4");
    assert.equal(items[1].thumbnailUrl, "https://scontent.cdninstagram.com/rest2_thumb.jpg");
});

test("Carousel Adapter: Malformed children are skipped without discarding valid items", () => {
    const mockMedia = {
        edge_sidecar_to_children: {
            edges: [
                { node: { id: "valid1", is_video: false, display_url: "https://scontent.cdninstagram.com/v1.jpg" } },
                { node: null }, // Null node
                { node: { id: "no_url", is_video: false } }, // Missing display_url
                { node: { id: "empty_url", is_video: true, video_url: "   " } }, // Empty URL
                { node: { id: "valid2", is_video: false, display_url: "https://scontent.cdninstagram.com/v2.jpg" } }
            ]
        }
    };

    const items = extractCarouselItemsFromMedia(mockMedia, "Fault Tolerance");
    assert.equal(items.length, 2, "Only 2 valid items should be extracted");
    assert.equal(items[0].url, "https://scontent.cdninstagram.com/v1.jpg");
    assert.equal(items[0].index, 0);
    assert.equal(items[1].url, "https://scontent.cdninstagram.com/v2.jpg");
    assert.equal(items[1].index, 1);
});

test("Carousel Adapter: Empty carousel structure returns null", () => {
    assert.equal(extractCarouselItemsFromMedia(null), null);
    assert.equal(extractCarouselItemsFromMedia({}), null);
    assert.equal(extractCarouselItemsFromMedia({ edge_sidecar_to_children: { edges: [] } }), null);
    assert.equal(extractCarouselItemsFromMedia({ carousel_media: [] }), null);
});

// ==============================================================================
// 2. END-TO-END FALLBACK WITH CAROUSEL DATA
// ==============================================================================

test("GraphQL Fallback: Returns top-level backward-compatible fields AND items array", async () => {
    const mockGqlResponse = {
        data: {
            xdt_shortcode_media: {
                __typename: "XDTGraphSidecar",
                edge_media_to_caption: { edges: [{ node: { text: "Vacation Photos" } }] },
                edge_sidecar_to_children: {
                    edges: [
                        { node: { is_video: false, display_url: "https://scontent.cdninstagram.com/p1.jpg" } },
                        { node: { is_video: true, video_url: "https://scontent.cdninstagram.com/v2.mp4", display_url: "https://scontent.cdninstagram.com/thumb2.jpg" } },
                        { node: { is_video: false, display_url: "https://scontent.cdninstagram.com/p3.jpg" } }
                    ]
                }
            }
        }
    };

    const mockFetchFn = async () => ({
        response: { ok: true, status: 200, body: stringToStream(JSON.stringify(mockGqlResponse)) },
        abort: () => {},
        clearTimeout: () => {}
    });

    const result = await extractInstagramNativeFallback("https://www.instagram.com/p/DA123456789/", {
        fetchFn: mockFetchFn
    });

    // Top-level compatibility fields
    assert.equal(result.url, "https://scontent.cdninstagram.com/v2.mp4", "Selects video as primary candidate if present");
    assert.equal(result.type, "video");
    assert.equal(result.title, "Vacation Photos");

    // Carousel items collection
    assert.ok(Array.isArray(result.items), "Items array must be returned");
    assert.equal(result.items.length, 3, "Contains all 3 items");
    assert.equal(result.items[0].type, "image");
    assert.equal(result.items[0].url, "https://scontent.cdninstagram.com/p1.jpg");
    assert.equal(result.items[1].type, "video");
    assert.equal(result.items[1].url, "https://scontent.cdninstagram.com/v2.mp4");
    assert.equal(result.items[1].thumbnailUrl, "https://scontent.cdninstagram.com/thumb2.jpg");
    assert.equal(result.items[2].type, "image");
    assert.equal(result.items[2].url, "https://scontent.cdninstagram.com/p3.jpg");
});

test("Crawler Strategy: Embedded HTML sidecar JSON extracts carousel cleanly", async () => {
    const htmlWithSidecar = `
    <!DOCTYPE html>
    <html>
    <head><title>Carousel on Instagram</title></head>
    <body>
    <script type="application/json">
    {
        "require": [],
        "xdt_shortcode_media": {
            "__typename": "XDTGraphSidecar",
            "edge_media_to_caption": { "edges": [{ "node": { "text": "HTML Carousel Post" } }] },
            "edge_sidecar_to_children": {
                "edges": [
                    { "node": { "is_video": false, "display_url": "https://scontent.cdninstagram.com/html1.jpg" } },
                    { "node": { "is_video": false, "display_url": "https://scontent.cdninstagram.com/html2.jpg" } }
                ]
            }
        }
    }
    </script>
    </body>
    </html>
    `;

    const result = await extractInstagram("https://www.instagram.com/p/DA123456789/", {
        fetchHtml: async () => htmlWithSidecar
    });

    assert.ok(result);
    assert.equal(result.title, "Carousel on Instagram");
    assert.ok(Array.isArray(result.items));
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].url, "https://scontent.cdninstagram.com/html1.jpg");
    assert.equal(result.items[1].url, "https://scontent.cdninstagram.com/html2.jpg");
});

// ==============================================================================
// 3. RESULT VALIDATOR: CAROUSEL SECURITY & DOMAIN VALIDATION
// ==============================================================================

test("Result Validator: Validates every carousel item and strips unapproved CDN domains", async () => {
    const rawResult = {
        url: "https://scontent.cdninstagram.com/primary.mp4",
        type: "video",
        title: "Test Security",
        items: [
            { index: 0, type: "video", url: "https://scontent.cdninstagram.com/valid1.mp4" },
            { index: 1, type: "image", url: "https://evil-unapproved.com/hack.jpg" }, // Unapproved CDN
            { index: 2, type: "image", url: "https://fbcdn.net/valid2.jpg", thumbnailUrl: "https://unapproved-thumb.com/t.jpg" }, // Valid media, unapproved thumb
            { index: 3, type: "unsupported_type", url: "https://scontent.cdninstagram.com/valid3.mp4" } // Invalid type
        ]
    };

    const validated = await validateExtractionResult(rawResult, "instagram");

    assert.equal(validated.url, "https://scontent.cdninstagram.com/primary.mp4");
    assert.ok(Array.isArray(validated.items));
    assert.equal(validated.items.length, 2, "Only items with approved domains and valid types are retained");

    assert.equal(validated.items[0].url, "https://scontent.cdninstagram.com/valid1.mp4");
    assert.equal(validated.items[1].url, "https://fbcdn.net/valid2.jpg");
    assert.equal(validated.items[1].thumbnailUrl, null, "Unapproved thumbnail was safely stripped");
});

// ==============================================================================
// 4. REGISTRY & TOKEN GENERATION FOR CAROUSEL ITEMS
// ==============================================================================

test("Media Registry: Issues independent opaque download tokens for each carousel item", () => {
    const item1 = defaultRegistry.registerMedia({
        upstreamUrl: "https://scontent.cdninstagram.com/item1.mp4",
        platform: "instagram",
        type: "video",
        title: "Item 1"
    });

    const item2 = defaultRegistry.registerMedia({
        upstreamUrl: "https://scontent.cdninstagram.com/item2.jpg",
        platform: "instagram",
        type: "image",
        title: "Item 2"
    });

    assert.ok(item1.id.startsWith("med_"));
    assert.ok(item2.id.startsWith("med_"));
    assert.notEqual(item1.id, item2.id, "Tokens must be unique");

    // Verify registry can look up both independent entries
    const resolved1 = defaultRegistry.getMedia(item1.id);
    const resolved2 = defaultRegistry.getMedia(item2.id);

    assert.equal(resolved1.upstreamUrl, "https://scontent.cdninstagram.com/item1.mp4");
    assert.equal(resolved2.upstreamUrl, "https://scontent.cdninstagram.com/item2.jpg");
});

// ==============================================================================
// 5. FRONTEND UI CONTROLLER: CAROUSEL RENDERING
// ==============================================================================

test("Frontend UI Controller: showCarousel builds responsive grid with media cards and download links", () => {
    // Minimal mock document
    const mockElements = new Map();
    function createMockElement(tag) {
        const children = [];
        const attrs = new Map();
        const listeners = new Map();
        return {
            tagName: tag.toUpperCase(),
            className: "",
            style: {},
            children,
            textContent: "",
            innerHTML: "",
            src: "",
            poster: "",
            controls: false,
            playsInline: false,
            loading: "",
            disabled: false,
            setAttribute(k, v) { attrs.set(k, String(v)); },
            getAttribute(k) { return attrs.get(k) || null; },
            removeAttribute(k) { attrs.delete(k); },
            appendChild(c) { children.push(c); return c; },
            removeChild(c) {
                const idx = children.indexOf(c);
                if (idx !== -1) children.splice(idx, 1);
                return c;
            },
            get firstChild() { return children[0] || null; },
            querySelectorAll(sel) {
                const res = [];
                function traverse(node) {
                    if (node.tagName && node.tagName.toLowerCase() === sel.toLowerCase()) {
                        res.push(node);
                    }
                    if (node.children) {
                        for (const ch of node.children) traverse(ch);
                    }
                }
                traverse(this);
                return res;
            },
            addEventListener(ev, fn) {
                if (!listeners.has(ev)) listeners.set(ev, []);
                listeners.get(ev).push(fn);
            },
            classList: {
                classes: new Set(),
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            }
        };
    }

    const carouselContainer = createMockElement("div");
    carouselContainer.id = "carousel-container";
    const previewEl = createMockElement("video");
    previewEl.id = "preview";
    const downloadBtn = createMockElement("button");
    downloadBtn.id = "download";
    const logEl = createMockElement("div");
    logEl.id = "log";

    const mockDoc = {
        getElementById(id) {
            if (id === "carousel-container") return carouselContainer;
            if (id === "preview") return previewEl;
            if (id === "download") return downloadBtn;
            if (id === "log") return logEl;
            return null;
        },
        querySelectorAll() { return []; },
        createElement(tag) { return createMockElement(tag); },
        createTextNode(text) { return { textContent: text }; }
    };

    const ui = createUiController(mockDoc);
    assert.ok(ui);
    assert.ok(typeof ui.showCarousel === "function");
    assert.ok(typeof ui.hideCarousel === "function");

    const sampleItems = [
        { index: 0, type: "image", streamUrl: "/api/media/med_1", downloadUrl: "/api/media/med_1?download=1", thumbnailUrl: "/api/media/thumb_1" },
        { index: 1, type: "video", streamUrl: "/api/media/med_2", downloadUrl: "/api/media/med_2?download=1", thumbnailUrl: "/api/media/thumb_2" }
    ];

    ui.showCarousel(sampleItems);

    // Verify grid container rendered
    assert.equal(carouselContainer.children.length, 1);
    const grid = carouselContainer.children[0];
    assert.equal(grid.className, "carousel-grid");
    assert.equal(grid.children.length, 2, "2 carousel cards created");

    // Inspect Card 1 (Image)
    const card1 = grid.children[0];
    assert.equal(card1.className, "carousel-card");
    const pos1 = card1.children[0].children[0];
    assert.equal(pos1.textContent, "1 of 2");
    const type1 = card1.children[0].children[1];
    assert.equal(type1.textContent, "Photo");

    // Inspect Card 2 (Video)
    const card2 = grid.children[1];
    const pos2 = card2.children[0].children[0];
    assert.equal(pos2.textContent, "2 of 2");
    const type2 = card2.children[0].children[1];
    assert.equal(type2.textContent, "Video");

    // Verify hideCarousel pauses and resets
    ui.hideCarousel();
    assert.equal(carouselContainer.children.length, 0);
    assert.ok(carouselContainer.classList.contains("hidden"));
});

// ==============================================================================
// 6. STABILIZATION: CAROUSEL FILENAMES & ERROR CLASSIFICATION
// ==============================================================================

test("Filename Stabilization: Carousel items receive sequential padded filenames while single media preserves unpadded name", () => {
    // Single media
    const singleMedia = defaultRegistry.registerMedia({
        upstreamUrl: "https://scontent.cdninstagram.com/single.mp4",
        platform: "instagram",
        type: "video"
    });
    const retrievedSingle = defaultRegistry.getMedia(singleMedia.id);
    assert.equal(retrievedSingle.carouselIndex, null);

    // Carousel items with sequential indexes
    const carouselItem1 = defaultRegistry.registerMedia({
        upstreamUrl: "https://scontent.cdninstagram.com/item1.jpg",
        platform: "instagram",
        type: "image",
        carouselIndex: 1
    });
    const carouselItem2 = defaultRegistry.registerMedia({
        upstreamUrl: "https://scontent.cdninstagram.com/item2.mp4",
        platform: "instagram",
        type: "video",
        carouselIndex: 2
    });

    const retrieved1 = defaultRegistry.getMedia(carouselItem1.id);
    const retrieved2 = defaultRegistry.getMedia(carouselItem2.id);

    assert.equal(retrieved1.carouselIndex, 1);
    assert.equal(retrieved2.carouselIndex, 2);

    // Helper simulating filename generator in server.cjs
    function computeFilename(entry, ext) {
        let filename = `reeva_${entry.platform || "media"}`;
        if (typeof entry.carouselIndex === "number" && entry.carouselIndex > 0) {
            filename += `_${String(entry.carouselIndex).padStart(2, "0")}`;
        }
        return `${filename}.${ext}`;
    }

    assert.equal(computeFilename(retrievedSingle, "mp4"), "reeva_instagram.mp4", "Single media preserves unpadded filename");
    assert.equal(computeFilename(retrieved1, "jpg"), "reeva_instagram_01.jpg", "Carousel item 1 is padded to _01");
    assert.equal(computeFilename(retrieved2, "mp4"), "reeva_instagram_02.mp4", "Carousel item 2 is padded to _02");
});

test("Error Classification: Upstream HTTP 401/403 access challenges map to PLATFORM_CHALLENGE", async () => {
    const { extractInstagram } = require("../lib/extraction/adapters/instagram.cjs");
    const { EXTRACTION_ERROR_CODES } = require("../lib/extraction/index.cjs");

    // Mock fetchHtml throwing 401 on crawler UA
    const mockFetchHtml = async () => {
        const { SecurityHTTPError } = require("../lib/http-client.cjs");
        throw new SecurityHTTPError("Instagram returned HTTP 401", 401);
    };

    // Mock direct provider throwing 401 on fallback
    const mockProvider = {
        instagramGetUrl: async () => {
            const { SecurityHTTPError } = require("../lib/http-client.cjs");
            throw new SecurityHTTPError("Instagram GraphQL challenge 401", 401);
        }
    };

    await assert.rejects(
        async () => {
            await extractInstagram("https://www.instagram.com/p/C-mock401/", {
                fetchHtml: mockFetchHtml,
                provider: mockProvider
            });
        },
        (err) => {
            assert.equal(err.code, EXTRACTION_ERROR_CODES.PLATFORM_CHALLENGE);
            assert.equal(err.statusCode, 403);
            assert.ok(err.message.includes("authentication challenge or access restriction"));
            return true;
        }
    );
});

test("Frontend: Video thumbnail uses IntersectionObserver lazy loading when supported", () => {
    let observedElements = [];
    const mockWindow = {
        IntersectionObserver: class {
            constructor(callback) {
                this.callback = callback;
            }
            observe(target) {
                observedElements.push(target);
            }
            unobserve(target) {
                observedElements = observedElements.filter(el => el !== target);
            }
        }
    };

    function createMockElement(tag) {
        return {
            tagName: tag.toUpperCase(),
            children: [],
            className: "",
            id: "",
            dataset: {},
            style: {},
            classList: {
                classes: new Set(),
                add(c) { this.classes.add(c); },
                remove(c) { this.classes.delete(c); },
                contains(c) { return this.classes.has(c); }
            },
            appendChild(child) { this.children.push(child); return child; },
            removeChild(child) { this.children = this.children.filter(c => c !== child); return child; },
            setAttribute(k, v) { this[k] = v; },
            getAttribute(k) { return this[k]; },
            removeAttribute(k) { delete this[k]; },
            addEventListener(ev, fn) {},
            pause() {}
        };
    }

    const container = createMockElement("div");
    const mockDoc = {
        getElementById(id) {
            if (id === "carousel-container") return container;
            return createMockElement("div");
        },
        querySelectorAll() { return []; },
        createElement(tag) { return createMockElement(tag); }
    };

    const ui = createUiController(mockDoc, mockWindow);
    ui.showCarousel([
        { index: 0, type: "video", streamUrl: "/api/media/v1", downloadUrl: "/api/media/v1?download=1", thumbnailUrl: "/api/media/thumb1" }
    ]);

    // Inspect video element
    const grid = container.children[0];
    const card = grid.children[0];
    const mediaWrapper = card.children[1];
    const videoEl = mediaWrapper.children[0];

    assert.equal(videoEl.tagName, "VIDEO");
    assert.equal(videoEl.dataset.poster, "/api/media/thumb1", "Poster saved to dataset.poster for viewport loading");
    assert.equal(videoEl.poster, undefined, "Video poster NOT set directly before intersection");
    assert.equal(observedElements.length, 1, "Video element is registered with IntersectionObserver");

    // Inspect download link attribute
    const footer = card.children[2];
    const downloadLink = footer.children[0];
    assert.equal(downloadLink.download, "reeva_instagram_01.mp4", "HTML5 download attribute is formatted as reeva_instagram_01.mp4");
});
