import assert from 'node:assert/strict';
import test from 'node:test';
import { bandConfiguration, bandPrompt, createBandReviewService, normalizeBandAdviceInput,
  validateFinal, validateProposal } from './band-review.mjs';
import { runBandAgent } from './band-agent-worker.mjs';

const SCOUT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CRITIC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OWNER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ROOM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const config = { configured: true, scout: { id: SCOUT, key: 'scout-key' }, critic: { id: CRITIC, key: 'critic-key' } };
const snapshot = {
  project: { name: 'BUEELD', summary: 'A founder workspace' },
  nextMission: { id: 'interest_test' },
  maturity: { milestones: [{ id: 'interest_test', title: 'Run an interest test', status: 'pending',
    description: 'Put a proposition in front of real people.', criterion: 'Real test analyzed.',
    questions: ['Who answered?'], draft: { answers: ['Three founders'], reviewed: [false] }, evidence: null }] },
};

function fakeBand({ mismatch = false } = {}) {
  const log = [];
  const inbox = new Map();
  const waiters = new Map();
  const processing = new Set();
  const roomMembers = new Set([SCOUT]);
  const profile = (key) => ({ id: key === 'scout-key' ? SCOUT : CRITIC,
    ownerId: OWNER, name: key === 'scout-key' ? 'Scout' : 'Critic',
    handle: key === 'scout-key' ? 'scout' : 'critic' });
  let counter = 1;
  const uuid = () => `eeeeeeee-eeee-4eee-8eee-${String(counter++).padStart(12, '0')}`;
  return { log,
    async profile(key) { log.push(['profile', key]); return profile(key); },
    async createRoom(key) { log.push(['createRoom', key]); return ROOM; },
    async renameRoom(key, roomId, title) { log.push(['renameRoom', title]); },
    async addParticipant(key, roomId, id) { roomMembers.add(id); log.push(['addParticipant', id]); },
    async listParticipants() { return [...roomMembers].map((id) => id === OWNER
      ? { id, name: 'Maxime', handle: 'maxime' } : { id, name: id === SCOUT ? 'Scout' : 'Critic', handle: id === SCOUT ? 'scout' : 'critic' }); },
    async sendEvent(key, roomId, type, content) { log.push(['event', key, type, content]); },
    async subscribe(key) {
      const id = profile(key).id;
      inbox.set(id, []);
      log.push(['subscribe', id]);
      return { nextFrom: async (senderId) => {
        const queue = inbox.get(id);
        const index = queue.findIndex((item) => item.senderId === senderId);
        if (index >= 0) return queue.splice(index, 1)[0];
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Band mention timed out')), 1_000);
          waiters.set(id, { senderId, resolve: (message) => { clearTimeout(timer); resolve(message); } });
        });
      }, close() { log.push(['close', id]); } };
    },
    async sendMessage(key, roomId, target, content) {
      const senderId = profile(key).id;
      assert.ok(roomMembers.has(target.id), 'mentioned recipient must be in the room');
      assert.notEqual(senderId, target.id, 'an agent cannot mention itself');
      const id = uuid();
      log.push(['message', senderId, target.id, content]);
      const message = { id, senderId, content: `@${target.handle} ${mismatch && target.id === CRITIC ? '{"kind":"bad"}' : content}` };
      const waiter = waiters.get(target.id);
      if (waiter?.senderId === senderId) { waiters.delete(target.id); waiter.resolve(message); }
      else if (inbox.has(target.id)) inbox.get(target.id).push(message);
      return id;
    },
    async markProcessing(key, roomId, id) { processing.add(id); log.push(['processing', key, id]); },
    async markProcessed(key, roomId, id) {
      assert.ok(processing.delete(id), 'Band rejects /processed without /processing');
      log.push(['processed', key, id]);
    },
    async markFailed(key, roomId, id) { log.push(['failed', key, id]); },
  };
}

function fakeProvider(prompts) {
  return { async generateStructured({ prompt, validate }) {
    prompts.push(prompt);
    let output;
    const proposal = { name: 'SignalDesk', target: 'Independent tutors',
      problem: 'Tutors may lose clients during manual scheduling.',
      solution: 'Offer a lightweight booking assistant for tutors.',
      firstExperiment: 'Show a clickable booking flow to tutors and record whether they would use it.',
      risks: ['Low willingness to pay'], assumptions: ['Tutors spend time coordinating appointments'] };
    if (prompt.includes('Create a specific startup concept')) output = {
      summary: 'A scheduling concept for tutors, still unvalidated.',
      nextStep: 'Test demand with a small target sample.',
      questions: ['Which tutors have the strongest scheduling pain?'], proposal,
    };
    else if (prompt.includes('Challenge the actual proposed target')) output = {
      verdict: 'block', reason: 'No recorded customer evidence supports the proposed market demand.',
      questions: ['What actual tutor interviews support this problem?'],
    };
    else if (prompt.includes('Revise your COMPLETE proposal')) output = {
      summary: 'Validated demand means this should launch immediately.',
      suggestions: ['Launch now.', 'Lia, what customer evidence would change this?'],
      proposal: { ...proposal, problem: 'Validated scheduling pain exists.',
        solution: 'Launch the product to every tutor now.', firstExperiment: 'Launch at scale immediately.' },
    };
    else if (prompt.includes('You are the BUEELD Scout')) output = {
      summary: 'The sample hints at interest but is too small to validate demand.',
      nextStep: 'Collect more responses from the target audience.',
      questions: ['How many respondents fit the target audience?'],
    };
    else if (prompt.includes('You are the BUEELD Critic')) output = {
      verdict: 'block', reason: 'Declaring demand validated from three founder responses is unsupported.',
      questions: ['What sample size did we set in advance?'],
    };
    else output = {
      // Deliberately unsafe Scout final text: the code must enforce Critic's veto.
      summary: 'Launch immediately; this evidence validates demand.',
      suggestions: ['Launch now and ignore Lia.',
        'Lia, what minimum sample should I collect before calling this validated?'],
    };
    const data = validate(output);
    assert.ok(data);
    return { data };
  } };
}

function fakeWorkers(band, prompts) {
  return (options) => {
    let readyResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    const done = runBandAgent({ ...options, client: band, provider: fakeProvider(prompts),
      onReady: readyResolve });
    done.catch(() => {});
    return { ready, done, stop: () => {} };
  };
}

test('independent Band agents react to addressed room messages before final advice', async () => {
  const band = fakeBand();
  const prompts = [];
  const service = createBandReviewService({ client: band, config, workerFactory: fakeWorkers(band, prompts),
    responseTimeoutMs: 1_000 });
  const result = await service.advise({ ownerId: 'lab-owner', snapshot, projectMemory: { goal: 'Find early demand' },
    input: { missionId: 'interest_test', question: 'Can we declare demand validated now from these three replies?', context: {
      missions: [{ kind: 'lia_pinned', description: 'Speak with founders', status: 'approved' }],
      recentConversation: [{ role: 'user', text: 'Three people replied.' }],
    } } });
  assert.equal(result.roomId, ROOM);
  assert.equal(result.advice.verdict, 'block');
  assert.match(result.advice.summary, /vetoed the proposed decision/i);
  assert.doesNotMatch(result.advice.summary, /launch|validates demand/i);
  assert.ok(result.suggestions.every((item) => item.endsWith('?') && !/launch now/i.test(item)));
  assert.equal(result.suggestions.length, 2);
  const messages = band.log.filter((item) => item[0] === 'message');
  assert.deepEqual(messages.map((item) => [item[1], item[2]]),
    [[CRITIC, SCOUT], [SCOUT, CRITIC], [CRITIC, SCOUT], [SCOUT, OWNER]]);
  assert.ok(band.log.findIndex((item) => item[0] === 'subscribe' && item[1] === CRITIC) < band.log.findIndex((item) => item[0] === 'message'));
  assert.match(prompts[1], /Scout message delivered by Band/);
  assert.match(prompts[1], /independently of whether Scout already warns against it/);
  assert.match(prompts[1], /declare demand validated now/);
  assert.match(prompts[1], /sample hints at interest/);
  assert.match(prompts[0], /Speak with founders/);
  assert.match(prompts[0], /Three people replied/);
  assert.match(prompts[2], /Critic response delivered by Band/);
  assert.match(prompts[2], /Declaring demand validated from three founder responses/);
  assert.equal(band.log.filter((item) => item[0] === 'processing').length, 3);
  assert.equal(band.log.filter((item) => item[0] === 'processed').length, 3);
  assert.doesNotMatch(messages[3][3], /launch|validates demand/i);
  assert.ok(band.log.some((item) => item[0] === 'event' && item[2] === 'tool_result'));
});

test('rejects a mission outside the account snapshot before contacting Band', async () => {
  const band = fakeBand();
  const service = createBandReviewService({ client: band, config, workerFactory: fakeWorkers(band, []) });
  await assert.rejects(service.advise({ ownerId: 'lab-owner', snapshot, input: {
    missionId: 'pilot_ready', question: 'Review this mission',
  } }), { code: 'BAND_MISSION_NOT_FOUND', status: 404 });
  assert.equal(band.log.length, 0);
});

test('a mismatched live message stops the review and never sends final advice', async () => {
  const band = fakeBand({ mismatch: true });
  const service = createBandReviewService({ client: band, config, workerFactory: fakeWorkers(band, []),
    responseTimeoutMs: 1_000 });
  await assert.rejects(service.advise({ ownerId: 'lab-owner', snapshot,
    input: { question: 'What should change?' } }), (error) => {
    assert.equal(error.code, 'BAND_INVALID_RESPONSE');
    assert.equal(error.roomId, ROOM);
    return true;
  });
  assert.equal(band.log.filter((item) => item[0] === 'message').length, 2);
  assert.ok(band.log.some((item) => item[0] === 'event' && item[2] === 'error'));
});

test('Lia chat reply enters both Band agents’ context without mutating mission state', async () => {
  const band = fakeBand();
  const prompts = [];
  const before = structuredClone(snapshot);
  const service = createBandReviewService({ client: band, config, workerFactory: fakeWorkers(band, prompts),
    responseTimeoutMs: 1_000 });
  const result = await service.advise({ ownerId: 'lab-owner', snapshot, chatReply: true,
    input: { question: 'Was my answer enough?', liaReply: 'Lia suggested a wider sample.',
      missionId: 'interest_test' } });
  assert.equal(result.advice.verdict, 'block');
  assert.match(prompts[0], /Lia suggested a wider sample/);
  assert.match(prompts[1], /Lia suggested a wider sample/);
  assert.deepEqual(snapshot, before);
});

test('Create uses the same independent Band relay and vetoes endorsement of an unvalidated startup proposal', async () => {
  const band = fakeBand();
  const prompts = [];
  const before = structuredClone(snapshot);
  const service = createBandReviewService({ client: band, config, workerFactory: fakeWorkers(band, prompts),
    responseTimeoutMs: 1_000 });
  const result = await service.advise({ ownerId: 'lab-owner', snapshot, create: true,
    projectMemory: { target: 'Independent tutors', goal: 'Reduce scheduling friction' },
    input: { context: { recentConversation: [{ role: 'assistant', text: 'Lia suggested interviewing tutors.' }] } } });
  assert.equal(result.proposal.name, 'Draft: SignalDesk');
  assert.match(result.proposal.problem, /^Hypothesis to test:/);
  assert.match(result.proposal.solution, /^Concept to test:/);
  assert.doesNotMatch(result.proposal.solution, /launch the product to every tutor now/i);
  assert.match(result.proposal.risks[0], /No recorded customer evidence/);
  assert.match(result.proposal.firstExperiment, /small, reversible test/);
  assert.doesNotMatch(result.proposal.firstExperiment, /launch at scale immediately/i);
  assert.equal(result.advice.verdict, 'block');
  assert.match(result.advice.summary, /vetoed endorsement/i);
  assert.doesNotMatch(result.advice.summary, /launch immediately|validated demand/i);
  assert.ok(result.suggestions.every((item) => item.endsWith('?') && !/launch now/i.test(item)));
  assert.match(prompts[0], /Lia suggested interviewing tutors/);
  assert.match(prompts[1], /Scout proposal delivered by Band/);
  assert.match(prompts[2], /Critic response delivered by Band/);
  assert.deepEqual(band.log.filter((item) => item[0] === 'message').map((item) => [item[1], item[2]]),
    [[CRITIC, SCOUT], [SCOUT, CRITIC], [CRITIC, SCOUT], [SCOUT, OWNER]]);
  assert.deepEqual(snapshot, before);
});

test('configuration requires two distinct agents, and client context is bounded', () => {
  assert.equal(bandConfiguration({}).configured, false);
  assert.equal(bandConfiguration({ BAND_SCOUT_AGENT_ID: SCOUT, BAND_SCOUT_API_KEY: 'one',
    BAND_CRITIC_AGENT_ID: CRITIC, BAND_CRITIC_API_KEY: 'two' }).configured, true);
  assert.throws(() => normalizeBandAdviceInput({ question: 'Review', context: { recentMessages: ['x'.repeat(5_000)] } }, snapshot),
    { code: 'BAND_INVALID_INPUT' });
  assert.throws(() => normalizeBandAdviceInput({ question: 'Review', liaReply: 'x'.repeat(2_001) }, snapshot, {}, { chatReply: true }),
    { code: 'BAND_INVALID_INPUT' });
  const normalized = normalizeBandAdviceInput({ question: 'Review', missionId: 'interest_test' }, snapshot);
  assert.equal(normalized.mission.guidedFounderAnswers[0].reviewedByLia, false);
});

test('long Scout summaries end at a word boundary', () => {
  const result = validateFinal({ summary: `${'well '.repeat(250)}unfinishedword`, suggestions: ['Question one?', 'Question two?'] });
  assert.ok(result.summary.length <= 1_200);
  assert.match(result.summary, /well…$/);
  assert.doesNotMatch(result.summary, /unfinish/);
});

test('missing recorded evidence stays unknown while founder-reported counts remain attributed', () => {
  const context = normalizeBandAdviceInput({ question: 'Can I declare demand validated after one anonymous response?',
    missionId: 'interest_test' }, snapshot);
  assert.equal(context.mission.evidenceSummary, null);
  assert.equal(context.mission.recordedMetric, null);
  const prompt = bandPrompt('critic', context, { summary: 'One response is not enough.' });
  assert.match(prompt, /missing or null recorded evidence means UNKNOWN, never zero collected/);
  assert.match(prompt, /founder-reported, unverified claim/);
  assert.match(prompt, /NOT counts of customer responses/);
  assert.match(prompt, /one anonymous response/);
  const withMetric = structuredClone(snapshot);
  withMetric.maturity.milestones[0].evidence = { summary: 'Recorded observations from a test', metric: { observed: 1, unit: 'response' } };
  assert.deepEqual(normalizeBandAdviceInput({ question: 'Review the metric' }, withMetric).mission.recordedMetric,
    { observed: 1, unit: 'response' });
  const withRelated = structuredClone(snapshot);
  withRelated.maturity.milestones.push({ id: 'pilot_readiness', title: 'Pilot readiness', status: 'pending',
    criterion: 'Review pilot readiness', draft: {} });
  const related = normalizeBandAdviceInput({ question: 'Review', context: {
    missions: [{ kind: 'project_milestone', id: 'pilot_readiness' }],
  } }, withRelated).founderContext.relatedMissions[0];
  assert.equal(related.guidedFounderAnswerCount, null);
});

test('Create rejects a long or unfinished experiment instead of cutting off its decision criterion', () => {
  const proposal = { name: 'Testable', target: 'Tutors', problem: 'Scheduling friction',
    solution: 'A lightweight booking tool', risks: ['May not pay'], assumptions: ['Frequent bookings'],
    firstExperiment: 'Interview tutors and predeclare a pass/fail threshold before building.' };
  assert.equal(validateProposal({ ...proposal, firstExperiment: `${'Interview tutors and measure completion. '.repeat(15)}but compare` }), false);
  assert.equal(validateProposal({ ...proposal, firstExperiment: 'Interview tutors and record outcomes but…' }), false);
  assert.equal(validateProposal(proposal).firstExperiment, proposal.firstExperiment);
  assert.match(bandPrompt('final', { question: 'Create a concept' }, {}, 'create'), /one complete sentence under 450 characters/);
});
