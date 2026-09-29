import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

// Run the actual browser growth functions with an in-memory DOM and deferred
// API responses. No account bootstrap, network request, or AI call is made.
const growthPath = process.env.BUEELD_GROWTH_JS || fileURLToPath(new URL("./lab-growth.js", import.meta.url));
const appPath = process.env.BUEELD_APP_JS || fileURLToPath(new URL("./app.js", import.meta.url));
const source = readFileSync(growthPath, "utf8");
const appSource = readFileSync(appPath, "utf8");
const appFunctions = appSource.match(/^(?:async )?function [A-Za-z_$][\w$]*\([^\n]*\) \{[\s\S]*?^\}/gm) || [];
const dependencies = ["currentStorageKey", "activeMissionRecord", "latestConversationMissionResult"].map(name => {
  const declaration = appFunctions.find(value => value.startsWith(`function ${name}(`));
  assert.ok(declaration, `Actual app function ${name} exists`);
  return declaration;
}).join("\n\n");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class Element {
  constructor() {
    this.value = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.dataset = {};
    this.children = [];
    this.listeners = {};
    this.focusCount = 0;
    this.scrollCount = 0;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  dispatch(name, event = {}) { return Promise.all((this.listeners[name] || []).map(callback => callback({ preventDefault() {}, currentTarget: this, ...event }))); }
  focus() { this.focusCount++; }
  scrollIntoView() { this.scrollCount++; }
}

const memory = project => ({ project, target: "Independent tutors", goal: "Test first booking", blocker: "Confirmation is unclear" });
const learning = recommendation => ({
  assumption: "Tutors can finish a first booking without guidance.",
  observation: "One of three tutors completed the task without help.",
  decision: "Clarify the confirmation step and repeat the test.",
  nextMission: "Test the revised confirmation with three new tutors.",
  recommendation,
});
const mission = (overrides = {}) => ({
  id: "mission-1", status: "completed", content: "Observe 3 tutors. Target: 2 complete a booking unaided in 2 minutes.",
  evidence: "Observed three tutors on the prototype: one finished unaided, two needed help confirming.",
  realEvidence: true, area: "delivery", outcome: "missed", completedAt: 100,
  ...overrides,
});

function harness({ authenticated = false, userId = null, storage: initial = {} } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const storage = new Map(Object.entries(initial).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
  const calls = { account: [], post: [], storageWrites: [], persisted: [], rendered: 0, statuses: [], chat: [] };
  let context;
  context = vm.createContext({
    console,
    accountSession: { authenticated, user: userId ? { id: userId } : null }, accountReady: true,
    workspaceGeneration: 0, guestHidden: false, chatBusy: false, sourceBusy: false,
    pinnedMission: null, recentMissionCompletionId: null, chatMessages: [], missionTracker: { records: [] },
    MISSION_AREAS: [["need", "Customer need"], ["demand", "Demand"], ["delivery", "Delivery"], ["economics", "Business model"]],
    MISSION_OUTCOMES: ["met", "missed", "inconclusive"],
    $: element,
    el: (tag, className, text) => {
      const node = new Element(); node.tagName = tag; node.className = className; node.textContent = text || ""; return node;
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { calls.storageWrites.push({ key, value }); storage.set(key, value); },
    },
    accountApi: (method, path, body) => {
      const request = { method, path, body, ...deferred() }; calls.account.push(request); return request.promise;
    },
    postJson: (path, body) => {
      const request = { path, body, ...deferred() }; calls.post.push(request); return request.promise;
    },
    isDemoQuotaExhausted: () => false,
    persistMissionTracker: () => calls.persisted.push(JSON.parse(JSON.stringify(context.missionTracker))),
    renderChat: () => { calls.rendered++; vm.runInContext("renderGrowthMissionFeatures()", context); },
    setChatStatus: (message, isError) => calls.statuses.push({ message, isError }),
    submitChatMessage: message => calls.chat.push(message),
    fetch: () => { throw new Error("Real HTTP is forbidden in client tests"); },
  });
  vm.runInContext(dependencies + "\n" + source, context, { filename: "lab-growth.js" });
  const run = expression => vm.runInContext(expression, context);
  const snapshot = expression => JSON.parse(run(`JSON.stringify(${expression})`));
  run("initGrowthFeatures()");
  return {
    context, calls, element, storage, run, snapshot,
    setAccount(id, advanceGeneration = true) {
      context.accountSession = { authenticated: !!id, user: id ? { id } : null };
      if (advanceGeneration) context.workspaceGeneration++;
    },
    setRecords(records) {
      context.missionTracker = { records };
      context.chatMessages = records.map(record => ({ id: record.id, role: "assistant", content: record.content }));
      context.recentMissionCompletionId = records.at(-1)?.id || null;
      run("renderGrowthMissionFeatures()");
    },
    editMemory(value) {
      for (const [field, text] of Object.entries(value)) element("memory-" + field).value = text;
      void element("project-memory-form").dispatch("input");
    },
  };
}

test("growth features initialize with no mission, review or learning error", () => {
  const h = harness();
  assert.equal(h.element("mission-learning-card").hidden, true);
  assert.equal(h.element("learning-status").textContent, "");
  assert.equal(h.element("memory-save").disabled, false);
});

test("project memory is isolated between guest, account A and account B", async () => {
  const base = "bueeld-lab-project-memory-v1";
  const h = harness({ storage: { [base]: memory("Guest project"), [base + "-user-A"]: memory("Project A"), [base + "-user-B"]: memory("Project B") } });
  await h.run("loadProjectMemory()");
  assert.equal(h.snapshot("projectMemory").project, "Guest project");
  assert.equal(h.calls.account.length, 0);
  h.setAccount("A");
  const loadA = h.run("loadProjectMemory()");
  assert.equal(h.element("memory-project").value, "Project A");
  h.calls.account.at(-1).resolve({ projectMemory: memory("Server A") });
  await loadA;
  h.setAccount("B");
  const loadB = h.run("loadProjectMemory()");
  assert.equal(h.element("memory-project").value, "Project B");
  h.calls.account.at(-1).resolve({ projectMemory: memory("Server B") });
  await loadB;
  h.editMemory({ project: "Edited B" });
  const saveB = h.run("saveProjectMemory()");
  h.calls.account.at(-1).resolve({});
  await saveB;
  assert.equal(JSON.parse(h.storage.get(base)).project, "Guest project");
  assert.equal(JSON.parse(h.storage.get(base + "-user-A")).project, "Server A");
  assert.equal(JSON.parse(h.storage.get(base + "-user-B")).project, "Edited B");
});

test("a delayed GET from the previous account cannot replace the current account memory", async () => {
  const h = harness({ authenticated: true, userId: "A" });
  const loadA = h.run("loadProjectMemory()");
  const requestA = h.calls.account.at(-1);
  h.setAccount("B");
  const loadB = h.run("loadProjectMemory()");
  h.calls.account.at(-1).resolve({ projectMemory: memory("Current B") });
  await loadB;
  const writes = h.calls.storageWrites.length;
  requestA.resolve({ projectMemory: memory("Stale A") });
  await loadA;
  assert.equal(h.snapshot("projectMemory").project, "Current B");
  assert.equal(h.element("memory-project").value, "Current B");
  assert.equal(h.calls.storageWrites.length, writes);
});

for (const completion of ["resolve", "reject"]) {
  test(`a delayed PUT ${completion} from the previous account leaves the current account intact`, async () => {
    const h = harness({ authenticated: true, userId: "A" });
    h.editMemory(memory("Submitted A"));
    const saveA = h.run("saveProjectMemory()");
    const requestA = h.calls.account.at(-1);
    assert.equal(requestA.method, "PUT");
    assert.equal(h.element("memory-save").disabled, true);
    h.setAccount("B");
    const loadB = h.run("loadProjectMemory()");
    h.calls.account.at(-1).resolve({ projectMemory: memory("Current B") });
    await loadB;
    requestA[completion](completion === "reject" ? new Error("Old account failure") : {});
    await saveA;
    assert.equal(h.snapshot("projectMemory").project, "Current B");
    assert.equal(h.element("memory-project").value, "Current B");
    assert.equal(h.element("memory-status").textContent, "");
    assert.equal(h.element("memory-save").disabled, false);
    assert.equal(JSON.parse(h.storage.get("bueeld-lab-project-memory-v1-user-A")).project, "Submitted A");
  });
}

test("a delayed GET cannot overwrite memory fields being edited", async () => {
  const h = harness({ authenticated: true, userId: "A" });
  const loading = h.run("loadProjectMemory()");
  h.editMemory({ project: "My unfinished edit" });
  h.calls.account.at(-1).resolve({ projectMemory: memory("Late server content") });
  await loading;
  assert.equal(h.element("memory-project").value, "My unfinished edit");
  assert.equal(h.run("memoryDraftDirty"), true);
  assert.equal(h.snapshot("projectMemory").project, "");
  assert.equal(h.calls.storageWrites.length, 0);
});

for (const completion of ["resolve", "reject"]) {
  test(`editing during PUT ${completion} preserves the newer draft and enables saving again`, async () => {
    const h = harness({ authenticated: true, userId: "A" });
    h.editMemory(memory("Submitted context"));
    const saving = h.run("saveProjectMemory()");
    assert.equal(h.element("memory-save").disabled, true);
    const request = h.calls.account.at(-1);
    h.editMemory({ project: "Newer unsaved draft" });
    request[completion](completion === "reject" ? new Error("Temporary sync failure") : {});
    await saving;
    assert.equal(h.element("memory-project").value, "Newer unsaved draft");
    assert.equal(h.run("memoryDraftDirty"), true);
    assert.equal(h.element("memory-save").disabled, false);
    assert.equal(h.run("memorySaving"), false);
    assert.match(h.element("memory-status").textContent, /Unsaved changes/);
    assert.equal(h.snapshot("projectMemory").project, "Submitted context");
    assert.equal(JSON.parse(h.storage.get("bueeld-lab-project-memory-v1-user-A")).project, "Submitted context");
    const saveNewer = h.run("saveProjectMemory()");
    assert.equal(h.calls.account.at(-1).body.projectMemory.project, "Newer unsaved draft");
    h.calls.account.at(-1).resolve({});
    await saveNewer;
    assert.equal(h.element("memory-save").disabled, false);
    assert.equal(h.run("memoryDraftDirty"), false);
  });
}

test("review failures preserve existing evidence and learning without persisting a replacement", async () => {
  const h = harness();
  const prior = learning("iterate");
  const record = mission({ learning: prior });
  h.setRecords([record]);
  const review = h.run("reviewMissionResult()");
  h.calls.post.at(-1).reject(new Error("Lia is temporarily unavailable"));
  await review;
  assert.deepEqual(record.learning, prior);
  assert.match(record.evidence, /Observed three tutors/);
  assert.equal(h.calls.persisted.length, 0);
  assert.equal(h.context.chatBusy, false);
  assert.match(h.element("learning-status").textContent, /temporarily unavailable/);
});

for (const outcome of ["missed", "inconclusive"]) {
  test(`a ${outcome} outcome rejects a continue recommendation`, async () => {
    const h = harness();
    const record = mission({ outcome });
    h.setRecords([record]);
    const review = h.run("reviewMissionResult()");
    assert.equal(h.calls.post.at(-1).path, "/api/mission/learn");
    assert.equal(h.calls.post.at(-1).body.mission.outcome, outcome);
    h.calls.post.at(-1).resolve({ source: "crusoe", learning: learning("continue") });
    await review;
    assert.equal(record.learning, undefined);
    assert.equal(h.calls.persisted.length, 0);
    assert.match(h.element("learning-status").textContent, /did not account for your result/);
    assert.equal(h.context.chatBusy, false);
  });
}

test("an incomplete or untrusted review is rejected while a valid adaptive review is persisted", async () => {
  const h = harness();
  const record = mission();
  h.setRecords([record]);
  for (const response of [{ source: "fallback", learning: learning("iterate") }, { source: "crusoe", learning: { ...learning("iterate"), decision: "" } }]) {
    const review = h.run("reviewMissionResult()");
    h.calls.post.at(-1).resolve(response);
    await review;
    assert.equal(record.learning, undefined);
    assert.equal(h.calls.persisted.length, 0);
    assert.match(h.element("learning-status").textContent, /incomplete/);
  }
  const review = h.run("reviewMissionResult()");
  h.calls.post.at(-1).resolve({ source: "crusoe", learning: learning("iterate") });
  await review;
  assert.equal(record.learning.recommendation, "iterate");
  assert.equal(h.calls.persisted.length, 1);
  assert.equal(h.element("mission-learning-content").hidden, false);
  assert.equal(h.snapshot("missionMilestones()")[1].earned, true);
});

test("a review returned after a workspace change is ignored", async () => {
  const h = harness();
  const previous = mission();
  h.setRecords([previous]);
  const review = h.run("reviewMissionResult()");
  h.context.workspaceGeneration++;
  const current = mission({ id: "new-workspace-mission", outcome: "met" });
  h.setRecords([current]);
  h.calls.post.at(-1).resolve({ source: "crusoe", learning: learning("iterate") });
  await review;
  assert.equal(previous.learning, undefined);
  assert.equal(current.learning, undefined);
  assert.equal(h.calls.persisted.length, 0);
  assert.equal(h.run("learningError"), null);
  assert.equal(h.element("mission-learning-card").focusCount, 0);
});

test("a stale review cannot release the busy state of work in the new workspace", async () => {
  const h = harness();
  h.setRecords([mission()]);
  const review = h.run("reviewMissionResult()");
  h.context.workspaceGeneration++;
  h.setRecords([mission({ id: "new-workspace-mission" })]);
  h.context.chatBusy = true;
  h.run('reviewingMissionId = "new-workspace-mission"');
  h.calls.post.at(-1).resolve({ source: "crusoe", learning: learning("iterate") });
  await review;
  assert.equal(h.context.chatBusy, true);
  assert.equal(h.run("reviewingMissionId"), "new-workspace-mission");
  assert.equal(h.calls.persisted.length, 0);
});

test("a review returned after the evidence changes is ignored", async () => {
  const h = harness();
  const record = mission();
  h.setRecords([record]);
  const review = h.run("reviewMissionResult()");
  record.evidence = "Updated observation: none of the three tutors completed the booking unaided.";
  h.calls.post.at(-1).resolve({ source: "crusoe", learning: learning("iterate") });
  await review;
  assert.equal(record.learning, undefined);
  assert.equal(h.calls.persisted.length, 0);
});

test("fictional evidence earns no milestones and duplicate records cannot earn the three-test badge", () => {
  const h = harness();
  h.setRecords([mission({ id: "demo-1", realEvidence: false, learning: learning("iterate") }), mission({ id: "demo-2", realEvidence: false }), mission({ id: "demo-3", realEvidence: false })]);
  assert.deepEqual(h.snapshot("missionMilestones()").map(item => item.earned), [false, false, false]);
  const duplicate = mission({ outcome: "met" });
  h.setRecords([duplicate, { ...duplicate }, { ...duplicate }]);
  assert.deepEqual(h.snapshot("missionMilestones()").map(item => item.earned), [true, false, false]);
  h.setRecords([mission({ id: "real-1", outcome: "met" }), mission({ id: "real-2", outcome: "met" }), mission({ id: "real-3", outcome: "met" })]);
  assert.equal(h.snapshot("missionMilestones()")[2].earned, true);
});

test("assumption challenged requires real evidence, a missed target and a valid change-of-direction review", () => {
  const h = harness();
  for (const overrides of [
    { outcome: "missed" },
    { outcome: "met", learning: learning("iterate") },
    { outcome: "inconclusive", learning: learning("stop") },
    { outcome: "missed", learning: learning("continue") },
    { outcome: "missed", learning: { ...learning("iterate"), nextMission: "" } },
    { outcome: "missed", learning: learning("iterate"), realEvidence: false },
  ]) {
    h.setRecords([mission(overrides)]);
    assert.equal(h.snapshot("missionMilestones()")[1].earned, false, JSON.stringify(overrides));
  }
  for (const recommendation of ["iterate", "stop"]) {
    h.setRecords([mission({ learning: learning(recommendation) })]);
    assert.equal(h.snapshot("missionMilestones()")[1].earned, true);
  }
});

test("preparing the next mission preserves a draft and only pre-fills an empty composer", () => {
  const h = harness();
  const record = mission({ learning: learning("iterate") });
  h.setRecords([record]);
  h.element("chat-input").value = "Keep this unsent question exactly as it is.";
  h.run("planFromLearning()");
  assert.equal(h.element("chat-input").value, "Keep this unsent question exactly as it is.");
  assert.match(h.calls.statuses.at(-1).message, /Your draft is still here/);
  assert.equal(h.calls.chat.length, 0);
  assert.equal(h.calls.post.length, 0);
  h.element("chat-input").value = "";
  h.run("planFromLearning()");
  assert.match(h.element("chat-input").value, /^Self-reported result:/);
  assert.ok(h.element("chat-input").value.includes(record.learning.nextMission));
  assert.match(h.element("chat-input").value, /for me to approve/);
  assert.equal(h.calls.chat.length, 0, "The suggestion is never sent automatically");
  assert.equal(h.calls.persisted.length, 0);
  record.realEvidence = false;
  h.element("chat-input").value = "";
  h.run("planFromLearning()");
  assert.match(h.element("chat-input").value, /^Fictional demo result:/);
});
