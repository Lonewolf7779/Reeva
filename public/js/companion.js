// public/js/companion.js — Reeva Interactive Anime Companion Character System
"use strict";

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.ReevaCompanion = factory();
    }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {

    // =========================================================================
    // 1. Companion States & Configuration
    // =========================================================================
    const STATES = {
        IDLE: "IDLE",
        WELCOME: "WELCOME",
        CURIOUS: "CURIOUS",
        PLATFORM_SELECTED: "PLATFORM_SELECTED",
        PROCESSING: "PROCESSING",
        SUCCESS: "SUCCESS",
        FAILURE: "FAILURE",
        INVALID_URL: "INVALID_URL",
        NETWORK_ERROR: "NETWORK_ERROR",
        IDLE_SUCCESS: "IDLE_SUCCESS"
    };

    // State Priorities: Higher priority events interrupt lower priority states
    const STATE_PRIORITIES = {
        [STATES.IDLE]: 1,
        [STATES.IDLE_SUCCESS]: 1,
        [STATES.CURIOUS]: 2,
        [STATES.PLATFORM_SELECTED]: 2,
        [STATES.WELCOME]: 3,
        [STATES.PROCESSING]: 4,
        [STATES.INVALID_URL]: 5,
        [STATES.NETWORK_ERROR]: 5,
        [STATES.FAILURE]: 6,
        [STATES.SUCCESS]: 6
    };

    // State Messages (English & Hindi support with safe fallback)
    const COMPANION_MESSAGES = {
        [STATES.WELCOME]: {
            en: "Hey! Ready to save something amazing?",
            hi: "नमस्ते! क्या आप कुछ नया डाउनलोड करने के लिए तैयार हैं?"
        },
        [STATES.CURIOUS]: {
            en: "Ooh, what video are we getting?",
            hi: "अरे वाह, कौन सा वीडियो ला रहे हैं?"
        },
        [STATES.PLATFORM_SELECTED]: {
            en: "Nice choice! Paste the link whenever you're ready.",
            hi: "बढ़िया चुनाव! जब तैयार हों, लिंक पेस्ट करें।"
        },
        [STATES.PROCESSING]: {
            en: "Working on it! Just a moment...",
            hi: "प्रोसेस हो रहा है! बस कुछ ही पल..."
        },
        [STATES.SUCCESS]: {
            en: "Yay! Your video is ready to download!",
            hi: "वाह! आपका वीडियो डाउनलोड के लिए तैयार है!"
        },
        [STATES.FAILURE]: {
            en: "Aww... that didn't work. I'm so sorry!",
            hi: "ओह... यह डाउनलोड नहीं हो पाया। मुझे खेद है!"
        },
        [STATES.INVALID_URL]: {
            en: "Hmm... this link doesn't look right. Could you check it?",
            hi: "हम्म... यह लिंक सही नहीं लग रहा। क्या आप जांच सकते हैं?"
        },
        [STATES.NETWORK_ERROR]: {
            en: "Looks like the connection is having trouble.",
            hi: "लगता है नेटवर्क कनेक्शन में समस्या है।"
        }
    };

    // =========================================================================
    // 2. Companion Vector Art Assets (High-Res Layered SVG)
    // =========================================================================
    const CompanionAssets = {
        getCharacterSVG() {
            return `
            <svg id="companion-svg" viewBox="0 0 200 240" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Reeva Anime Companion">
                <defs>
                    <!-- Skin Gradient -->
                    <radialGradient id="comp-skin" cx="50%" cy="40%" r="55%">
                        <stop offset="0%" stop-color="#fff8f2" />
                        <stop offset="70%" stop-color="#ffeedf" />
                        <stop offset="100%" stop-color="#f8dcce" />
                    </radialGradient>

                    <!-- Hair Gradient (Soft Lavender-Silver) -->
                    <linearGradient id="comp-hair" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stop-color="#e9e8f5" />
                        <stop offset="50%" stop-color="#d6d4ea" />
                        <stop offset="100%" stop-color="#b8b5dc" />
                    </linearGradient>

                    <!-- Hair Back Gradient -->
                    <linearGradient id="comp-hair-back" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stop-color="#c5c2e0" />
                        <stop offset="100%" stop-color="#9a96c3" />
                    </linearGradient>

                    <!-- Eye Gradient (Warm Amber-Gold) -->
                    <linearGradient id="comp-eye-grad" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stop-color="#e07a2c" />
                        <stop offset="50%" stop-color="#f39c12" />
                        <stop offset="100%" stop-color="#f1c40f" />
                    </linearGradient>

                    <!-- Tear Gradient -->
                    <linearGradient id="comp-tear" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stop-color="#e0f7fa" />
                        <stop offset="100%" stop-color="#4dd0e1" />
                    </linearGradient>

                    <!-- Tech Coat Gradient -->
                    <linearGradient id="comp-jacket" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stop-color="#1f242e" />
                        <stop offset="100%" stop-color="#111317" />
                    </linearGradient>

                    <!-- Soft Blush Gradient -->
                    <radialGradient id="comp-blush" cx="50%" cy="50%" r="50%">
                        <stop offset="0%" stop-color="#ff6b81" stop-opacity="0.45" />
                        <stop offset="100%" stop-color="#ff6b81" stop-opacity="0" />
                    </radialGradient>
                </defs>

                <!-- ROOT COMPANION GROUP FOR BREATHING & POSES -->
                <g id="comp-body-root">

                    <!-- LAYER 1: BACK HAIR -->
                    <g id="comp-layer-hair-back">
                        <path d="M 60 70 Q 30 110 40 180 Q 75 190 90 170 Z" fill="url(#comp-hair-back)" />
                        <path d="M 140 70 Q 170 110 160 180 Q 125 190 110 170 Z" fill="url(#comp-hair-back)" />
                    </g>

                    <!-- LAYER 2: TORSO & CLOTHING -->
                    <g id="comp-layer-torso">
                        <!-- Neck -->
                        <path d="M 91 105 L 109 105 L 112 125 L 88 125 Z" fill="#ffeedf" />
                        <path d="M 92 110 Q 100 116 108 110 Z" fill="#f5d6c6" opacity="0.6" />

                        <!-- Inner Turtleneck Collar -->
                        <path d="M 85 120 Q 100 126 115 120 L 117 136 Q 100 142 83 136 Z" fill="#2d3436" />

                        <!-- Torso / Jacket -->
                        <path d="M 72 135 C 60 145 52 175 48 215 C 65 218 135 218 152 215 C 148 175 140 145 128 135 Z" fill="url(#comp-jacket)" />

                        <!-- Lapels and Trim -->
                        <path d="M 78 135 L 94 175 L 88 215 L 75 215 Z" fill="#2d3436" />
                        <path d="M 122 135 L 106 175 L 112 215 L 125 215 Z" fill="#2d3436" />

                        <!-- Reeva Emblem on Jacket -->
                        <circle cx="82" cy="162" r="5" fill="#f4f4f5" />
                        <path d="M 80 160 L 85 162 L 80 164 Z" fill="#111317" />
                    </g>

                    <!-- LAYER 3: ARMS & HANDS (Posable via transforms) -->
                    <!-- Left Arm / Hand -->
                    <g id="comp-arm-left">
                        <path d="M 68 140 Q 50 170 54 195 Q 62 198 68 185 Q 74 165 76 148 Z" fill="url(#comp-jacket)" />
                        <!-- Left Hand -->
                        <circle cx="56" cy="196" r="6" fill="#ffeedf" />
                    </g>

                    <!-- Right Arm / Hand (Default Down, Animates to Wave or Cheer) -->
                    <g id="comp-arm-right" style="transform-origin: 130px 145px;">
                        <path d="M 132 140 Q 150 170 146 195 Q 138 198 132 185 Q 126 165 124 148 Z" fill="url(#comp-jacket)" />
                        <!-- Right Hand -->
                        <circle id="comp-hand-right" cx="144" cy="196" r="6" fill="#ffeedf" />
                    </g>

                    <!-- Celebrating Arms (Hidden by default, shown during SUCCESS) -->
                    <g id="comp-arms-celebrating" class="comp-variant-hidden">
                        <!-- Left arm up -->
                        <path d="M 72 140 Q 40 115 36 85 Q 46 80 56 100 Q 70 120 76 142 Z" fill="url(#comp-jacket)" />
                        <circle cx="36" cy="82" r="7" fill="#ffeedf" />
                        <!-- Right arm up -->
                        <path d="M 128 140 Q 160 115 164 85 Q 154 80 144 100 Q 130 120 124 142 Z" fill="url(#comp-jacket)" />
                        <circle cx="164" cy="82" r="7" fill="#ffeedf" />
                    </g>

                    <!-- LAYER 4: HEAD, FACE & EXPRESSIONS -->
                    <g id="comp-head-group" style="transform-origin: 100px 105px;">
                        <!-- Head Base -->
                        <path d="M 65 65 C 65 35 135 35 135 65 C 135 90 120 112 100 118 C 80 112 65 90 65 65 Z" fill="url(#comp-skin)" />

                        <!-- Ears -->
                        <path d="M 63 68 C 58 64 57 78 64 82 Z" fill="#ffeedf" />
                        <path d="M 137 68 C 142 64 143 78 136 82 Z" fill="#ffeedf" />

                        <!-- Cheek Blushes (Cute anime glow) -->
                        <ellipse id="comp-blush-left" cx="77" cy="83" rx="9" ry="5" fill="url(#comp-blush)" />
                        <ellipse id="comp-blush-right" cx="123" cy="83" rx="9" ry="5" fill="url(#comp-blush)" />

                        <!-- NOSE -->
                        <path d="M 100 80 L 99 83 L 101 83 Z" fill="#e0b8a4" />

                        <!-- EYEBROWS (Posable / Switchable) -->
                        <g id="comp-brows">
                            <!-- Neutral Brows -->
                            <g id="comp-brows-neutral">
                                <path d="M 75 62 Q 85 60 92 63" stroke="#635985" stroke-width="2.2" stroke-linecap="round" fill="none" />
                                <path d="M 125 62 Q 115 60 108 63" stroke="#635985" stroke-width="2.2" stroke-linecap="round" fill="none" />
                            </g>
                            <!-- Sad / Concerned Brows -->
                            <g id="comp-brows-sad" class="comp-variant-hidden">
                                <path d="M 75 60 Q 85 64 92 63" stroke="#635985" stroke-width="2.2" stroke-linecap="round" fill="none" />
                                <path d="M 125 60 Q 115 64 108 63" stroke="#635985" stroke-width="2.2" stroke-linecap="round" fill="none" />
                            </g>
                            <!-- Curious / Inquisitive Brows -->
                            <g id="comp-brows-curious" class="comp-variant-hidden">
                                <path d="M 75 58 Q 85 57 92 62" stroke="#635985" stroke-width="2.2" stroke-linecap="round" fill="none" />
                                <path d="M 125 64 Q 115 63 108 64" stroke="#635985" stroke-width="2.2" stroke-linecap="round" fill="none" />
                            </g>
                        </g>

                        <!-- EYES (Interactive Switchable Variants) -->
                        <g id="comp-eyes">
                            <!-- 1. Normal / Open Eyes -->
                            <g id="comp-eyes-normal">
                                <!-- Left Eye -->
                                <g id="comp-eye-left" style="transform-origin: 82px 73px;">
                                    <ellipse cx="82" cy="73" rx="8" ry="11" fill="url(#comp-eye-grad)" />
                                    <!-- Pupil -->
                                    <circle cx="82" cy="74" r="5" fill="#3d1b06" />
                                    <!-- Highlights -->
                                    <circle cx="80" cy="69" r="3.2" fill="#ffffff" />
                                    <circle cx="84" cy="76" r="1.6" fill="#ffffff" />
                                    <!-- Top Eyelash -->
                                    <path d="M 73 68 C 76 64 88 64 92 69" stroke="#1f1830" stroke-width="3" stroke-linecap="round" fill="none" />
                                </g>
                                <!-- Right Eye -->
                                <g id="comp-eye-right" style="transform-origin: 118px 73px;">
                                    <ellipse cx="118" cy="73" rx="8" ry="11" fill="url(#comp-eye-grad)" />
                                    <!-- Pupil -->
                                    <circle cx="118" cy="74" r="5" fill="#3d1b06" />
                                    <!-- Highlights -->
                                    <circle cx="116" cy="69" r="3.2" fill="#ffffff" />
                                    <circle cx="120" cy="76" r="1.6" fill="#ffffff" />
                                    <!-- Top Eyelash -->
                                    <path d="M 127 68 C 124 64 112 64 108 69" stroke="#1f1830" stroke-width="3" stroke-linecap="round" fill="none" />
                                </g>
                            </g>

                            <!-- 2. Happy / Smiling Eyes (Curved happy anime arcs) -->
                            <g id="comp-eyes-happy" class="comp-variant-hidden">
                                <path d="M 74 72 Q 82 65 91 72" stroke="#1f1830" stroke-width="3.2" stroke-linecap="round" fill="none" />
                                <path d="M 126 72 Q 118 65 109 72" stroke="#1f1830" stroke-width="3.2" stroke-linecap="round" fill="none" />
                            </g>

                            <!-- 3. Star Eyes (Celebrating / Success) -->
                            <g id="comp-eyes-star" class="comp-variant-hidden">
                                <g transform="translate(82, 73)">
                                    <polygon points="0,-9 2.5,-3 8.5,-2.5 4,2 5.5,8 0,4.5 -5.5,8 -4,2 -8.5,-2.5 -2.5,-3" fill="#f1c40f" />
                                    <circle cx="0" cy="0" r="2" fill="#ffffff" />
                                </g>
                                <g transform="translate(118, 73)">
                                    <polygon points="0,-9 2.5,-3 8.5,-2.5 4,2 5.5,8 0,4.5 -5.5,8 -4,2 -8.5,-2.5 -2.5,-3" fill="#f1c40f" />
                                    <circle cx="0" cy="0" r="2" fill="#ffffff" />
                                </g>
                            </g>

                            <!-- 4. Crying Eyes (Watery, tear trails) -->
                            <g id="comp-eyes-crying" class="comp-variant-hidden">
                                <ellipse cx="82" cy="74" rx="8" ry="10" fill="#4fc3f7" />
                                <ellipse cx="118" cy="74" rx="8" ry="10" fill="#4fc3f7" />
                                <circle cx="81" cy="71" r="3.5" fill="#ffffff" />
                                <circle cx="117" cy="71" r="3.5" fill="#ffffff" />
                                <path d="M 73 70 Q 82 66 91 70" stroke="#1f1830" stroke-width="3" stroke-linecap="round" fill="none" />
                                <path d="M 127 70 Q 118 66 109 70" stroke="#1f1830" stroke-width="3" stroke-linecap="round" fill="none" />
                                <!-- Animated tear streams -->
                                <path id="comp-tear-left" d="M 80 82 Q 78 95 81 110" stroke="url(#comp-tear)" stroke-width="3.5" stroke-linecap="round" fill="none" />
                                <path id="comp-tear-right" d="M 120 82 Q 122 95 119 110" stroke="url(#comp-tear)" stroke-width="3.5" stroke-linecap="round" fill="none" />
                            </g>

                            <!-- 5. Confused / Dizzy Eyes (Invalid URL) -->
                            <g id="comp-eyes-confused" class="comp-variant-hidden">
                                <!-- Spiral eye -->
                                <circle cx="82" cy="73" r="7" stroke="#1f1830" stroke-width="2" fill="none" stroke-dasharray="3,2" />
                                <circle cx="82" cy="73" r="3" fill="#1f1830" />
                                <path d="M 74 68 Q 82 65 90 69" stroke="#1f1830" stroke-width="2.8" stroke-linecap="round" fill="none" />
                                <!-- Normal wide eye -->
                                <circle cx="118" cy="73" r="6" fill="url(#comp-eye-grad)" />
                                <circle cx="117" cy="71" r="2.5" fill="#ffffff" />
                                <path d="M 126 67 Q 118 63 110 68" stroke="#1f1830" stroke-width="2.8" stroke-linecap="round" fill="none" />
                            </g>
                        </g>

                        <!-- MOUTH (Switchable Expressions) -->
                        <g id="comp-mouths">
                            <!-- Neutral Smile -->
                            <path id="comp-mouth-neutral" d="M 94 92 Q 100 97 106 92" stroke="#d63031" stroke-width="2" stroke-linecap="round" fill="none" />
                            <!-- Open Happy Smile -->
                            <path id="comp-mouth-happy" class="comp-variant-hidden" d="M 93 91 Q 100 102 107 91 Z" fill="#e17055" stroke="#d63031" stroke-width="1.5" />
                            <!-- Wide Excited / Celebrating Mouth -->
                            <path id="comp-mouth-excited" class="comp-variant-hidden" d="M 90 90 Q 100 106 110 90 Z" fill="#ff7675" stroke="#d63031" stroke-width="1.8" />
                            <!-- Curious Small "o" -->
                            <circle id="comp-mouth-curious" class="comp-variant-hidden" cx="100" cy="93" r="3.5" fill="#d63031" />
                            <!-- Sad / Quivering Pout -->
                            <path id="comp-mouth-sad" class="comp-variant-hidden" d="M 94 95 Q 100 91 106 95" stroke="#d63031" stroke-width="2" stroke-linecap="round" fill="none" />
                            <!-- Focused Flat Line -->
                            <path id="comp-mouth-focused" class="comp-variant-hidden" d="M 96 92 L 104 92" stroke="#d63031" stroke-width="2" stroke-linecap="round" fill="none" />
                        </g>

                        <!-- LAYER 5: FRONT HAIR & BANGS -->
                        <g id="comp-layer-hair-front">
                            <!-- Main Bangs and Flowing Tuft -->
                            <path d="M 64 56 C 65 30 135 30 136 56 C 136 68 126 80 120 70 C 114 60 110 75 100 68 C 90 75 86 60 80 70 C 74 80 64 68 64 56 Z" fill="url(#comp-hair)" />

                            <!-- Soft Highlights on Bangs -->
                            <path d="M 78 48 Q 100 42 122 48" stroke="#ffffff" stroke-width="3" stroke-linecap="round" opacity="0.65" fill="none" />

                            <!-- Side Tufts Framing Face -->
                            <path d="M 64 65 Q 58 92 68 118 Q 72 102 68 85 Z" fill="url(#comp-hair)" />
                            <path d="M 136 65 Q 142 92 132 118 Q 128 102 132 85 Z" fill="url(#comp-hair)" />

                            <!-- Animated Ahoge (Playful Hair Strand on Top) -->
                            <path id="comp-ahoge" d="M 100 36 C 96 20 86 16 90 10 C 96 14 102 24 100 36 Z" fill="url(#comp-hair)" style="transform-origin: 100px 36px;" />
                        </g>

                        <!-- ACCESSORIES & EMOTE FX -->
                        <g id="comp-emotes">
                            <!-- Question Mark (Curious / Confused) -->
                            <g id="comp-emote-question" class="comp-variant-hidden" transform="translate(132, 35)">
                                <circle cx="8" cy="8" r="10" fill="#6c5ce7" />
                                <text x="8" y="13" font-size="14" font-family="'Urbanist', sans-serif" font-weight="700" fill="#ffffff" text-anchor="middle">?</text>
                            </g>

                            <!-- Sweatdrop (Confused / Error) -->
                            <g id="comp-emote-sweatdrop" class="comp-variant-hidden" transform="translate(60, 48)">
                                <path d="M 6 0 C 6 0 0 8 0 12 C 0 15 2.5 18 6 18 C 9.5 18 12 15 12 12 C 12 8 6 0 6 0 Z" fill="#74b9ff" />
                            </g>

                            <!-- Sparkle Star (Success / Celebration) -->
                            <g id="comp-emote-sparkle" class="comp-variant-hidden" transform="translate(138, 40)">
                                <polygon points="6,0 8,4 12,6 8,8 6,12 4,8 0,6 4,4" fill="#fdcb6e" />
                            </g>

                            <!-- Gears / Working Spinner (Processing) -->
                            <g id="comp-emote-gear" class="comp-variant-hidden" transform="translate(135, 42)">
                                <circle cx="8" cy="8" r="7" stroke="#00cec9" stroke-width="2.5" fill="none" stroke-dasharray="6,4" />
                            </g>
                        </g>

                    </g> <!-- END HEAD GROUP -->

                </g> <!-- END ROOT BODY GROUP -->
            </svg>
            `;
        }
    };

    // =========================================================================
    // 3. Speech Bubble Message System (CompanionMessage)
    // =========================================================================
    class CompanionMessage {
        constructor(containerEl) {
            this.container = containerEl;
            this.bubbleEl = null;
            this.textEl = null;
            this.closeBtn = null;
            this.dismissTimer = null;
            this.activeMessage = null;

            this._initDOM();
        }

        _initDOM() {
            const bubble = document.createElement("div");
            bubble.className = "companion-speech-bubble hidden";
            bubble.setAttribute("role", "status");
            bubble.setAttribute("aria-live", "polite");

            const content = document.createElement("p");
            content.className = "companion-speech-text";

            const close = document.createElement("button");
            close.type = "button";
            close.className = "companion-speech-close";
            close.setAttribute("aria-label", "Dismiss message");
            close.innerHTML = "&times;";
            close.addEventListener("click", () => this.hide());

            bubble.appendChild(content);
            bubble.appendChild(close);

            if (this.container.firstChild) {
                this.container.insertBefore(bubble, this.container.firstChild);
            } else {
                this.container.appendChild(bubble);
            }
            this.bubbleEl = bubble;
            this.textEl = content;
            this.closeBtn = close;
        }

        show(text, autoDismissMs = 4500) {
            if (!this.bubbleEl || !this.textEl) return;
            if (this.dismissTimer) {
                clearTimeout(this.dismissTimer);
                this.dismissTimer = null;
            }

            this.activeMessage = text;
            this.textEl.textContent = text;
            this.bubbleEl.classList.remove("hidden", "bubble-exit");
            this.bubbleEl.classList.add("bubble-enter");

            if (autoDismissMs > 0) {
                this.dismissTimer = setTimeout(() => {
                    this.hide();
                }, autoDismissMs);
            }
        }

        hide() {
            if (!this.bubbleEl || this.bubbleEl.classList.contains("hidden")) return;
            if (this.dismissTimer) {
                clearTimeout(this.dismissTimer);
                this.dismissTimer = null;
            }

            this.bubbleEl.classList.remove("bubble-enter");
            this.bubbleEl.classList.add("bubble-exit");

            setTimeout(() => {
                if (this.bubbleEl && this.bubbleEl.classList.contains("bubble-exit")) {
                    this.bubbleEl.classList.add("hidden");
                    this.bubbleEl.classList.remove("bubble-exit");
                    this.activeMessage = null;
                }
            }, 250);
        }
    }

    // =========================================================================
    // 4. Animation Engine (Anime.js + CSS Hardware-Accelerated Fallback)
    // =========================================================================
    class CompanionAnimations {
        constructor(rootEl, svgEl) {
            this.rootEl = rootEl;
            this.svgEl = svgEl;
            this.animeLib = (typeof anime === "function") ? anime : null;
            this.idleTimeline = null;
            this.blinkInterval = null;
            this.isReducedMotion = false;

            this._checkReducedMotion();
        }

        _checkReducedMotion() {
            if (typeof window !== "undefined" && window.matchMedia) {
                const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
                this.isReducedMotion = mq.matches;
                if (mq.addEventListener) {
                    mq.addEventListener("change", (e) => {
                        this.isReducedMotion = e.matches;
                        if (this.isReducedMotion) this.stopIdle();
                        else this.startIdle();
                    });
                }
            }
        }

        startIdle() {
            if (this.isReducedMotion || !this.svgEl) return;
            this.stopIdle();

            // Natural Blinking Timer (Random 3.2s to 5s)
            const scheduleNextBlink = () => {
                const delay = 3200 + Math.random() * 2200;
                this.blinkInterval = setTimeout(() => {
                    this.playBlink();
                    scheduleNextBlink();
                }, delay);
            };
            scheduleNextBlink();

            // Ahoge playful hair sway with Anime.js
            const ahogeEl = this.svgEl.querySelector("#comp-ahoge");
            if (this.animeLib && ahogeEl) {
                this.animeLib({
                    targets: ahogeEl,
                    rotate: [-3, 4],
                    duration: 2400,
                    direction: "alternate",
                    loop: true,
                    easing: "easeInOutSine"
                });
            }
        }

        stopIdle() {
            if (this.blinkInterval) {
                clearTimeout(this.blinkInterval);
                this.blinkInterval = null;
            }
            if (this.animeLib && this.svgEl) {
                const ahogeEl = this.svgEl.querySelector("#comp-ahoge");
                if (ahogeEl) this.animeLib.remove(ahogeEl);
            }
        }

        playBlink() {
            if (this.isReducedMotion || !this.svgEl) return;
            const eyeLeft = this.svgEl.querySelector("#comp-eye-left");
            const eyeRight = this.svgEl.querySelector("#comp-eye-right");
            if (!eyeLeft || !eyeRight) return;

            // Only blink if normal eyes are visible
            const normalEyes = this.svgEl.querySelector("#comp-eyes-normal");
            if (!normalEyes || normalEyes.classList.contains("comp-variant-hidden")) return;

            if (this.animeLib) {
                this.animeLib({
                    targets: [eyeLeft, eyeRight],
                    scaleY: [
                        { value: 0.05, duration: 80, easing: "easeInQuad" },
                        { value: 1, duration: 120, easing: "easeOutQuad" }
                    ]
                });
            } else {
                eyeLeft.style.transform = "scaleY(0.1)";
                eyeRight.style.transform = "scaleY(0.1)";
                setTimeout(() => {
                    eyeLeft.style.transform = "scaleY(1)";
                    eyeRight.style.transform = "scaleY(1)";
                }, 120);
            }
        }

        playWelcome() {
            if (this.isReducedMotion || !this.rootEl) return;
            const armRight = this.svgEl ? this.svgEl.querySelector("#comp-arm-right") : null;

            if (this.animeLib) {
                // Cheerful entrance scale & bob
                this.animeLib({
                    targets: this.rootEl,
                    translateY: [24, 0],
                    opacity: [0, 1],
                    duration: 650,
                    easing: "easeOutCubic"
                });

                // Waving hand
                if (armRight) {
                    this.animeLib({
                        targets: armRight,
                        rotate: [0, -32, -8, -28, 0],
                        duration: 1200,
                        delay: 300,
                        easing: "easeInOutQuad"
                    });
                }
            } else {
                this.rootEl.classList.add("anim-welcome");
                setTimeout(() => this.rootEl.classList.remove("anim-welcome"), 1200);
            }
        }

        playCurious() {
            if (this.isReducedMotion || !this.svgEl) return;
            const headGroup = this.svgEl.querySelector("#comp-head-group");
            if (this.animeLib && headGroup) {
                this.animeLib({
                    targets: headGroup,
                    rotate: [-5],
                    translateX: [-3],
                    duration: 350,
                    easing: "easeOutQuad"
                });
            }
        }

        resetHeadPose() {
            if (!this.svgEl) return;
            const headGroup = this.svgEl.querySelector("#comp-head-group");
            if (this.animeLib && headGroup) {
                this.animeLib({
                    targets: headGroup,
                    rotate: [0],
                    translateX: [0],
                    duration: 300,
                    easing: "easeOutQuad"
                });
            }
        }

        playProcessing() {
            if (this.isReducedMotion || !this.svgEl) return;
            const gear = this.svgEl.querySelector("#comp-emote-gear");
            if (this.animeLib && gear) {
                this.animeLib({
                    targets: gear,
                    rotate: [0, 360],
                    duration: 2000,
                    loop: true,
                    easing: "linear"
                });
            }
        }

        stopProcessing() {
            if (this.animeLib && this.svgEl) {
                const gear = this.svgEl.querySelector("#comp-emote-gear");
                if (gear) this.animeLib.remove(gear);
            }
        }

        playSuccess() {
            if (this.isReducedMotion || !this.rootEl) return;
            if (this.animeLib) {
                this.animeLib({
                    targets: this.rootEl,
                    translateY: [
                        { value: -22, duration: 250, easing: "easeOutQuad" },
                        { value: 0, duration: 350, easing: "easeInBounce" }
                    ]
                });
            } else {
                this.rootEl.classList.add("anim-bounce");
                setTimeout(() => this.rootEl.classList.remove("anim-bounce"), 700);
            }
        }

        playFailure() {
            if (this.isReducedMotion || !this.svgEl) return;
            const tearLeft = this.svgEl.querySelector("#comp-tear-left");
            const tearRight = this.svgEl.querySelector("#comp-tear-right");

            if (this.animeLib && tearLeft && tearRight) {
                this.animeLib({
                    targets: [tearLeft, tearRight],
                    translateY: [0, 16],
                    opacity: [1, 0],
                    duration: 1100,
                    loop: 2,
                    easing: "easeInQuad"
                });
            }
        }
    }

    // =========================================================================
    // 5. Companion Controller (State Machine & Event Integration)
    // =========================================================================
    class CompanionController {
        constructor(rootEl, options = {}) {
            this.rootEl = rootEl;
            this.options = options;
            this.state = STATES.IDLE;
            this.currentLanguage = options.initialLanguage || "en";
            this.svgEl = null;
            this.messageSystem = null;
            this.animationEngine = null;
            this.idleReturnTimer = null;

            this._mountDOM();
        }

        _mountDOM() {
            if (!this.rootEl) return;
            this.rootEl.innerHTML = "";
            this.rootEl.className = "companion-dock-wrapper";

            // Character Container
            const charContainer = document.createElement("div");
            charContainer.className = "companion-character-avatar";
            charContainer.innerHTML = CompanionAssets.getCharacterSVG();
            this.rootEl.appendChild(charContainer);

            this.svgEl = charContainer.querySelector("#companion-svg");

            // Initialize Message System & Animation Engine
            this.messageSystem = new CompanionMessage(this.rootEl);
            this.animationEngine = new CompanionAnimations(charContainer, this.svgEl);

            // Click character interaction (waves & smiles playfully)
            charContainer.addEventListener("click", () => {
                if (this.state === STATES.IDLE) {
                    this.triggerState(STATES.WELCOME, 2800);
                }
            });

            // Start in IDLE
            this.setExpression("idle");
            this.animationEngine.startIdle();
        }

        setLanguage(lang) {
            this.currentLanguage = lang === "hi" ? "hi" : "en";
        }

        getLocalizedMessage(stateKey) {
            const entry = COMPANION_MESSAGES[stateKey];
            if (!entry) return "";
            return entry[this.currentLanguage] || entry.en || "";
        }

        triggerState(newState, durationMs = 0) {
            const currentPriority = STATE_PRIORITIES[this.state] || 0;
            const newPriority = STATE_PRIORITIES[newState] || 0;

            // Prevent lower-priority events from interrupting critical workflows
            if (newPriority < currentPriority && this.state !== STATES.IDLE) {
                return;
            }

            if (this.idleReturnTimer) {
                clearTimeout(this.idleReturnTimer);
                this.idleReturnTimer = null;
            }

            this.state = newState;
            const msg = this.getLocalizedMessage(newState);

            switch (newState) {
                case STATES.WELCOME:
                    this.setExpression("happy");
                    this.setArms("normal");
                    this.showEmote(null);
                    this.animationEngine.playWelcome();
                    if (msg) this.messageSystem.show(msg, 4000);
                    this._scheduleReturnToIdle(4500);
                    break;

                case STATES.CURIOUS:
                    this.setExpression("curious");
                    this.setArms("normal");
                    this.showEmote("question");
                    this.animationEngine.playCurious();
                    if (msg) this.messageSystem.show(msg, 3500);
                    this._scheduleReturnToIdle(4000);
                    break;

                case STATES.PLATFORM_SELECTED:
                    this.setExpression("happy");
                    this.setArms("normal");
                    this.showEmote(null);
                    this.animationEngine.resetHeadPose();
                    if (msg) this.messageSystem.show(msg, 3200);
                    this._scheduleReturnToIdle(3800);
                    break;

                case STATES.PROCESSING:
                    this.setExpression("focused");
                    this.setArms("normal");
                    this.showEmote("gear");
                    this.animationEngine.playProcessing();
                    if (msg) this.messageSystem.show(msg, 0); // Keep open during active fetch
                    break;

                case STATES.SUCCESS:
                    this.animationEngine.stopProcessing();
                    this.setExpression("star");
                    this.setArms("celebrating");
                    this.showEmote("sparkle");
                    this.animationEngine.playSuccess();
                    if (msg) this.messageSystem.show(msg, 5000);
                    this._scheduleReturnToIdle(6000);
                    break;

                case STATES.FAILURE:
                    this.animationEngine.stopProcessing();
                    this.setExpression("crying");
                    this.setArms("normal");
                    this.showEmote("sweatdrop");
                    this.animationEngine.playFailure();
                    if (msg) this.messageSystem.show(msg, 5000);
                    this._scheduleReturnToIdle(6500);
                    break;

                case STATES.INVALID_URL:
                    this.animationEngine.stopProcessing();
                    this.setExpression("confused");
                    this.setArms("normal");
                    this.showEmote("sweatdrop");
                    if (msg) this.messageSystem.show(msg, 4200);
                    this._scheduleReturnToIdle(4500);
                    break;

                case STATES.NETWORK_ERROR:
                    this.animationEngine.stopProcessing();
                    this.setExpression("sad");
                    this.setArms("normal");
                    this.showEmote("sweatdrop");
                    if (msg) this.messageSystem.show(msg, 4500);
                    this._scheduleReturnToIdle(5000);
                    break;

                case STATES.IDLE:
                default:
                    this.animationEngine.stopProcessing();
                    this.animationEngine.resetHeadPose();
                    this.setExpression("idle");
                    this.setArms("normal");
                    this.showEmote(null);
                    this.animationEngine.startIdle();
                    break;
            }
        }

        _scheduleReturnToIdle(delayMs) {
            this.idleReturnTimer = setTimeout(() => {
                this.triggerState(STATES.IDLE);
            }, delayMs);
        }

        setExpression(exprName) {
            if (!this.svgEl) return;

            // Eyes Variants
            const eyesNormal = this.svgEl.querySelector("#comp-eyes-normal");
            const eyesHappy = this.svgEl.querySelector("#comp-eyes-happy");
            const eyesStar = this.svgEl.querySelector("#comp-eyes-star");
            const eyesCrying = this.svgEl.querySelector("#comp-eyes-crying");
            const eyesConfused = this.svgEl.querySelector("#comp-eyes-confused");

            // Mouths
            const mouthNeutral = this.svgEl.querySelector("#comp-mouth-neutral");
            const mouthHappy = this.svgEl.querySelector("#comp-mouth-happy");
            const mouthExcited = this.svgEl.querySelector("#comp-mouth-excited");
            const mouthCurious = this.svgEl.querySelector("#comp-mouth-curious");
            const mouthSad = this.svgEl.querySelector("#comp-mouth-sad");
            const mouthFocused = this.svgEl.querySelector("#comp-mouth-focused");

            // Brows
            const browsNeutral = this.svgEl.querySelector("#comp-brows-neutral");
            const browsSad = this.svgEl.querySelector("#comp-brows-sad");
            const browsCurious = this.svgEl.querySelector("#comp-brows-curious");

            const hideAll = (elements) => elements.forEach(el => el && el.classList.add("comp-variant-hidden"));
            hideAll([eyesNormal, eyesHappy, eyesStar, eyesCrying, eyesConfused,
                     mouthNeutral, mouthHappy, mouthExcited, mouthCurious, mouthSad, mouthFocused,
                     browsNeutral, browsSad, browsCurious]);

            switch (exprName) {
                case "happy":
                    if (eyesHappy) eyesHappy.classList.remove("comp-variant-hidden");
                    if (mouthHappy) mouthHappy.classList.remove("comp-variant-hidden");
                    if (browsNeutral) browsNeutral.classList.remove("comp-variant-hidden");
                    break;
                case "star":
                    if (eyesStar) eyesStar.classList.remove("comp-variant-hidden");
                    if (mouthExcited) mouthExcited.classList.remove("comp-variant-hidden");
                    if (browsNeutral) browsNeutral.classList.remove("comp-variant-hidden");
                    break;
                case "crying":
                    if (eyesCrying) eyesCrying.classList.remove("comp-variant-hidden");
                    if (mouthSad) mouthSad.classList.remove("comp-variant-hidden");
                    if (browsSad) browsSad.classList.remove("comp-variant-hidden");
                    break;
                case "confused":
                    if (eyesConfused) eyesConfused.classList.remove("comp-variant-hidden");
                    if (mouthCurious) mouthCurious.classList.remove("comp-variant-hidden");
                    if (browsCurious) browsCurious.classList.remove("comp-variant-hidden");
                    break;
                case "curious":
                    if (eyesNormal) eyesNormal.classList.remove("comp-variant-hidden");
                    if (mouthCurious) mouthCurious.classList.remove("comp-variant-hidden");
                    if (browsCurious) browsCurious.classList.remove("comp-variant-hidden");
                    break;
                case "focused":
                    if (eyesNormal) eyesNormal.classList.remove("comp-variant-hidden");
                    if (mouthFocused) mouthFocused.classList.remove("comp-variant-hidden");
                    if (browsNeutral) browsNeutral.classList.remove("comp-variant-hidden");
                    break;
                case "sad":
                    if (eyesNormal) eyesNormal.classList.remove("comp-variant-hidden");
                    if (mouthSad) mouthSad.classList.remove("comp-variant-hidden");
                    if (browsSad) browsSad.classList.remove("comp-variant-hidden");
                    break;
                case "idle":
                default:
                    if (eyesNormal) eyesNormal.classList.remove("comp-variant-hidden");
                    if (mouthNeutral) mouthNeutral.classList.remove("comp-variant-hidden");
                    if (browsNeutral) browsNeutral.classList.remove("comp-variant-hidden");
                    break;
            }
        }

        setArms(mode) {
            if (!this.svgEl) return;
            const armLeft = this.svgEl.querySelector("#comp-arm-left");
            const armRight = this.svgEl.querySelector("#comp-arm-right");
            const armsCeleb = this.svgEl.querySelector("#comp-arms-celebrating");

            if (mode === "celebrating") {
                if (armLeft) armLeft.classList.add("comp-variant-hidden");
                if (armRight) armRight.classList.add("comp-variant-hidden");
                if (armsCeleb) armsCeleb.classList.remove("comp-variant-hidden");
            } else {
                if (armLeft) armLeft.classList.remove("comp-variant-hidden");
                if (armRight) armRight.classList.remove("comp-variant-hidden");
                if (armsCeleb) armsCeleb.classList.add("comp-variant-hidden");
            }
        }

        showEmote(emoteName) {
            if (!this.svgEl) return;
            const q = this.svgEl.querySelector("#comp-emote-question");
            const s = this.svgEl.querySelector("#comp-emote-sweatdrop");
            const sp = this.svgEl.querySelector("#comp-emote-sparkle");
            const g = this.svgEl.querySelector("#comp-emote-gear");

            [q, s, sp, g].forEach(el => el && el.classList.add("comp-variant-hidden"));

            if (emoteName === "question" && q) q.classList.remove("comp-variant-hidden");
            if (emoteName === "sweatdrop" && s) s.classList.remove("comp-variant-hidden");
            if (emoteName === "sparkle" && sp) sp.classList.remove("comp-variant-hidden");
            if (emoteName === "gear" && g) g.classList.remove("comp-variant-hidden");
        }
    }

    return {
        STATES,
        STATE_PRIORITIES,
        COMPANION_MESSAGES,
        CompanionAssets,
        CompanionMessage,
        CompanionAnimations,
        CompanionController,
        initCompanion(rootId = "anime-companion-root", options = {}) {
            if (typeof document === "undefined") return null;
            const rootEl = document.getElementById(rootId);
            if (!rootEl) return null;
            const instance = new CompanionController(rootEl, options);
            if (typeof window !== "undefined" && window.ReevaCompanion) {
                window.ReevaCompanion.activeInstance = instance;
            }
            return instance;
        },
        getInstance() {
            return (typeof window !== "undefined" && window.ReevaCompanion)
                ? window.ReevaCompanion.activeInstance
                : null;
        }
    };
}));
