import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(process.env.BUEELD_PROGRESS_PANEL_JS || new URL('./progress-panel.js', import.meta.url), 'utf8');

function harness(count = 0) {
  let activeElement;
  const observers = [];
  class Element {
    constructor(dataset = {}, classes = []) {
      this.dataset = dataset;
      this.hidden = false;
      this.disabled = false;
      this.tabIndex = 0;
      this.children = [];
      this.attributes = {};
      this.listeners = new Map();
      this.classList = { contains: value => classes.includes(value) };
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() { activeElement = this; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    dispatch(type, key) {
      const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.listeners.get(type)?.(event);
      return event;
    }
  }
  const names = ['overview', 'history', 'help'];
  const tabs = names.map(progressTab => new Element({ progressTab }));
  const views = names.map(progressView => new Element({ progressView }));
  const ids = Object.fromEntries(['mission-panel', 'mission-drawer', 'mission-history-list', 'progress-history-pagination', 'progress-history-page', 'progress-history-prev', 'progress-history-next'].map(id => [id, new Element()]));
  ids['mission-drawer'].hidden = true;
  ids['mission-panel'].querySelectorAll = selector => selector === '[data-progress-tab]' ? tabs : views;
  const makeRows = amount => Array.from({ length: amount }, () => {
    const item = new Element({}, ['mission-history-item']);
    item.children = [new Element()];
    return item;
  });
  const empty = new Element({}, ['mission-history-empty']);
  ids['mission-history-list'].children = count ? makeRows(count) : [empty];
  vm.runInNewContext(source, {
    document: { getElementById: id => ids[id] },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(target, options) { observers.push({ target, options, callback: this.callback }); }
    },
  });
  return {
    ids, tabs, views, empty, makeRows, observers,
    active: () => activeElement,
    mutate: id => observers.find(observer => observer.target === ids[id]).callback(),
  };
}

test('tabs support click, wrapping arrows, Home and End with one selected tab and visible panel', () => {
  const h = harness();
  function selected(index) {
    h.tabs.forEach((tab, i) => {
      assert.equal(tab.attributes['aria-selected'], String(i === index));
      assert.equal(tab.tabIndex, i === index ? 0 : -1);
      assert.equal(h.views[i].hidden, i !== index);
    });
  }
  selected(0);
  h.tabs[1].dispatch('click');
  selected(1);
  assert.equal(h.active(), h.tabs[1]);
  assert.equal(h.tabs[1].dispatch('keydown', 'End').defaultPrevented, true);
  selected(2);
  assert.equal(h.active(), h.tabs[2]);
  h.tabs[2].dispatch('keydown', 'ArrowRight');
  selected(0);
  h.tabs[0].dispatch('keydown', 'ArrowLeft');
  selected(2);
  h.tabs[2].dispatch('keydown', 'Home');
  selected(0);
  assert.equal(h.tabs[0].dispatch('keydown', 'Tab').defaultPrevented, false);
});

test('opening the drawer resets the overview without stealing focus from the dialog', () => {
  const h = harness();
  h.tabs[2].dispatch('click');
  h.ids['mission-panel'].focus();
  h.ids['mission-drawer'].hidden = false;
  h.mutate('mission-drawer');
  assert.equal(h.tabs[0].attributes['aria-selected'], 'true');
  assert.equal(h.active(), h.ids['mission-panel']);
  h.tabs[1].dispatch('click');
  h.mutate('mission-drawer');
  assert.equal(h.tabs[1].attributes['aria-selected'], 'true');
  h.ids['mission-drawer'].hidden = true;
  h.mutate('mission-drawer');
  h.ids['mission-drawer'].hidden = false;
  h.mutate('mission-drawer');
  assert.equal(h.tabs[0].attributes['aria-selected'], 'true');
});

test('history exposes one existing row per page, clamps boundaries and resets after app rendering', () => {
  const h = harness(3);
  const list = h.ids['mission-history-list'];
  const rows = [...list.children];
  const actions = rows.map(row => row.children[0]);
  const next = h.ids['progress-history-next'];
  const previous = h.ids['progress-history-prev'];
  function page(index, count = 3) {
    assert.equal(h.ids['progress-history-page'].textContent, `${index + 1} / ${count}`);
    assert.equal(previous.disabled, index === 0);
    assert.equal(next.disabled, index === count - 1);
    list.children.forEach((row, i) => assert.equal(row.hidden, i !== index));
  }
  page(0);
  previous.dispatch('click');
  page(0);
  next.dispatch('click');
  page(1);
  next.dispatch('click');
  page(2);
  next.dispatch('click');
  page(2);
  previous.dispatch('click');
  page(1);
  assert.deepEqual(list.children, rows);
  assert.deepEqual(list.children.map(row => row.children[0]), actions);
  list.children = h.makeRows(1);
  h.mutate('mission-history-list');
  page(0, 1);
  list.children = [h.empty];
  h.mutate('mission-history-list');
  assert.equal(h.empty.hidden, false);
  assert.equal(h.ids['progress-history-page'].textContent, '0 missions');
  assert.equal(h.ids['progress-history-pagination'].hidden, true);
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, true);
  list.children = h.makeRows(2);
  h.mutate('mission-history-list');
  page(0, 2);
  assert.equal(h.ids['progress-history-pagination'].hidden, false);
  const observer = h.observers.find(item => item.target === list);
  assert.deepEqual(Object.keys(observer.options), ['childList']);
  assert.equal(observer.options.childList, true);
});
