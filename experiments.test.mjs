import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createExperimentStore } from './experiments.mjs';

const draft = {
  ownerId: 'owner-a', projectId: 'project-a', missionId: 'interest_test',
  title: 'Test a proposed founder workflow', hypothesis: 'Founders want a faster way to run customer tests.',
  audience: 'Independent founders', question: 'Would you try a guided test this week?',
  options: ['Yes', 'No'], successOption: 'Yes', minimumResponses: 2, thresholdPercent: 50,
};

test('a published experiment collects real responses, freezes results, and survives restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-experiment-'));
  try {
    const store = createExperimentStore({ dataDir: dir });
    const created = await store.propose(draft);
    assert.equal(created.status, 'draft');
    await assert.rejects(store.getPublic('nonexistent'), (error) => error.status === 404);
    const published = await store.publish({ ownerId: draft.ownerId, projectId: draft.projectId, id: created.id });
    assert.equal(published.status, 'published');
    const publicView = await store.getPublic(published.publicId);
    assert.deepEqual(publicView.options, ['Yes', 'No']);
    assert.equal('hypothesis' in publicView, false);
    const first = await store.submit({ publicId: published.publicId, qualified: true, choice: 'No',
      comment: 'I would need an example.', submissionId: randomUUID() });
    assert.equal(first.accepted, true);
    const secondId = randomUUID();
    await store.submit({ publicId: published.publicId, qualified: true, choice: 'Yes', submissionId: secondId });
    const duplicate = await store.submit({ publicId: published.publicId, qualified: true, choice: 'Yes', submissionId: secondId });
    assert.equal(duplicate.duplicate, true);
    const closed = await store.close({ ownerId: draft.ownerId, projectId: draft.projectId, id: created.id });
    assert.equal(closed.stats.responses, 2);
    assert.equal(closed.stats.percentage, 50);
    assert.equal(closed.stats.metThreshold, true);
    await assert.rejects(store.submit({ publicId: published.publicId, qualified: true, choice: 'Yes', submissionId: randomUUID() }),
      (error) => error.status === 409);
    const restarted = createExperimentStore({ dataDir: dir });
    const results = await restarted.results({ ownerId: draft.ownerId, projectId: draft.projectId, id: created.id });
    assert.equal(results.stats.responses, 2);
    assert.equal(results.experiment.status, 'closed');
    assert.equal(results.responses.some((response) => 'submissionId' in response), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('owner isolation, rejected edits, and negative result are enforced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'build-experiment-'));
  try {
    const store = createExperimentStore({ dataDir: dir });
    const created = await store.propose(draft);
    await assert.rejects(store.results({ ownerId: 'other-owner', projectId: draft.projectId, id: created.id }),
      (error) => error.status === 404);
    const published = await store.publish({ ownerId: draft.ownerId, projectId: draft.projectId, id: created.id });
    await assert.rejects(store.update({ ...draft, id: created.id }), (error) => error.status === 409);
    await assert.rejects(store.submit({ publicId: published.publicId, qualified: true, choice: 'Something else', submissionId: randomUUID() }),
      (error) => error.status === 400);
    await store.submit({ publicId: published.publicId, qualified: true, choice: 'No', submissionId: randomUUID() });
    const closed = await store.close({ ownerId: draft.ownerId, projectId: draft.projectId, id: created.id });
    assert.equal(closed.stats.enoughResponses, false);
    assert.equal(closed.stats.metThreshold, false);
    await assert.rejects(store.publish({ ownerId: 'other-owner', projectId: draft.projectId, id: created.id }),
      (error) => error.status === 404);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
