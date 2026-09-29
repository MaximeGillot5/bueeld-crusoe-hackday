import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const appPath = fileURLToPath(new URL('./app.js', import.meta.url));
const source = readFileSync(appPath, 'utf8');
const startMission = source.match(/^async function startReadinessMission\([^\n]*\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(startMission, 'The browser mission entry point must exist');
const activateMission = source.match(/^function activateReadinessForChat\([^\n]*\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(activateMission, 'Switching chats must restore the guide bound to that chat');

function missionHarness({ currentChat = 'new-chat', boundChat = 'mission-chat', missionId = 'target_problem', bindings = { target_problem: boundChat }, loadSucceeds = true } = {}) {
  const calls = [];
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: '', checked: false, open: false, focus() {} });
    return nodes.get(id);
  };
  const context = vm.createContext({
    accountSession: { authenticated: true, user: { id: 'founder' } },
    accountReady: true, accountBusy: false, chatBusy: false, sourceBusy: false, readinessBusy: false,
    workspaceGeneration: 1,
    readinessSnapshot: { nextMission: { id: missionId } },
    readinessMissionId: 'target_problem',
    readinessResumeMissionId: 'target_problem',
    readinessConversationId: boundChat,
    readinessMissionChats: new Map(Object.entries(bindings).map(([id, binding]) =>
      [id, typeof binding === 'string'
        ? { conversationId: binding, paused: true, updatedAt: Date.now() }
        : { ...binding, updatedAt: Date.now() }])),
    readinessPaused: false,
    activeConversationId: currentChat,
    readinessComposerDrafts: new Map(),
    readinessEditDrafts: new Map(),
    readinessEditIndex: null,
    readinessHeldComposer: '', readinessHeldConversationId: null,
    readinessCompletion: null, readinessCompletionConversationId: null,
    readinessRequestId: null, readinessExperimentsFetched: false, readinessExperimentId: '',
    onboarding: { active: false },
    $: node,
    readinessMilestone: (id) => ({ id, title: id, validated: false, guidedEvidenceType: 'documentation', draft: { answers: [] } }),
    readinessGuideActive: () => Boolean(context.readinessMissionId &&
      context.readinessConversationId === context.activeConversationId),
    openSavedConversation: async (id) => {
      calls.push(`open:${id}`);
      if (loadSucceeds) context.activeConversationId = id;
    },
    ensureReadinessConversation: async () => { calls.push(`ensure:${context.activeConversationId}`); return true; },
    prefillUnreviewedReadinessAnswer: () => {},
    rememberReadinessGuide: () => {},
    readinessQuestionIndex: () => 0,
    setReadinessStatus: () => {},
    setChatStatus: (message, error) => { calls.push(`status:${error ? 'error' : 'ok'}:${message}`); },
    renderChat: () => {},
    renderReadinessMission: () => {},
    window: { BUILDHome: { selectView: () => {} } },
    history: { replaceState: () => {} },
  });
  vm.runInContext(`${activateMission}\n${startMission}`, context, { filename: appPath });
  return {
    context, calls,
    start: (id = missionId) => vm.runInContext(`startReadinessMission(${JSON.stringify(id)})`, context),
    activate: (chatId) => {
      context.activeConversationId = chatId;
      return vm.runInContext(`activateReadinessForChat(${JSON.stringify(chatId)})`, context);
    },
  };
}

test('resuming an existing mission reopens its original chat before enabling the guide', async () => {
  const h = missionHarness();
  await h.start();
  assert.deepEqual(h.calls.slice(0, 2), ['open:mission-chat', 'ensure:mission-chat']);
  assert.equal(h.context.activeConversationId, 'mission-chat');
  assert.equal(h.context.readinessConversationId, 'mission-chat');
});

test('a failed mission-chat load does not move the mission to the current chat', async () => {
  const h = missionHarness({ loadSucceeds: false });
  await h.start();
  assert.deepEqual(h.calls.filter((call) => call.startsWith('open:') || call.startsWith('ensure:')), ['open:mission-chat']);
  assert.equal(h.context.activeConversationId, 'new-chat');
  assert.equal(h.context.readinessConversationId, 'mission-chat');
  assert.ok(h.calls.some((call) => call.startsWith('status:error:Could not reopen the mission chat')));
});

test('two unfinished missions retain their own chats across alternating resumes', async () => {
  const h = missionHarness({
    currentChat: 'chat-A',
    boundChat: 'chat-A',
    bindings: { target_problem: 'chat-A', value_proposition: 'chat-B' },
  });
  for (const [missionId, expectedChat] of [
    ['target_problem', 'chat-A'],
    ['value_proposition', 'chat-B'],
    ['target_problem', 'chat-A'],
    ['value_proposition', 'chat-B'],
  ]) {
    await h.start(missionId);
    assert.equal(h.context.activeConversationId, expectedChat, `${missionId} reopens its own chat`);
    assert.equal(h.context.readinessConversationId, expectedChat, `${missionId} guides its own chat`);
    assert.equal(h.context.readinessMissionChats.get('target_problem')?.conversationId, 'chat-A');
    assert.equal(h.context.readinessMissionChats.get('value_proposition')?.conversationId, 'chat-B');
  }
  assert.deepEqual(h.calls.filter((call) => call.startsWith('open:') || call.startsWith('ensure:')), [
    'ensure:chat-A', 'open:chat-B', 'ensure:chat-B', 'open:chat-A', 'ensure:chat-A',
    'open:chat-B', 'ensure:chat-B',
  ]);
});


test('switching chats restores only the mission linked to that chat', () => {
  const h = missionHarness({
    currentChat: 'chat-A',
    boundChat: 'chat-A',
    bindings: {
      target_problem: { conversationId: 'chat-A', paused: false },
      value_proposition: { conversationId: 'chat-B', paused: false },
    },
  });
  for (const [chatId, missionId] of [
    ['chat-A', 'target_problem'],
    ['chat-B', 'value_proposition'],
    ['chat-A', 'target_problem'],
  ]) {
    h.activate(chatId);
    assert.equal(h.context.readinessMissionId, missionId);
    assert.equal(h.context.readinessResumeMissionId, missionId);
    assert.equal(h.context.readinessConversationId, chatId);
    assert.equal(h.context.readinessMissionChats.get('target_problem')?.conversationId, 'chat-A');
    assert.equal(h.context.readinessMissionChats.get('value_proposition')?.conversationId, 'chat-B');
  }
});
