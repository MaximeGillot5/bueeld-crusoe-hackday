import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaturityStore, MILESTONES } from './maturity.mjs';

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
