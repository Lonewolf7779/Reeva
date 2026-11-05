// public/js/companion.js — Reeva Visual Novel Anime Companion Character System
"use strict";

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.ReevaCompanion = factory();
    }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {

    // =========================================================================
    // 1. Companion States & Priority Escalation Matrix
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

    // All 10 Required Visual Novel Expressions
    const EXPRESSIONS = {
        HAPPY: "happy",
        SMILING: "smiling",
        EXCITED: "excited",
        CURIOUS: "curious",
        FOCUSED: "focused",
        SURPRISED: "surprised",
        CONFUSED: "confused",
        DISAPPOINTED: "disappointed",
        CRYING: "crying",
        CELEBRATING: "celebrating"
    };

    // Contextual Messages (Bilingual EN / HI)
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
            en: "Hmm... could you check that link?",
            hi: "हम्म... क्या आप इस लिंक की दोबारा जांच कर सकते हैं?"
        },
        [STATES.NETWORK_ERROR]: {
            en: "Looks like the connection is having trouble.",
            hi: "लगता है नेटवर्क कनेक्शन में समस्या है।"
        }
    };

    const MOOD_TAGS = {
        [STATES.IDLE]: { en: "Ready", hi: "तैयार" },
        [STATES.WELCOME]: { en: "Greeting", hi: "नमस्ते" },
        [STATES.CURIOUS]: { en: "Curious", hi: "उत्सुक" },
        [STATES.PLATFORM_SELECTED]: { en: "Ready", hi: "तैयार" },
        [STATES.PROCESSING]: { en: "Working...", hi: "काम चालू..." },
        [STATES.SUCCESS]: { en: "Success!", hi: "सफल!" },
        [STATES.FAILURE]: { en: "Sorry!", hi: "माफ़ कीजिए" },
        [STATES.INVALID_URL]: { en: "Puzzled", hi: "असमंजस" },
        [STATES.NETWORK_ERROR]: { en: "Offline", hi: "ऑफ़लाइन" }
    };

    // =========================================================================
    // 2. Animation Engine (Anime.js + Hardware Accelerated CSS Fallback)
    // =========================================================================
    class VisualNovelAnimations {
        constructor(spriteContainerEl) {
            this.container = spriteContainerEl;
            this.breathingActive = false;
        }

        _runAnimation(animDef) {
            if (!this.container) return;
            try {
                const anime = (typeof window !== "undefined" && window.anime) ? window.anime : null;
                if (typeof anime === "function") {
                    anime(Object.assign({ targets: this.container }, animDef));
                } else if (anime && typeof anime.animate === "function") {
                    anime.animate(this.container, animDef);
                }
            } catch (err) {
                // Graceful fallback to pure CSS transforms
            }
        }

        startBreathing() {
            if (!this.container) return;
            this.breathingActive = true;
            this.container.style.animation = "companionBreath 3.8s ease-in-out infinite alternate";
        }

        stopBreathing() {
            this.breathingActive = false;
            if (this.container) {
                this.container.style.animation = "";
            }
        }

        playWelcome() {
            if (!this.container) return;
            this.container.classList.remove("anim-bounce");
            void this.container.offsetWidth; // Trigger reflow
            this.container.classList.add("anim-bounce");
            setTimeout(() => {
                if (this.container) this.container.classList.remove("anim-bounce");
            }, 700);
        }

        playLookTowardInterface() {
            this._runAnimation({
                translateX: [-8, 0],
                duration: 650,
                easing: "easeOutCubic"
            });
        }

        playCurious() {
            this._runAnimation({
                rotate: [-2, 0],
                translateY: [-4, 0],
                duration: 750,
                easing: "easeOutQuad"
            });
        }

        playProcessing() {
            if (!this.container) return;
            this.stopBreathing();
            this.container.style.animation = "companionBreath 1.4s ease-in-out infinite alternate";
        }

        stopProcessing() {
            if (!this.container) return;
            this.container.style.animation = "";
            this.startBreathing();
        }

        playCelebration() {
            if (!this.container) return;
            this.container.classList.remove("anim-bounce");
            void this.container.offsetWidth;
            this.container.classList.add("anim-bounce");
            setTimeout(() => {
                if (this.container) this.container.classList.remove("anim-bounce");
            }, 750);
        }

        playCrying() {
            this._runAnimation({
                translateX: [-2, 2, -1, 1, 0],
                translateY: [4, 0],
                duration: 800,
                easing: "easeInOutSine"
            });
        }
    }

    // =========================================================================
    // 3. Dialogue Box Controller
    // =========================================================================
    class VisualNovelDialogue {
        constructor() {
            this.dialogueEl = document.getElementById("companion-dialogue");
            this.textEl = document.getElementById("companion-dialogue-text");
            this.closeBtn = document.getElementById("companion-dialogue-close");
            this.moodTagEl = document.getElementById("companion-mood-tag");
            this.dismissTimer = null;

            if (this.closeBtn) {
                this.closeBtn.addEventListener("click", () => this.hide());
            }
        }

        show(text, mood = "Ready", autoDismissMs = 5000) {
            if (this.dismissTimer) {
                clearTimeout(this.dismissTimer);
                this.dismissTimer = null;
            }

            if (this.moodTagEl) {
                this.moodTagEl.textContent = mood;
            }

            if (this.textEl) {
                this.textEl.textContent = text;
            }

            if (this.dialogueEl) {
                this.dialogueEl.classList.remove("hidden", "bubble-exit");
                this.dialogueEl.classList.add("bubble-enter");
            }

            if (autoDismissMs > 0) {
                this.dismissTimer = setTimeout(() => {
                    this.hide();
                }, autoDismissMs);
            }
        }

        hide() {
            if (this.dismissTimer) {
                clearTimeout(this.dismissTimer);
                this.dismissTimer = null;
            }

            if (this.dialogueEl) {
                this.dialogueEl.classList.remove("bubble-enter");
                this.dialogueEl.classList.add("bubble-exit");
                setTimeout(() => {
                    if (this.dialogueEl) {
                        this.dialogueEl.classList.add("hidden");
                        this.dialogueEl.classList.remove("bubble-exit");
                    }
                }, 220);
            }
        }
    }

    // =========================================================================
    // 4. Main Companion Controller
    // =========================================================================
    class CompanionController {
        constructor(rootEl, options = {}) {
            this.rootEl = rootEl || document.getElementById("anime-companion-root");
            this.options = options;
            this.state = STATES.IDLE;
            this.currentLanguage = options.initialLanguage || "en";
            this.currentExpression = EXPRESSIONS.HAPPY;
            this.idleReturnTimer = null;
            this.blinkTimer = null;
            this.butterflyTimer = null;
            this.butterflyAnimations = [];

            // DOM Elements
            this.spriteContainer = document.getElementById("comp-sprite-container");
            this.butterflyEl = document.getElementById("companion-butterfly");
            this.workspaceLayout = this.rootEl && typeof this.rootEl.closest === "function"
                ? this.rootEl.closest(".workspace-layout")
                : null;
            this.dialogue = new VisualNovelDialogue();
            this.animationEngine = new VisualNovelAnimations(this.spriteContainer);

            this._initInteractions();
            this.setExpression(EXPRESSIONS.HAPPY);
            this._setVisible(false);
        }

        _initInteractions() {
            if (this.spriteContainer) {
                this.spriteContainer.addEventListener("click", () => {
                    if (this.state === STATES.IDLE) {
                        this.triggerState(STATES.WELCOME, 3500);
                    }
                });
            }
        }

        _setVisible(visible) {
            if (this.rootEl) {
                this.rootEl.classList.toggle("is-active", visible);
                this.rootEl.setAttribute("aria-hidden", visible ? "false" : "true");
            }
            if (this.workspaceLayout) {
                this.workspaceLayout.classList.toggle("companion-active", visible);
            }

            if (visible) {
                this._startBlinking();
            } else {
                this._stopBlinking();
                this._stopButterflyChase();
            }
        }

        _startBlinking() {
            if (this.blinkTimer || !this.spriteContainer) return;
            const blink = () => {
                if (this.state === STATES.IDLE || !this.spriteContainer) {
                    this.blinkTimer = null;
                    return;
                }

                const reducedMotion = typeof window !== "undefined" &&
                    window.matchMedia &&
                    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

                if (!reducedMotion && typeof this.spriteContainer.animate === "function") {
                    this.spriteContainer.animate(
                        [
                            { transform: "scaleY(1)" },
                            { transform: "scaleY(0.985)", offset: 0.48 },
                            { transform: "scaleY(1)" }
                        ],
                        { duration: 150, easing: "ease-in-out" }
                    );
                }

                this.blinkTimer = setTimeout(blink, 3800 + Math.floor(Math.random() * 2200));
            };

            this.blinkTimer = setTimeout(blink, 1800);
        }

        _stopBlinking() {
            if (this.blinkTimer) {
                clearTimeout(this.blinkTimer);
                this.blinkTimer = null;
            }
        }

        _playButterflyChase() {
            if (!this.butterflyEl || !this.spriteContainer) return;

            this._stopButterflyChase();
            const reducedMotion = typeof window !== "undefined" &&
                window.matchMedia &&
                window.matchMedia("(prefers-reduced-motion: reduce)").matches;

            this.butterflyEl.hidden = false;
            this.butterflyEl.classList.add("is-flying");

            if (reducedMotion || typeof this.butterflyEl.animate !== "function") {
                this.butterflyEl.classList.add("is-caught");
                this.butterflyTimer = setTimeout(() => this._stopButterflyChase(), 900);
                return;
            }

            if (typeof this.spriteContainer.animate === "function") {
                this.butterflyAnimations.push(this.spriteContainer.animate(
                    [
                        { transform: "translate3d(0, 0, 0)" },
                        { transform: "translate3d(-9px, -3px, 0)", offset: 0.35 },
                        { transform: "translate3d(8px, -2px, 0)", offset: 0.72 },
                        { transform: "translate3d(0, 0, 0)" }
                    ],
                    { duration: 1900, easing: "ease-in-out" }
                ));
            }

            this.butterflyAnimations.push(this.butterflyEl.animate(
                [
                    { transform: "translate3d(0, 0, 0) rotate(-8deg) scale(0.8)", opacity: 0.0, offset: 0 },
                    { transform: "translate3d(34px, -26px, 0) rotate(12deg) scale(1)", opacity: 1, offset: 0.18 },
                    { transform: "translate3d(104px, -8px, 0) rotate(-14deg) scale(0.9)", opacity: 1, offset: 0.52 },
                    { transform: "translate3d(48px, 26px, 0) rotate(18deg) scale(0.7)", opacity: 1, offset: 0.82 },
                    { transform: "translate3d(18px, 4px, 0) rotate(0deg) scale(0)", opacity: 0, offset: 1 }
                ],
                { duration: 2100, easing: "ease-in-out" }
            ));

            this.butterflyTimer = setTimeout(() => this._stopButterflyChase(), 2250);
        }

        _stopButterflyChase() {
            if (this.butterflyTimer) {
                clearTimeout(this.butterflyTimer);
                this.butterflyTimer = null;
            }
            this.butterflyAnimations.forEach((animation) => {
                try { animation.cancel(); } catch (_) {}
            });
            this.butterflyAnimations = [];
            if (this.butterflyEl) {
                this.butterflyEl.classList.remove("is-flying", "is-caught");
                this.butterflyEl.hidden = true;
            }
        }

        setLanguage(lang) {
            this.currentLanguage = lang === "hi" ? "hi" : "en";
            if (this.state !== STATES.IDLE) {
                const msg = this.getLocalizedMessage(this.state);
                const mood = this.getLocalizedMood(this.state);
                if (msg) this.dialogue.show(msg, mood, 4000);
            }
        }

        getLocalizedMessage(stateKey) {
            const entry = COMPANION_MESSAGES[stateKey];
            if (!entry) return "";
            return entry[this.currentLanguage] || entry.en || "";
        }

        getLocalizedMood(stateKey) {
            const entry = MOOD_TAGS[stateKey];
            if (!entry) return "Ready";
            return entry[this.currentLanguage] || entry.en || "Ready";
        }

        setExpression(exprName) {
            this.currentExpression = exprName;
            const exprIds = [
                "comp-expr-happy",
                "comp-expr-smiling",
                "comp-expr-excited",
                "comp-expr-curious",
                "comp-expr-focused",
                "comp-expr-surprised",
                "comp-expr-confused",
                "comp-expr-disappointed",
                "comp-expr-crying",
                "comp-expr-celebrating"
            ];

            const targetId = `comp-expr-${exprName}`;
            exprIds.forEach(id => {
                const img = document.getElementById(id);
                if (img) {
                    if (id === targetId) {
                        img.classList.remove("hidden");
                    } else {
                        img.classList.add("hidden");
                    }
                }
            });
        }

        triggerState(newState, durationMs = 0) {
            const currentPriority = STATE_PRIORITIES[this.state] || 0;
            const newPriority = STATE_PRIORITIES[newState] || 0;

            // IDLE is an unconditional terminal transition so every timed reaction can hide cleanly.
            if (newState !== STATES.IDLE && newPriority < currentPriority && this.state !== STATES.IDLE) {
                return;
            }

            if (this.idleReturnTimer) {
                clearTimeout(this.idleReturnTimer);
                this.idleReturnTimer = null;
            }

            if (this.state === STATES.PROCESSING && newState !== STATES.PROCESSING) {
                this._stopButterflyChase();
            }

            this.state = newState;
            this._setVisible(newState !== STATES.IDLE);
            const msg = this.getLocalizedMessage(newState);
            const mood = this.getLocalizedMood(newState);

            switch (newState) {
                case STATES.WELCOME:
                    this.setExpression(EXPRESSIONS.SMILING);
                    this.animationEngine.playWelcome();
                    if (msg) this.dialogue.show(msg, mood, durationMs || 4200);
                    this._scheduleReturnToIdle(durationMs || 4500);
                    break;

                case STATES.PLATFORM_SELECTED:
                    this.setExpression(EXPRESSIONS.HAPPY);
                    this.animationEngine.playLookTowardInterface();
                    if (msg) this.dialogue.show(msg, mood, durationMs || 3200);
                    this._scheduleReturnToIdle(durationMs || 3600);
                    break;

                case STATES.CURIOUS:
                    this.setExpression(EXPRESSIONS.CURIOUS);
                    this.animationEngine.playCurious();
                    if (msg) this.dialogue.show(msg, mood, durationMs || 3500);
                    this._scheduleReturnToIdle(durationMs || 3800);
                    break;

                case STATES.PROCESSING:
                    this.setExpression(EXPRESSIONS.FOCUSED);
                    this.animationEngine.playProcessing();
                    this._playButterflyChase();
                    if (msg) this.dialogue.show(msg, mood, 0); // Keep open during active network extraction
                    break;

                case STATES.SUCCESS:
                    this.animationEngine.stopProcessing();
                    this.setExpression(EXPRESSIONS.CELEBRATING);
                    this.animationEngine.playCelebration();
                    if (msg) this.dialogue.show(msg, mood, durationMs || 5500);
                    this._scheduleReturnToIdle(durationMs || 6000);
                    break;

                case STATES.FAILURE:
                    this.animationEngine.stopProcessing();
                    this.setExpression(EXPRESSIONS.CRYING);
                    this.animationEngine.playCrying();
                    if (msg) this.dialogue.show(msg, mood, durationMs || 5500);
                    this._scheduleReturnToIdle(durationMs || 6000);
                    break;

                case STATES.INVALID_URL:
                    this.animationEngine.stopProcessing();
                    this.setExpression(EXPRESSIONS.CONFUSED);
                    this.animationEngine.playCurious();
                    if (msg) this.dialogue.show(msg, mood, durationMs || 4200);
                    this._scheduleReturnToIdle(durationMs || 4500);
                    break;

                case STATES.NETWORK_ERROR:
                    this.animationEngine.stopProcessing();
                    this.setExpression(EXPRESSIONS.CRYING);
                    this.animationEngine.playCrying();
                    if (msg) this.dialogue.show(msg, mood, durationMs || 4800);
                    this._scheduleReturnToIdle(durationMs || 5000);
                    break;

                case STATES.IDLE:
                default:
                    this.animationEngine.stopProcessing();
                    this.animationEngine.stopBreathing();
                    this.setExpression(EXPRESSIONS.HAPPY);
                    this.dialogue.hide();
                    if (this.dialogue.moodTagEl) {
                        this.dialogue.moodTagEl.textContent = this.getLocalizedMood(STATES.IDLE);
                    }
                    break;
            }
        }

        _scheduleReturnToIdle(delayMs) {
            this.idleReturnTimer = setTimeout(() => {
                this.triggerState(STATES.IDLE);
            }, delayMs);
        }
    }

    const companionApi = {
        STATES,
        STATE_PRIORITIES,
        EXPRESSIONS,
        COMPANION_MESSAGES,
        MOOD_TAGS,
        VisualNovelAnimations,
        VisualNovelDialogue,
        CompanionController,
        activeInstance: null,
        initCompanion(rootId = "companion-stage", options = {}) {
            if (typeof document === "undefined") return null;
            let rootEl = document.getElementById(rootId);
            if (!rootEl && (rootId === "anime-companion-root" || rootId === "companion-stage")) {
                rootEl = document.getElementById("companion-stage") || document.getElementById("anime-companion-root");
            }
            if (!rootEl) return null;
            const instance = new CompanionController(rootEl, options);
            companionApi.activeInstance = instance;
            if (typeof window !== "undefined") {
                window.ReevaCompanion = window.ReevaCompanion || companionApi;
                window.ReevaCompanion.activeInstance = instance;
            }
            return instance;
        },
        getInstance() {
            return companionApi.activeInstance || (typeof window !== "undefined" && window.ReevaCompanion ? window.ReevaCompanion.activeInstance : null);
        }
    };

    return companionApi;
}));
