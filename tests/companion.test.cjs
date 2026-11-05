// tests/companion.test.cjs — Contextual anime companion lifecycle and reactions
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const companion = require("../public/js/companion.js");

class FakeClassList {
    constructor() { this.values = new Set(); }
    add(...names) { names.forEach((name) => this.values.add(name)); }
    remove(...names) { names.forEach((name) => this.values.delete(name)); }
    contains(name) { return this.values.has(name); }
    toggle(name, force) {
        const shouldAdd = force === undefined ? !this.values.has(name) : Boolean(force);
        if (shouldAdd) this.values.add(name);
        else this.values.delete(name);
        return shouldAdd;
    }
}

class FakeElement {
    constructor() {
        this.classList = new FakeClassList();
        this.style = {};
        this.attributes = {};
        this.listeners = {};
        this.hidden = false;
        this.textContent = "";
        this.offsetWidth = 10;
    }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    closest(selector) { return selector === ".workspace-layout" ? fakeWorkspace : null; }
    animate() { return { cancel() {} }; }
}

const ids = [
    "comp-sprite-container",
    "companion-butterfly",
    "companion-dialogue",
    "companion-dialogue-text",
    "companion-dialogue-close",
    "companion-mood-tag",
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

let fakeWorkspace;
let elements;
let root;

function setupDom() {
    fakeWorkspace = new FakeElement();
    root = new FakeElement();
    elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
    global.document = {
        getElementById(id) {
            if (id === "companion-stage" || id === "anime-companion-root") return root;
            return elements[id] || null;
        }
    };
    return new companion.CompanionController(root, { initialLanguage: "en" });
}

test("companion stays hidden on initial page load", () => {
    const controller = setupDom();
    assert.equal(controller.state, companion.STATES.IDLE);
    assert.equal(root.classList.contains("is-active"), false);
    assert.equal(root.attributes["aria-hidden"], "true");
    assert.equal(fakeWorkspace.classList.contains("companion-active"), false);
    assert.equal(elements["comp-sprite-container"].style.animation || "", "");
});

test("companion appears for an interaction and IDLE always hides it again", () => {
    const controller = setupDom();
    controller.triggerState(companion.STATES.CURIOUS, 0);
    assert.equal(root.classList.contains("is-active"), true);
    assert.equal(root.attributes["aria-hidden"], "false");
    assert.equal(fakeWorkspace.classList.contains("companion-active"), true);

    controller.triggerState(companion.STATES.IDLE);
    assert.equal(controller.state, companion.STATES.IDLE);
    assert.equal(root.classList.contains("is-active"), false);
    assert.equal(root.attributes["aria-hidden"], "true");
    assert.equal(fakeWorkspace.classList.contains("companion-active"), false);
});

test("processing shows the butterfly and a failure switches to crying eyes", () => {
    const controller = setupDom();
    const butterfly = elements["companion-butterfly"];
    controller.triggerState(companion.STATES.PROCESSING);
    assert.equal(root.classList.contains("is-active"), true);
    assert.equal(butterfly.hidden, false);
    assert.equal(butterfly.classList.contains("is-flying"), true);

    controller.triggerState(companion.STATES.FAILURE, 0);
    assert.equal(controller.currentExpression, companion.EXPRESSIONS.CRYING);
    assert.equal(elements["comp-expr-crying"].classList.contains("hidden"), false);
    assert.equal(butterfly.hidden, true);
    assert.equal(butterfly.classList.contains("is-flying"), false);
});

test("success and failure can both return to hidden idle state", () => {
    const controller = setupDom();
    controller.triggerState(companion.STATES.SUCCESS, 0);
    controller.triggerState(companion.STATES.IDLE);
    assert.equal(controller.state, companion.STATES.IDLE);
    assert.equal(root.classList.contains("is-active"), false);

    controller.triggerState(companion.STATES.FAILURE, 0);
    controller.triggerState(companion.STATES.IDLE);
    assert.equal(controller.state, companion.STATES.IDLE);
    assert.equal(root.classList.contains("is-active"), false);
});

test("network errors use the watery crying expression", () => {
    const controller = setupDom();
    controller.triggerState(companion.STATES.NETWORK_ERROR, 0);
    assert.equal(controller.currentExpression, companion.EXPRESSIONS.CRYING);
});
