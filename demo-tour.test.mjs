import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./demo-tour.js", import.meta.url), "utf8");

function harness() {
  let document;
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.listeners = {};
      this.attributes = {};
      this.hidden = false;
      this.inert = false;
      this.disabled = false;
      this.textContent = "";
      this.value = "";
    }
    get isConnected() { return this === document.body || Boolean(this.parent?.isConnected); }
    append(...elements) { elements.forEach(element => { element.parent = this; this.children.push(element); }); }
    replaceChildren(...elements) { this.children.forEach(element => { element.parent = null; }); this.children = []; this.append(...elements); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    focus() { document.activeElement = this; }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    querySelectorAll() { return this.descendants().filter(child => child.tagName === "BUTTON" && !child.disabled || child.tagName === "A" && child.href || child.tabIndex === 0); }
    dispatch(name, event = {}) { (this.listeners[name] || []).forEach(callback => callback({ target: this, ...event })); }
    click() { this.dispatch("click"); }
  }
  document = {
    createElement: tag => new Element(tag),
    getElementById: id => [document.body, ...document.body.descendants()].find(element => element.id === id) || null
  };
  document.body = new Element("body");
  const launch = new Element("button"); launch.id = "start-demo";
  const composer = new Element("textarea"); composer.id = "chat-input"; composer.value = "Keep my unsent project draft";
  const alreadyInert = new Element("aside"); alreadyInert.inert = true;
  document.body.append(launch, composer, alreadyInert);
  launch.focus();
  const forbidden = () => { throw new Error("The tour must not access an API or storage"); };
  const context = vm.createContext({ document, HTMLElement: Element, window: {}, fetch: forbidden, localStorage: new Proxy({}, { get: forbidden }), sessionStorage: new Proxy({}, { get: forbidden }) });
  vm.runInContext(source, context);
  context.window.initDemoTour();
  const allText = () => document.getElementById("tour-overlay").descendants().map(element => element.textContent).join(" ");
  const click = text => {
    const element = document.getElementById("tour-overlay").descendants().find(item => item.tagName === "BUTTON" && (item.textContent === text || item.descendants().some(child => child.textContent === text)));
    assert.ok(element, `Button found: ${text}`);
    element.click();
  };
  const advance = () => { click("See the proposed mission"); click("Approve example mission"); };
  return { context, document, launch, composer, alreadyInert, allText, click, advance };
}

test("guided example requires approval and changes the next mission after a missed target", () => {
  const h = harness();
  h.launch.click();
  assert.match(h.allText(), /Guided example · fictional · no live AI/);
  h.click("See the proposed mission");
  assert.match(h.allText(), /Approving here only advances this example/);
  h.click("Approve example mission");
  h.click("TARGET MISSED");
  assert.match(h.allText(), /Pause new booking features/);
  assert.match(h.allText(), /repeat the same test with 3 new tutors/);
  assert.match(h.allText(), /No XP or rewards are added/);
  h.click("Try the other result");
  h.click("TARGET MET");
  assert.match(h.allText(), /most recent reschedule/);
  assert.doesNotMatch(h.allText(), /Pause new booking features/);
  h.click("Replay from the start");
  assert.match(h.allText(), /A real question to start from/);
});

test("tour closes to the composer without changing its draft or background inert state", () => {
  const h = harness();
  const children = h.document.body.children.length;
  h.context.window.initDemoTour();
  assert.equal(h.document.body.children.length, children, "Initialization is idempotent");
  h.launch.click();
  assert.equal(h.composer.inert, true);
  h.advance();
  h.click("TARGET MISSED");
  h.click("Try with my project");
  assert.equal(h.document.getElementById("tour-overlay").hidden, true);
  assert.equal(h.composer.value, "Keep my unsent project draft");
  assert.equal(h.document.activeElement, h.composer);
  assert.equal(h.composer.inert, false);
  assert.equal(h.alreadyInert.inert, true);
});

test("Escape restores launch focus and tab wraps within the example", () => {
  const h = harness();
  h.launch.click();
  const dialog = h.document.getElementById("tour-overlay").children[0];
  assert.equal(dialog.attributes["aria-modal"], "true");
  const targets = dialog.querySelectorAll();
  const first = targets[0];
  const last = targets.at(-1);
  let prevented = false;
  const event = { key: "Tab", preventDefault: () => { prevented = true; } };
  last.focus();
  dialog.dispatch("keydown", event);
  assert.equal(h.document.activeElement, first);
  assert.equal(prevented, true);
  dialog.dispatch("keydown", { ...event, shiftKey: true });
  assert.equal(h.document.activeElement, last);
  dialog.dispatch("keydown", { key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.equal(h.document.getElementById("tour-overlay").hidden, true);
  assert.equal(h.document.activeElement, h.launch);
  assert.equal(h.composer.inert, false);
  h.launch.click();
  assert.match(h.allText(), /STEP 1 OF 4/);
});
