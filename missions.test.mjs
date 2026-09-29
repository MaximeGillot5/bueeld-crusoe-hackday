import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

// Exercise the browser's actual mission functions without starting a server,
// running the account bootstrap, or spending an AI request.
const appPath = process.env.BUEELD_APP_JS || fileURLToPath(new URL('./app.js', import.meta.url));
const source = readFileSync(appPath, 'utf8');
const functionDeclarations = source.match(/^(?:async )?function [A-Za-z_$][\w$]*\([^\n]*\) \{[\s\S]*?^\}/gm) || [];

class Element {
  constructor() {
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.textContent = '';
    this.dataset = {};
    this.children = [];
    this.attributes = {};
    this.focusCount = 0;
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      contains: name => this.classes.has(name),
      toggle: (name, force) => {
        const next = force ?? !this.classes.has(name);
        if (next) this.classes.add(name); else this.classes.delete(name);
        return next;
      }
    };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelectorAll() { return []; }
  focus() { this.focusCount += 1; }
  scrollIntoView() {}
}

function harness(records = [], pinned = null) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const calls = { pin: 0, tracker: 0, chat: 0, account: 0, errors: [] };
  const context = vm.createContext({
    console, Date, Intl, Set, Map, HTMLElement: Element,
    setTimeout: () => 0, clearTimeout: () => {},
    document: { getElementById: element, createElement: () => new Element(), body: new Element() },
    window: { confirm: () => true },
    accountApiStub: () => Promise.reject(new Error('Unexpected account API request in test')),
    seededRecords: records, seededPin: pinned, calls,
  });
  vm.runInContext(`
    const $ = id => document.getElementById(id);
    const el = (tag, className, text) => {
      const node = document.createElement(tag);
      node.className = className || '';
      if (text !== undefined) node.textContent = String(text);
      return node;
    };
    const CHAT_LIMIT = 1500;
    const EVIDENCE_PREFIX = 'Evidence for our pinned mission: ';
    const MISSION_AREAS = [['need', 'Customer need'], ['demand', 'Demand'], ['delivery', 'Delivery'], ['economics', 'Business model']];
    const MISSION_OUTCOMES = ['met', 'missed', 'inconclusive'];
    let missionTracker = { records: seededRecords, seenLevel: 1 };
    let pinnedMission = seededPin;
    let chatMessages = [];
    let missionEvidenceExpanded = false;
    let missionEvidenceForId = null;
    let expandedMissionId = null;
    let recentMissionCompletionId = null;
    let chatBusy = false;
    let sourceBusy = false;
    let accountReady = true;
    let accountSession = { authenticated: false };
    let autosaveMuted = false;
    let missionDirty = false;
    let missionRevision = 0;
    let workspaceGeneration = 0;
    let missionOpener = null;
    let pinCandidate = null;
    ${functionDeclarations.join('\n')}
    persistPinnedMission = () => { calls.pin += 1; };
    persistMissionTracker = () => { calls.tracker += 1; };
    renderChat = () => { calls.chat += 1; };
    renderAccount = () => { calls.account += 1; };
    accountApi = (...args) => accountApiStub(...args);
    accountMessage = (...args) => { calls.errors.push(args); };
  `, context, { filename: appPath });
  return {
    element, calls, context,
    run: expression => vm.runInContext(expression, context),
    state: () => vm.runInContext('({ pinnedMission, missionTracker, missionEvidenceExpanded, missionEvidenceForId, expandedMissionId })', context),
    stats: () => JSON.parse(vm.runInContext('JSON.stringify(missionStats())', context)),
  };
}

const evidence = 'Observed four interviews: three founders independently described the same weekly reporting problem.';
function record(id, overrides = {}) {
  return {
    id, content: `Mission: Interview founders for ${id}\nAction: Record observed needs.`,
    status: 'approved', createdAt: 1, approvedAt: 2,
    evidence, evidenceAt: 3, area: 'need', outcome: 'met', realEvidence: true,
    completedAt: null, ...overrides,
  };
}
function pin(item) {
  return { sourceMessageId: item.id, content: item.content, status: item.status === 'completed' ? 'approved' : item.status, pinnedAt: item.createdAt };
}
function fillEvidence(h, item) {
  h.element('mission-evidence-entry').value = item.evidence;
  h.element('mission-evidence-area').value = item.area;
  h.element('mission-evidence-outcome').value = item.outcome;
  h.element('mission-real-evidence').checked = item.realEvidence;
}

test('a chat has no active mission unless its own unfinished mission is pinned', () => {
  const other = record('other-chat');
  const current = record('this-chat');
  const h = harness([other, current]);
  assert.equal(h.run('activeMissionRecord()'), null);
  h.context.nextPin = pin(current);
  h.run('pinnedMission = nextPin');
  assert.equal(h.run('activeMissionRecord().id'), current.id);
  h.run('pinnedMission.sourceMessageId = "missing"');
  assert.equal(h.run('activeMissionRecord()'), null);
  h.run('pinnedMission.sourceMessageId = "this-chat"; missionTracker.records[1].status = "completed"');
  assert.equal(h.run('activeMissionRecord()'), null);
});

test('rewards are derived once from completed real tests; demo and unfinished tests add none', () => {
  const h = harness([
    record('need', { status: 'completed', completedAt: 4 }),
    record('demand', { status: 'completed', completedAt: 4, area: 'demand', outcome: 'missed' }),
    record('demo', { status: 'completed', completedAt: 4, realEvidence: false, area: 'delivery' }),
    record('unfinished', { area: 'economics' }),
  ]);
  const stats = h.stats();
  assert.equal(stats.xp, 50);
  assert.equal(stats.drops, 10);
  assert.equal(stats.level, 2);
  assert.equal(stats.maturity, 50);
  assert.deepEqual(h.stats(), stats);
  assert.deepEqual(h.stats(), stats);
  assert.equal(h.calls.tracker, 0);
});

test('progress metrics and coverage reflect real completed tests and downgrade when reopened', () => {
  const first = record('need', { status: 'completed', completedAt: 4 });
  const second = record('demand', { status: 'completed', completedAt: 4, area: 'demand', outcome: 'missed' });
  const h = harness([
    first,
    second,
    record('demo', { status: 'completed', completedAt: 4, realEvidence: false, area: 'delivery' }),
    record('invalid', { status: 'completed', completedAt: 4, evidence: 'Too short', area: 'economics' }),
    record('unfinished', { area: 'economics' }),
  ]);
  const areas = [
    ['need', 'Need', 'Customer need'],
    ['demand', 'Demand', 'Demand'],
    ['delivery', 'Delivery', 'Delivery'],
    ['economics', 'Business', 'Business model'],
  ];
  function assertRendered(expected) {
    h.run('renderMissionTracker()');
    const stats = h.stats();
    assert.equal(stats.xp, expected.xp);
    assert.equal(stats.drops, expected.drops);
    assert.equal(stats.level, expected.level);
    assert.equal(stats.maturity, expected.maturity);
    assert.equal(stats.toNextLevel, expected.toNextLevel);
    assert.equal(h.element('mission-level').textContent, String(stats.level));
    assert.equal(h.element('mission-level-badge').textContent, String(stats.level));
    assert.equal(h.element('mission-level-progress').value, expected.progress);
    assert.equal(h.element('mission-level-progress').textContent, expected.progress + ' / 2 real tests');
    assert.equal(h.element('mission-level-next').textContent, expected.next);
    assert.equal(h.element('mission-xp').textContent, String(stats.xp));
    assert.equal(h.element('mission-drops').textContent, String(stats.drops));
    assert.equal(h.element('mission-maturity').textContent, expected.covered.length + ' / 4');
    assert.equal(h.element('mission-maturity-progress').value, stats.maturity);
    assert.equal(h.element('mission-maturity-progress').textContent, stats.maturity + '%');
    assert.equal(h.element('mission-coverage-count').textContent, expected.covered.length + ' / 4');
    assert.equal(h.element('mission-nav-badge').textContent, 'Lv ' + stats.level);
    assert.equal(h.element('open-missions').attributes['aria-label'], `Progress, level ${stats.level}, ${stats.xp} Lab XP`);
    assert.deepEqual(Array.from(h.run('missionStats().covered')), expected.covered);
    const coverage = h.element('mission-coverage').children;
    assert.equal(coverage.length, 4);
    areas.forEach(([id, shortLabel, fullLabel], index) => {
      const covered = expected.covered.includes(id);
      const item = coverage[index];
      assert.equal(item.className, 'mission-coverage-item' + (covered ? ' is-covered' : ''));
      assert.equal(item.attributes.role, 'img');
      assert.equal(item.attributes['aria-label'], fullLabel + ' · ' + (covered ? 'documented' : 'no completed evidence'));
      assert.equal(item.children.length, 2);
      const [marker, label] = item.children;
      assert.equal(marker.className, 'mission-coverage-marker');
      assert.equal(marker.src, covered ? '/assets/icons/progress-check-circle.svg' : '/assets/icons/progress-circle.svg');
      assert.equal(marker.alt, '');
      assert.equal(marker.attributes['aria-hidden'], 'true');
      assert.equal(label.className, 'mission-coverage-label');
      assert.equal(label.textContent, shortLabel);
    });
  }
  assertRendered({ xp: 50, drops: 10, level: 2, maturity: 50, toNextLevel: 2, progress: 0, next: '2 tests to level 3', covered: ['need', 'demand'] });
  h.run('handleMissionHistory({ target: { closest() { return { dataset: { missionAction: "reopen", missionId: "demand" } }; } } })');
  assert.equal(second.status, 'approved');
  assertRendered({ xp: 25, drops: 0, level: 1, maturity: 25, toNextLevel: 1, progress: 1, next: '1 test to level 2', covered: ['need'] });
  h.run('handleMissionHistory({ target: { closest() { return { dataset: { missionAction: "reopen", missionId: "need" } }; } } })');
  assert.equal(first.status, 'approved');
  const empty = { xp: 0, drops: 0, level: 1, maturity: 0, toNextLevel: 2, progress: 0, next: '2 tests to level 2', covered: [] };
  assertRendered(empty);
  const saves = h.calls.tracker;
  assertRendered(empty);
  assert.equal(h.calls.tracker, saves);
});

test('rendering preserves all unsaved evidence fields while the same mission editor is expanded', () => {
  const current = record('current');
  const next = record('next', { area: 'delivery', outcome: 'inconclusive', realEvidence: false });
  const h = harness([current, next], pin(current));
  h.run('renderMissionTracker(); missionEvidenceExpanded = true');
  const draft = { evidence: evidence + ' This draft is not saved yet.', area: 'economics', outcome: 'missed', realEvidence: false };
  fillEvidence(h, draft);
  h.run('renderMissionTracker(); renderMissionTracker()');
  assert.equal(h.element('mission-evidence-entry').value, draft.evidence);
  assert.equal(h.element('mission-evidence-area').value, draft.area);
  assert.equal(h.element('mission-evidence-outcome').value, draft.outcome);
  assert.equal(h.element('mission-real-evidence').checked, draft.realEvidence);
  assert.equal(current.evidence, evidence);
  h.context.nextPin = pin(next);
  h.run('pinnedMission = nextPin; renderMissionTracker()');
  assert.equal(h.state().missionEvidenceExpanded, false);
  assert.equal(h.element('mission-evidence-entry').value, next.evidence);
  assert.equal(h.element('mission-evidence-area').value, next.area);
});

test('a pinned mission remains collapsed by default across chat-related renders', () => {
  const current = record('current');
  const h = harness([current], pin(current));
  h.run('renderMissionTracker(); renderMissionTracker()');
  assert.equal(h.element('mission-conversation').hidden, true);
  assert.equal(h.element('mission-bar').hidden, false);
  assert.equal(h.element('mission-open-tracker').attributes['aria-expanded'], 'false');
  assert.equal(h.state().expandedMissionId, null);
  assert.equal(h.state().pinnedMission.content, current.content);
  assert.equal(h.state().pinnedMission.status, 'approved');
  assert.equal(h.calls.pin, 0, 'Collapsing presentation must not mutate the mission sent to Lia');
});

test('the compact mission toggle opens and closes without renders reopening it', () => {
  const current = record('current');
  const h = harness([current], pin(current));
  h.run('renderMissionTracker(); toggleMissionInChat()');
  assert.equal(h.element('mission-conversation').hidden, false);
  assert.equal(h.element('mission-conversation').focusCount, 1);
  assert.equal(h.element('mission-open-tracker').attributes['aria-expanded'], 'true');
  h.run('renderMissionTracker()');
  assert.equal(h.element('mission-conversation').hidden, false);
  h.run('toggleMissionInChat(); renderMissionTracker(); renderMissionTracker()');
  assert.equal(h.element('mission-conversation').hidden, true);
  assert.equal(h.element('mission-bar').hidden, false);
  assert.equal(h.element('mission-open-tracker').attributes['aria-expanded'], 'false');
  assert.equal(h.state().expandedMissionId, null);
});

test('collapsing the mission preserves every unsaved evidence field for reopening', () => {
  const current = record('current');
  const h = harness([current], pin(current));
  h.run('renderMissionTracker(); openMissionEvidence()');
  const draft = { evidence: evidence + ' Unsaved additional observation.', area: 'economics', outcome: 'missed', realEvidence: false };
  fillEvidence(h, draft);
  h.run('collapseMissionInChat(); renderMissionTracker(); renderMissionTracker()');
  assert.equal(h.element('mission-conversation').hidden, true);
  assert.equal(h.state().missionEvidenceExpanded, true, 'Presentation collapse must not close the evidence editor');
  h.run('toggleMissionInChat()');
  assert.equal(h.element('mission-conversation').hidden, false);
  assert.equal(h.element('mission-proof-form').hidden, false);
  assert.equal(h.element('mission-evidence-entry').value, draft.evidence);
  assert.equal(h.element('mission-evidence-area').value, draft.area);
  assert.equal(h.element('mission-evidence-outcome').value, draft.outcome);
  assert.equal(h.element('mission-real-evidence').checked, draft.realEvidence);
  assert.equal(current.evidence, evidence);
  assert.equal(current.area, 'need');
  assert.equal(current.outcome, 'met');
  assert.equal(current.realEvidence, true);
  assert.equal(h.calls.tracker, 0, 'Opening and collapsing must not silently save draft evidence');
});

test('Add result reveals and focuses the evidence editor even before the first render', () => {
  const current = record('current');
  const h = harness([current], pin(current));
  h.context.suppliedEvidence = 'A new observation copied from a founder message for review.';
  h.run('openMissionEvidence(suppliedEvidence)');
  assert.equal(h.element('mission-conversation').hidden, false);
  assert.equal(h.element('mission-proof-form').hidden, false);
  assert.equal(h.state().expandedMissionId, current.id);
  assert.equal(h.state().missionEvidenceExpanded, true);
  assert.equal(h.element('mission-evidence-entry').value, h.context.suppliedEvidence);
  assert.equal(h.element('mission-evidence-entry').focusCount, 1);
  assert.equal(h.element('mission-evidence-area').value, current.area);
  assert.equal(h.element('mission-evidence-outcome').value, current.outcome);
  assert.equal(h.element('mission-real-evidence').checked, current.realEvidence);
});

test('switching to another pinned mission starts its presentation collapsed', () => {
  const current = record('current');
  const next = record('next', { area: 'delivery', outcome: 'inconclusive', realEvidence: false });
  const h = harness([current, next], pin(current));
  h.run('renderMissionTracker(); focusMissionInChat()');
  assert.equal(h.element('mission-conversation').hidden, false);
  h.context.nextPin = pin(next);
  h.run('pinnedMission = nextPin; renderMissionTracker()');
  assert.equal(h.element('mission-conversation').hidden, true);
  assert.equal(h.element('mission-bar').hidden, false);
  assert.equal(h.state().expandedMissionId, null);
  assert.equal(h.element('mission-open-tracker').attributes['aria-expanded'], 'false');
  assert.equal(h.state().pinnedMission.sourceMessageId, next.id);
  h.run('focusMissionInChat()');
  assert.equal(h.element('mission-conversation').hidden, false);
  assert.equal(h.state().expandedMissionId, next.id);
});

test('completion happens once and never falls through to an unrelated unfinished mission', () => {
  const other = record('other-chat', { area: 'demand' });
  const current = record('current');
  const h = harness([other, current], pin(current));
  h.run('renderMissionTracker()');
  fillEvidence(h, current);
  h.run('completeMissionRecord()');
  assert.equal(current.status, 'completed');
  assert.equal(h.state().pinnedMission, null);
  assert.equal(h.stats().xp, 25);
  const saves = h.calls.tracker;
  fillEvidence(h, other);
  h.run('completeMissionRecord(); completeMissionRecord()');
  assert.equal(other.status, 'approved');
  assert.equal(h.stats().xp, 25);
  assert.equal(h.calls.tracker, saves);
});

test('a stale completion button cannot complete a newly selected mission', () => {
  const first = record('first');
  const second = record('second');
  const h = harness([first, second], pin(first));
  h.run('renderMissionTracker()');
  h.context.nextPin = pin(second);
  h.run('pinnedMission = nextPin');
  fillEvidence(h, second);
  h.run('completeMissionRecord()');
  assert.equal(first.status, 'approved');
  assert.equal(second.status, 'approved');
  assert.equal(h.stats().xp, 0);
});

test('unsaved evidence changes and incomplete evidence cannot complete a mission', () => {
  const current = record('current');
  const h = harness([current], pin(current));
  h.run('renderMissionTracker()');
  fillEvidence(h, { ...current, evidence: evidence + ' Unsaved.' });
  h.run('completeMissionRecord()');
  assert.equal(current.status, 'approved');
  assert.equal(h.stats().xp, 0);
  current.evidence = 'Too short';
  fillEvidence(h, current);
  h.run('completeMissionRecord()');
  assert.equal(current.status, 'approved');
  current.evidence = evidence;
  current.area = '';
  fillEvidence(h, current);
  h.run('completeMissionRecord()');
  assert.equal(current.status, 'approved');
  assert.equal(h.calls.tracker, 0);
});

test('saving valid evidence does not award points before an explicit completion', () => {
  const current = record('current', { evidence: '', evidenceAt: null, area: '', outcome: '', realEvidence: false });
  const h = harness([current], pin(current));
  h.run('renderMissionTracker(); missionEvidenceExpanded = true');
  fillEvidence(h, { evidence, area: 'need', outcome: 'inconclusive', realEvidence: true });
  h.run('saveMissionEvidence({ preventDefault() {} })');
  assert.equal(current.evidence, evidence);
  assert.equal(current.status, 'approved');
  assert.equal(h.stats().xp, 0);
  h.run('completeMissionRecord()');
  assert.equal(current.status, 'completed');
  assert.equal(h.stats().xp, 25);
});

test('reopening removes a reward and completing again restores it without duplication', () => {
  const first = record('first', { status: 'completed', completedAt: 4 });
  const second = record('second', { status: 'completed', completedAt: 4, area: 'demand' });
  const h = harness([first, second]);
  assert.equal(h.stats().xp, 50);
  h.run('handleMissionHistory({ target: { closest() { return { dataset: { missionAction: "reopen", missionId: "second" } }; } } })');
  assert.equal(second.status, 'approved');
  assert.equal(h.stats().xp, 25);
  assert.equal(h.stats().drops, 0);
  assert.equal(h.stats().maturity, 25);
  fillEvidence(h, second);
  h.run('completeMissionRecord(); completeMissionRecord()');
  assert.equal(h.stats().xp, 50);
  assert.equal(h.stats().drops, 10);
  assert.equal(h.state().missionTracker.records.length, 2);
});

test('completing a resumed mission shows its reward even when its source belongs to another chat', () => {
  const resumed = record('previous-chat-mission');
  const h = harness([resumed]);
  h.run('renderMissionReward()');
  assert.equal(h.element('mission-reward-card').hidden, true);
  h.run('resumeMissionRecord(missionTracker.records[0]); completeMissionRecord()');
  assert.equal(resumed.status, 'completed');
  assert.equal(h.element('mission-reward-card').hidden, false);
  assert.equal(h.element('mission-reward-value').textContent, '+25 XP');
  assert.equal(h.stats().xp, 25);
  h.run('recentMissionCompletionId = null; renderMissionReward()');
  assert.equal(h.element('mission-reward-card').hidden, true);
});

for (const realEvidence of [true, false]) {
  test(`the next-mission draft includes the latest ${realEvidence ? 'real' : 'demo'} result from this chat within the message limit`, () => {
    const older = record('older-result', { status: 'completed', completedAt: 4, evidence: 'An older result that must not be copied.' });
    const latest = record('latest-result', {
      status: 'completed', completedAt: 5, realEvidence, outcome: 'missed',
      content: 'Mission: ' + 'Describe the observed reporting workflow '.repeat(35),
      evidence: 'Our latest observation: ' + 'Founders reported weekly delays. '.repeat(45),
    });
    const unrelated = record('other-chat', { status: 'completed', completedAt: 6, evidence: 'Private result from a different conversation.' });
    const h = harness([older, latest, unrelated]);
    h.run('chatMessages = [{ id: "older-result" }, { id: "latest-result" }]');
    assert.equal(h.run('latestConversationMissionResult().id'), latest.id);
    h.run('prepareNextMission()');
    const draft = h.element('chat-input').value;
    assert.ok(draft.includes(realEvidence ? 'Self-reported result:' : 'Fictional demo result:'));
    assert.ok(draft.includes(latest.evidence.slice(0, 900)));
    assert.ok(draft.includes('Outcome: missed.'));
    assert.ok(!draft.includes(older.evidence));
    assert.ok(!draft.includes(unrelated.evidence));
    assert.ok(draft.length <= 1500, `Prepared draft was ${draft.length} characters`);
    assert.equal(h.calls.pin, 0);
    assert.equal(h.calls.tracker, 0);
  });
}

test('preparing another mission preserves an existing editable composer draft', () => {
  const completed = record('completed', { status: 'completed', completedAt: 4 });
  const h = harness([completed]);
  h.run('recentMissionCompletionId = "completed"');
  const draft = 'Please keep my unsent question and these specific observations.\nI am still editing.';
  h.element('chat-input').value = draft;
  h.run('prepareNextMission()');
  assert.equal(h.element('chat-input').value, draft);
  assert.equal(h.calls.pin, 0);
  assert.equal(h.calls.tracker, 0);
});

test('restoring a saved completed pin clears that pin and persists the correction', () => {
  const completed = record('completed', { status: 'completed', completedAt: 4 });
  const h = harness([completed, record('other')], pin(completed));
  assert.equal(h.run('typeof reconcilePinnedMission'), 'function');
  h.run('reconcilePinnedMission()');
  assert.equal(h.state().pinnedMission, null);
  assert.equal(h.run('activeMissionRecord()'), null);
  assert.equal(completed.status, 'completed');
  assert.equal(h.stats().xp, 25);
  assert.equal(h.calls.pin, 1);
  h.run('reconcilePinnedMission()');
  assert.equal(h.calls.pin, 1);
});

test('restoring a new unfinished pin creates one record and preserves existing evidence on later restores', () => {
  const current = record('current');
  const h = harness([], pin(current));
  assert.equal(h.run('typeof reconcilePinnedMission'), 'function');
  h.run('reconcilePinnedMission(); reconcilePinnedMission()');
  assert.equal(h.state().missionTracker.records.length, 1);
  assert.equal(h.run('activeMissionRecord().id'), 'current');
  h.run('missionTracker.records[0].evidence = "Previously saved evidence should be retained across a chat restore."; reconcilePinnedMission()');
  assert.equal(h.state().missionTracker.records.length, 1);
  assert.match(h.state().missionTracker.records[0].evidence, /^Previously saved evidence/);
});

test('server restore merges complete account history even when a restored local pin already exists', async () => {
  const current = record('current', { evidence: '', evidenceAt: null, area: '', outcome: '', realEvidence: false });
  const localOnly = record('local-only');
  const serverCurrent = record('current', { evidence: evidence + ' Server details.' });
  const completed = record('completed', { status: 'completed', completedAt: 4 });
  const another = record('another', { status: 'completed', completedAt: 5, area: 'demand' });
  const h = harness([current, localOnly], pin(current));
  h.run('accountSession = { authenticated: true, user: { id: "alice" } }');
  h.context.accountApiStub = async (method, path) => {
    assert.equal(method, 'GET');
    assert.equal(path, '/api/mission-tracker');
    return { missionTracker: { records: [serverCurrent, completed, another], seenLevel: 2 } };
  };
  await h.run('loadServerMissionTracker()');
  assert.deepEqual(Array.from(h.state().missionTracker.records, item => item.id).sort(), ['another', 'completed', 'current', 'local-only']);
  assert.equal(h.run('activeMissionRecord().evidence'), serverCurrent.evidence);
  assert.equal(h.state().missionTracker.seenLevel, 2);
  assert.equal(h.stats().xp, 50);
  assert.equal(h.stats().drops, 10);
  assert.equal(h.run('autosaveMuted'), false);
  assert.equal(h.calls.tracker, 1);
  assert.equal(h.calls.account, 1);
  assert.deepEqual(h.calls.errors, []);
});

test('server completion wins over an old approved local pin and clears it without losing history', async () => {
  const local = record('current');
  const server = record('current', { status: 'completed', completedAt: 5 });
  const h = harness([local], pin(local));
  h.run('accountSession = { authenticated: true, user: { id: "alice" } }');
  h.context.accountApiStub = async () => ({ missionTracker: { records: [server], seenLevel: 1 } });
  await h.run('loadServerMissionTracker()');
  assert.equal(h.state().pinnedMission, null);
  assert.equal(h.run('activeMissionRecord()'), null);
  assert.equal(h.state().missionTracker.records.length, 1);
  assert.equal(h.state().missionTracker.records[0].status, 'completed');
  assert.equal(h.stats().xp, 25);
  assert.equal(h.calls.pin, 1);
  assert.deepEqual(h.calls.errors, []);
});

test('newer server mission content and evidence survive a stale saved pin', async () => {
  const local = record('current', { content: 'An earlier version of the interview mission.' });
  const server = record('current', { content: 'Mission: Interview six founders about their reporting workflow.', evidence: evidence + ' Newer saved observations.' });
  const expectedContent = server.content;
  const expectedEvidence = server.evidence;
  const h = harness([local], pin(local));
  h.run('accountSession = { authenticated: true, user: { id: "alice" } }');
  h.context.accountApiStub = async () => ({ missionTracker: { records: [server], seenLevel: 1 } });
  await h.run('loadServerMissionTracker()');
  assert.equal(h.run('activeMissionRecord().content'), expectedContent);
  assert.equal(h.run('activeMissionRecord().evidence'), expectedEvidence);
  assert.equal(h.state().pinnedMission.content, expectedContent);
  assert.deepEqual(h.calls.errors, []);
});

for (const [name, change] of [
  ['account switch', 'accountSession = { authenticated: true, user: { id: "bob" } }'],
  ['sign-out', 'accountSession = { authenticated: false, user: null }'],
  ['workspace reload', 'workspaceGeneration += 1'],
  ['mission revision', 'missionRevision += 1'],
  ['unsynced mission changes', 'missionDirty = true'],
]) {
  test(`an in-flight server tracker response is ignored after ${name}`, async () => {
    const current = record('current');
    const h = harness([current], pin(current));
    h.run('accountSession = { authenticated: true, user: { id: "alice" } }');
    let respond;
    h.context.accountApiStub = () => new Promise(resolve => { respond = resolve; });
    const pending = h.run('loadServerMissionTracker()');
    assert.equal(typeof respond, 'function');
    h.run(change);
    respond({ missionTracker: { records: [record('server', { status: 'completed', completedAt: 5 })], seenLevel: 2 } });
    await pending;
    assert.deepEqual(Array.from(h.state().missionTracker.records, item => item.id), ['current']);
    assert.equal(h.state().pinnedMission.sourceMessageId, 'current');
    assert.equal(h.state().missionTracker.seenLevel, 1);
    assert.equal(h.calls.pin, 0);
    assert.equal(h.calls.tracker, 0);
    assert.equal(h.calls.chat, 0);
    assert.equal(h.calls.account, 0);
    assert.deepEqual(h.calls.errors, []);
  });
}
