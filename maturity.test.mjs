import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaturityStore, MILESTONES } from './maturity.mjs';
import { analyzeMissionTurn, normalizeMissionTurnDecision, normalizeMissionTurnHistory } from './mission-turn.mjs';

const realEvidence = (summary = 'Three target customers described the same need in separate interviews.') =>
  ({ summary, real: true, reference: 'Interview notes held by the founder.' });
const manual = { kind: 'manual' };

async function withStore(run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'build-maturity-test-'));
  try { await run(createMaturityStore({ dataDir }), dataDir); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}

test('fixed roadmap totals 100 with four 25-point dimensions', () => {
  assert.equal(MILESTONES.length, 12);
  assert.equal(MILESTONES.reduce((total, item) => total + item.weight, 0), 100);
  for (const dimension of new Set(MILESTONES.map((item) => item.dimension))) {
    assert.equal(MILESTONES.filter((item) => item.dimension === dimension)
      .reduce((total, item) => total + item.weight, 0), 25);
  }
});

test('a real completed mission advances once and survives restart', async () => {
  await withStore(async (store, dataDir) => {
    const input = { ownerId: 'founder_a', projectId: 'build', milestoneId: 'target_problem',
      evidence: realEvidence(), source: manual, outcome: 'met', requestId: 'first' };
    const first = await store.validateMilestone(input);
    assert.deepEqual(first.transition, { before: 0, after: 5, gain: 5, milestoneId: 'target_problem', duplicate: false });
    assert.equal(first.maturity.percent, 5);
    assert.equal(first.nextMission.gain, 10);
    const repeat = await store.validateMilestone(input);
    assert.equal(repeat.transition.gain, 0);
    assert.equal(repeat.maturity.percent, 5);
    assert.equal(repeat.history.length, 1);
    const restarted = createMaturityStore({ dataDir });
    assert.equal((await restarted.getSnapshot({ ownerId: 'founder_a', projectId: 'build' })).maturity.percent, 5);
  });
});

test('accounts and projects have independent scores', async () => {
  await withStore(async (store) => {
    await store.validateMilestone({ ownerId: 'founder_a', projectId: 'build', milestoneId: 'target_problem',
      evidence: realEvidence(), source: manual, outcome: 'met' });
    assert.equal((await store.getSnapshot({ ownerId: 'founder_b', projectId: 'build' })).maturity.percent, 0);
    assert.equal((await store.getSnapshot({ ownerId: 'founder_a', projectId: 'other' })).maturity.percent, 0);
  });
});

test('negative interest test earns only the learning milestone; fake evidence earns none', async () => {
  await withStore(async (store) => {
    const base = { ownerId: 'founder_a', projectId: 'build', source: manual };
    await assert.rejects(store.validateMilestone({ ...base, milestoneId: 'interest_test',
      evidence: { ...realEvidence(), real: false }, outcome: 'learned' }), /real-world evidence/);
    const learning = await store.validateMilestone({ ...base, milestoneId: 'interest_test',
      evidence: realEvidence('Only one of eight respondents showed interest; the founder analyzed this negative result.'),
      outcome: 'learned' });
    assert.equal(learning.maturity.percent, 5);
    assert.equal(learning.maturity.milestones.find((item) => item.id === 'engagement_signal').status, 'pending');
    await assert.rejects(store.validateMilestone({ ...base, milestoneId: 'engagement_signal',
      evidence: realEvidence(), outcome: 'learned' }), /readiness milestone/);
  });
});

test('measured readiness rejects missing or insufficient results', async () => {
  await withStore(async (store) => {
    const base = { ownerId: 'founder_a', projectId: 'build', milestoneId: 'engagement_signal',
      source: manual, outcome: 'met' };
    await assert.rejects(store.validateMilestone({ ...base, evidence: realEvidence() }), /Set the criterion before/);
    const criterion = { comparison: 'at_least', threshold: 3, unit: 'deposits' };
    const planned = await store.setCriterion({ ...base, criterion });
    assert.deepEqual(planned.maturity.milestones.find((item) => item.id === 'engagement_signal').plannedCriterion.criterion, criterion);
    await assert.rejects(store.setCriterion({ ...base,
      criterion: { comparison: 'at_least', threshold: 2, unit: 'deposits' } }), /already fixed/);
    await assert.rejects(store.validateMilestone({ ...base,
      evidence: { ...realEvidence(), observed: 3, criterion: { comparison: 'at_least', threshold: 2, unit: 'deposits' } },
    }), /criterion fixed/);
    await assert.rejects(store.validateMilestone({ ...base,
      evidence: { ...realEvidence(), observed: 2, criterion },
    }), /does not meet/);
    const passed = await store.validateMilestone({ ...base,
      evidence: { ...realEvidence(), observed: 3, criterion },
    });
    assert.equal(passed.maturity.percent, 15);
    assert.equal(passed.maturity.milestones.find((item) => item.id === 'engagement_signal').evidence.metric.observed, 3);
  });
});

test('all twelve evidenced milestones reach exactly 100 and activate the pilot action', async () => {
  await withStore(async (store) => {
    let latest;
    for (const milestone of MILESTONES) {
      const evidence = realEvidence();
      if (milestone.metric) {
        evidence.criterion = { comparison: 'at_least', threshold: 3, unit: 'people' };
        evidence.observed = 4;
        await store.setCriterion({ ownerId: 'founder_a', projectId: 'build',
          milestoneId: milestone.id, criterion: evidence.criterion });
      }
      latest = await store.validateMilestone({ ownerId: 'founder_a', projectId: 'build',
        milestoneId: milestone.id, evidence, source: manual, outcome: 'met' });
    }
    assert.equal(latest.maturity.percent, 100);
    assert.equal(latest.maturity.status, 'mature');
    assert.equal(latest.nextMission.id, 'launch_pilot');
    assert.equal(latest.maturity.dimensions.reduce((sum, item) => sum + item.earned, 0), 100);
    assert.equal(latest.maturity.milestones.every((item) => item.validated), true);
  });
});

test('confirmed diagnosis credits existing evidence atomically and corrections recalculate', async () => {
  await withStore(async (store) => {
    const base = { ownerId: 'founder_a', projectId: 'build' };
    assert.throws(() => store.diagnoseProject({ ...base, confirmed: false, assessments: [] }), /founder must confirm/);
    await assert.rejects(store.diagnoseProject({ ...base, confirmed: true, assessments: [
      { milestoneId: 'target_problem', evidence: realEvidence(), source: manual, outcome: 'met' },
      { milestoneId: 'value_proposition', evidence: { ...realEvidence(), real: false }, source: manual, outcome: 'met' },
    ] }), /real-world evidence/);
    assert.equal((await store.getSnapshot(base)).maturity.percent, 0);
    const diagnosed = await store.diagnoseProject({ ...base, confirmed: true, assessments: [
      { milestoneId: 'target_problem', evidence: realEvidence(), source: manual, outcome: 'met' },
      { milestoneId: 'value_proposition', evidence: realEvidence(), source: manual, outcome: 'met' },
    ] });
    assert.equal(diagnosed.maturity.percent, 10);
    assert.equal(diagnosed.history[0].origin, 'diagnosis');
    const corrected = await store.revokeMilestone({ ...base, milestoneId: 'target_problem',
      reason: 'The target audience changed and this evidence no longer applies.' });
    assert.equal(corrected.transition.gain, -5);
    assert.equal(corrected.maturity.percent, 5);
    assert.equal(corrected.history.at(-1).type, 'revoked');
  });
});

test('account deletion removes only that owner and persists after restart', async () => {
  await withStore(async (store, dataDir) => {
    for (const ownerId of ['founder_a', 'founder_b']) {
      await store.validateMilestone({ ownerId, projectId: 'build', milestoneId: 'target_problem',
        evidence: realEvidence(), source: manual, outcome: 'met' });
    }
    assert.deepEqual(await store.deleteOwner('founder_a'), { deletedProjects: 1 });
    const restarted = createMaturityStore({ dataDir });
    assert.equal((await restarted.getSnapshot({ ownerId: 'founder_a', projectId: 'build' })).maturity.percent, 0);
    assert.equal((await restarted.getSnapshot({ ownerId: 'founder_b', projectId: 'build' })).maturity.percent, 5);
  });
});

test('guided mission answers persist, can be revised, and only confirmed answers earn credit', async () => {
  await withStore(async (store, dataDir) => {
    const base = { ownerId: 'founder_a', projectId: 'build', milestoneId: 'target_problem' };
    const initial = await store.getSnapshot(base);
    assert.deepEqual(initial.nextMission.draft, {
      answers: ['', '', ''], reviewed: [false, false, false], answeredCount: 0, totalSteps: 3, complete: false,
    });
    assert.equal(initial.nextMission.questions.length, 3);
    assert.throws(() => store.saveGuidedAnswer({ ...base, stepIndex: 0, answer: 'x' }), /more specific/);
    await store.saveGuidedAnswer({ ...base, stepIndex: 0, answer: 'Independent founders', reviewed: true });
    await store.saveGuidedAnswer({ ...base, stepIndex: 1, reviewed: true,
      answer: 'They struggle to identify their first customer interview.' });
    const edited = await store.saveGuidedAnswer({ ...base, stepIndex: 0, answer: 'First-time founders', reviewed: true });
    assert.deepEqual(edited.nextMission.draft.answers, [
      'First-time founders', 'They struggle to identify their first customer interview.', '',
    ]);
    assert.equal(edited.maturity.percent, 0);
    await assert.rejects(store.completeGuidedMission({ ...base, confirmed: true }), /Answer every mission question/);
    const restarted = createMaturityStore({ dataDir });
    const resumed = await restarted.getSnapshot(base);
    assert.equal(resumed.nextMission.draft.answeredCount, 2);
    assert.equal((await restarted.getSnapshot({ ownerId: 'founder_b', projectId: 'build' }))
      .nextMission.draft.answeredCount, 0);
    await restarted.saveGuidedAnswer({ ...base, stepIndex: 2, reviewed: true,
      answer: 'Founder hypothesis based on notes from three exploratory calls.' });
    assert.throws(() => restarted.completeGuidedMission({ ...base, confirmed: false }), /Confirm/);
    const completed = await restarted.completeGuidedMission({ ...base, confirmed: true, requestId: 'guided-first' });
    assert.equal(completed.transition.gain, 5);
    assert.equal(completed.maturity.percent, 5);
    assert.match(completed.maturity.milestones[0].evidence.summary, /First-time founders/);
    assert.match(completed.maturity.milestones[0].evidence.summary, /founder/i);
    assert.equal((await restarted.completeGuidedMission({ ...base, confirmed: true,
      requestId: 'guided-first' })).transition.gain, 0);
    await assert.rejects(restarted.saveGuidedAnswer({ ...base, stepIndex: 1,
      answer: 'A new problem after credit' }), /already completed/);
  });
});

test('every mission turn is analyzed before an exact founder answer is saved', async () => {
  await withStore(async (store) => {
    const project = { ownerId: 'founder_a', projectId: 'build' };
    const messages = [];
    const provider = { async generateStructured({ prompt, validate }) {
      messages.push(prompt);
      return { data: validate({ outcome: 'saved', reply: 'Founders are your stated audience; the segment is still broad.' }),
        provider: 'test' };
    } };
    const answer = '  founders  ';
    const result = await analyzeMissionTurn({ provider, maturityStore: store, project,
      milestoneId: 'target_problem', stepIndex: 0, message: answer });
    assert.equal(result.outcome, 'saved');
    assert.equal(result.snapshot.nextMission.draft.answers[0], answer);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Which specific customer segment/);
    assert.match(messages[0], /founders/);

    const revision = await analyzeMissionTurn({ provider, maturityStore: store, project,
      milestoneId: 'target_problem', stepIndex: 0, message: 'First-time software founders' });
    assert.equal(revision.snapshot.nextMission.draft.answers[0], 'First-time software founders');
    assert.equal(messages.length, 2, 'answer revisions also require a new analysis');
  });
});

test('help, insufficient replies, invalid model output, and AI outage never save mission answers', async () => {
  await withStore(async (store) => {
    const project = { ownerId: 'founder_a', projectId: 'build' };
    let calls = 0;
    let lastPrompt = '';
    const mistakenProvider = { async generateStructured({ prompt, validate }) {
      calls += 1;
      lastPrompt = prompt;
      return { data: validate({ outcome: 'saved', reply: 'Saved.' }) };
    } };
    const help = await analyzeMissionTurn({ provider: mistakenProvider, maturityStore: store,
      project, milestoneId: 'target_problem', stepIndex: 2, message: 'help me find this' });
    assert.equal(help.outcome, 'continue');
    assert.equal(help.snapshot.nextMission.draft.answeredCount, 0);
    assert.equal(calls, 1, 'even a clear help request goes through AI analysis');

    const referential = await analyzeMissionTurn({ provider: mistakenProvider, maturityStore: store,
      project, milestoneId: 'target_problem', stepIndex: 0, message: 'the second one',
      history: [{ input: 'Can you suggest two segments?', reply: 'One is solo founders; another is venture-backed founders.' }] });
    assert.equal(referential.outcome, 'continue');
    assert.equal(referential.snapshot.nextMission.draft.answers[0], '');
    assert.equal(calls, 2, 'a referential response must still be analyzed');
    assert.match(lastPrompt, /Can you suggest two segments/);

    const clarifyingProvider = { async generateStructured({ validate }) {
      calls += 1;
      return { data: validate({ outcome: 'continue', reply: 'Which kind of founder do you mean?' }) };
    } };
    const vague = await analyzeMissionTurn({ provider: clarifyingProvider, maturityStore: store,
      project, milestoneId: 'target_problem', stepIndex: 0, message: 'founders' });
    assert.equal(vague.outcome, 'continue');
    assert.equal(vague.reply, 'Which kind of founder do you mean?');
    assert.equal(vague.snapshot.nextMission.draft.answers[0], '');

    const failedProvider = { async generateStructured() {
      calls += 1;
      throw Object.assign(new Error('Provider unavailable'), { status: 503 });
    } };
    await assert.rejects(analyzeMissionTurn({ provider: failedProvider, maturityStore: store,
      project, milestoneId: 'target_problem', stepIndex: 0, message: 'First-time founders' }), /Provider unavailable/);
    assert.throws(() => normalizeMissionTurnDecision({ outcome: 'saved', reply: '' }), /Invalid mission reply/);
    assert.throws(() => normalizeMissionTurnHistory(Array.from({ length: 5 }, () => ({ input: 'a', reply: 'b' }))),
      /at most four/);
    assert.equal((await store.getSnapshot(project)).nextMission.draft.answeredCount, 0);
    assert.equal(calls, 4);
  });
});

test('legacy answers stay visible but require AI review, and a help request cannot count', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'build-maturity-help-draft-'));
  try {
    await writeFile(join(dataDir, 'maturity.json'), JSON.stringify({ version: 1, projects: [{
      id: 'build', ownerId: 'founder_a', name: 'My project', summary: '', roadmapVersion: 1,
      credits: [], criteria: {}, history: [], drafts: { target_problem: { answers: [
        'founders', 'lack of contacts than founders can have to join vc', 'help me find this',
      ], updatedAt: new Date().toISOString() } },
    }] }));
    const store = createMaturityStore({ dataDir });
    const project = { ownerId: 'founder_a', projectId: 'build', milestoneId: 'target_problem' };
    const snapshot = await store.getSnapshot(project);
    assert.deepEqual(snapshot.nextMission.draft.answers,
      ['founders', 'lack of contacts than founders can have to join vc', '']);
    assert.deepEqual(snapshot.nextMission.draft.reviewed, [false, false, false]);
    assert.equal(snapshot.nextMission.draft.answeredCount, 0);
    await assert.rejects(store.completeGuidedMission({ ...project, confirmed: true }), /Answer every mission question/);

    const prompts = [];
    const provider = { async generateStructured({ prompt, validate }) {
      prompts.push(prompt);
      return { data: validate({ outcome: 'saved', reply: 'I have reviewed that statement.' }) };
    } };
    const reviewedFirst = await analyzeMissionTurn({ provider, maturityStore: store, project,
      milestoneId: 'target_problem', stepIndex: 0, message: 'founders' });
    assert.deepEqual(reviewedFirst.snapshot.nextMission.draft.reviewed, [true, false, false]);
    assert.equal(reviewedFirst.snapshot.nextMission.draft.answeredCount, 1);
    assert.equal(prompts[0].includes('lack of contacts than founders can have to join vc'), false,
      'unreviewed legacy answers must not guide Lia’s next decision');
    const reviewedSecond = await analyzeMissionTurn({ provider, maturityStore: store, project,
      milestoneId: 'target_problem', stepIndex: 1, message: 'lack of contacts than founders can have to join vc' });
    assert.deepEqual(reviewedSecond.snapshot.nextMission.draft.reviewed, [true, true, false]);
    assert.equal(reviewedSecond.snapshot.nextMission.draft.answeredCount, 2);
    await assert.rejects(store.completeGuidedMission({ ...project, confirmed: true }), /Answer every mission question/);
    const reviewedThird = await analyzeMissionTurn({ provider, maturityStore: store, project,
      milestoneId: 'target_problem', stepIndex: 2,
      message: 'This is my hypothesis based on my own experience; I have no interview evidence yet.' });
    assert.deepEqual(reviewedThird.snapshot.nextMission.draft.reviewed, [true, true, true]);
    assert.equal(reviewedThird.snapshot.nextMission.draft.complete, true);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('guided observation needs substantive answers and metric needs a fixed criterion and passing result', async () => {
  await withStore(async (store) => {
    const owner = { ownerId: 'founder_a', projectId: 'build' };
    const observed = { ...owner, milestoneId: 'field_observations' };
    await store.saveGuidedAnswer({ ...observed, stepIndex: 0, answer: 'Three target founders', reviewed: true });
    assert.throws(() => store.saveGuidedAnswer({ ...observed, stepIndex: 1, answer: 'Nothing' }), /more specific/);
    await store.saveGuidedAnswer({ ...observed, stepIndex: 1, reviewed: true,
      answer: 'Two said the first interview felt too hard to arrange.' });
    await store.saveGuidedAnswer({ ...observed, stepIndex: 2, reviewed: true,
      answer: 'Notes from our three interview calls, held by the founder.' });
    const observation = await store.completeGuidedMission({ ...observed, confirmed: true });
    assert.equal(observation.transition.gain, 10);
    assert.match(observation.maturity.milestones.find((item) => item.id === 'field_observations')
      .evidence.summary, /Two said/);

    const metric = { ...owner, milestoneId: 'problem_priority' };
    const answers = ['At least 3 out of 5 founders rate this as urgent.',
      'We interviewed five founders and recorded each priority score.',
      'Four founders rated it urgent in the interview notes.'];
    await store.saveGuidedAnswer({ ...metric, stepIndex: 0, answer: answers[0], reviewed: true });
    await assert.rejects(store.saveGuidedAnswer({ ...metric, stepIndex: 1, answer: answers[1] }),
      /Fix the numeric criterion/);
    const criterion = { comparison: 'at_least', threshold: 3, unit: 'founders' };
    await store.setCriterion({ ...metric, criterion });
    for (let stepIndex = 1; stepIndex < answers.length; stepIndex += 1) {
      await store.saveGuidedAnswer({ ...metric, stepIndex, answer: answers[stepIndex], reviewed: true });
    }
    await assert.rejects(store.completeGuidedMission({ ...metric, confirmed: true }), /observed numeric result/);
    await assert.rejects(store.completeGuidedMission({ ...metric, confirmed: true, observed: 2 }), /does not meet/);
    const passed = await store.completeGuidedMission({ ...metric, confirmed: true, observed: 4 });
    assert.equal(passed.transition.gain, 10);
    assert.deepEqual(passed.maturity.milestones.find((item) => item.id === 'problem_priority')
      .evidence.metric, { ...criterion, observed: 4, provenance: 'fixed_before_validation' });
  });
});

test('guided interest test does not award credit without linked reviewed experiment evidence', async () => {
  await withStore(async (store) => {
    const base = { ownerId: 'founder_a', projectId: 'build', milestoneId: 'interest_test' };
    for (const [stepIndex, answer] of [
      'We asked founders if they would try the proposition.',
      'Five founders answered the public interest question.',
      'Two showed interest; the founder will revise the message.',
    ].entries()) await store.saveGuidedAnswer({ ...base, stepIndex, answer, reviewed: true });
    await assert.rejects(store.completeGuidedMission({ ...base, confirmed: true }), /Run and analyze/);
    assert.equal((await store.getSnapshot(base)).maturity.percent, 0);
  });
});

test('a criterion cannot be backdated after an older draft already records observations', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'build-maturity-legacy-draft-'));
  try {
    await writeFile(join(dataDir, 'maturity.json'), JSON.stringify({ version: 1, projects: [{
      id: 'build', ownerId: 'founder_a', name: 'My project', summary: '', roadmapVersion: 1,
      credits: [], criteria: {}, history: [], drafts: {
        problem_priority: { answers: [
          'At least three founders report this as urgent.',
          'Five real founders gave us their priority ratings.',
          'Four called it urgent in the recorded interview notes.',
        ], updatedAt: new Date().toISOString() },
      },
    }] }));
    const store = createMaturityStore({ dataDir });
    await assert.rejects(store.setCriterion({ ownerId: 'founder_a', projectId: 'build',
      milestoneId: 'problem_priority', criterion: { comparison: 'at_least', threshold: 3, unit: 'founders' } }),
    /already has recorded observations/);
    assert.equal((await store.getSnapshot({ ownerId: 'founder_a', projectId: 'build' })).maturity.percent, 0);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
