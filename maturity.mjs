import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROADMAP_VERSION = 1;

const DIMENSIONS = Object.freeze([
  { id: 'customer_need', label: 'Customer need' },
  { id: 'demand', label: 'Demand' },
  { id: 'solution', label: 'Solution' },
  { id: 'pilot_viability', label: 'Pilot viability' },
]);

// The fixed weights add to 100. A new rubric needs a new roadmap version and
// an explicit migration; changing these weights in place would rewrite history.
export const MILESTONES = Object.freeze([
  { id: 'target_problem', dimension: 'customer_need', weight: 5,
    title: 'Define the customer and problem', description: 'Name the customer segment and the problem they face.',
    criterion: 'A specific customer segment and problem are documented.',
    steps: ['Describe one customer segment.', 'State the problem in their words.', 'Save the source or reasoning.'] },
  { id: 'field_observations', dimension: 'customer_need', weight: 10,
    title: 'Collect field observations', description: 'Document what you heard or observed from real people.',
    criterion: 'Real observations and their source are documented.',
    steps: ['Talk to or observe the target audience.', 'Record what happened.', 'Document the source and learning.'], learning: true },
  { id: 'problem_priority', dimension: 'customer_need', weight: 10,
    title: 'Establish problem priority', description: 'Check whether the problem matters enough to your target audience.',
    criterion: 'A predeclared priority threshold is met by the observed result.',
    steps: ['Set a measurable priority threshold.', 'Collect the observations.', 'Compare the result with the threshold.'], metric: true },
  { id: 'value_proposition', dimension: 'demand', weight: 5,
    title: 'Define the value proposition', description: 'Describe the change your product promises to the customer.',
    criterion: 'The proposed value and target audience are documented.',
    steps: ['Write the promise in one sentence.', 'Name the audience.', 'Save the version tested.'] },
  { id: 'interest_test', dimension: 'demand', weight: 5,
    title: 'Run an interest test', description: 'Put your proposition in front of real people and analyze the answers.',
    criterion: 'A real interest test has been run and analyzed, including a negative result.',
    steps: ['Prepare a test with a clear question.', 'Collect real responses.', 'Record the result and what it changes.'], learning: true },
  { id: 'engagement_signal', dimension: 'demand', weight: 15,
    title: 'Reach an engagement signal', description: 'Measure a concrete commitment rather than a statement of interest.',
    criterion: 'A predeclared engagement threshold is met by the observed result.',
    steps: ['Define a concrete commitment.', 'Set the threshold before testing.', 'Record the observed commitment.'], metric: true },
  { id: 'prototype_scope', dimension: 'solution', weight: 5,
    title: 'Define the prototype scope', description: 'Choose the essential task the prototype must enable.',
    criterion: 'The prototype and its essential task are documented.',
    steps: ['Pick one essential task.', 'Describe the prototype boundaries.', 'Save the scope.'] },
  { id: 'usability_test', dimension: 'solution', weight: 10,
    title: 'Run a usability test', description: 'Watch someone attempt the essential task and document what happened.',
    criterion: 'A real usability test and its findings are documented, even if the task failed.',
    steps: ['Ask a real person to try the task.', 'Observe without guiding.', 'Document success, friction, and learning.'], learning: true },
  { id: 'essential_task_success', dimension: 'solution', weight: 10,
    title: 'Prove the essential task works', description: 'Show the target audience can complete the essential task.',
    criterion: 'A predeclared task-success threshold is met by the observed result.',
    steps: ['Set the success threshold.', 'Run the task with real users.', 'Compare the observed rate.'], metric: true },
  { id: 'price_and_costs', dimension: 'pilot_viability', weight: 10,
    title: 'State price and costs', description: 'Make the proposed price and major pilot costs explicit.',
    criterion: 'A proposed price and the main cost assumptions are documented.',
    steps: ['State the proposed price.', 'List the main costs.', 'Record assumptions and sources.'] },
  { id: 'delivery_capacity', dimension: 'pilot_viability', weight: 5,
    title: 'Measure delivery capacity', description: 'Estimate the time or cost required to deliver one pilot.',
    criterion: 'A real or sourced capacity/cost measurement is documented.',
    steps: ['Choose one delivery unit.', 'Measure time, capacity, or cost.', 'Record the method and result.'], learning: true },
  { id: 'pilot_ready', dimension: 'pilot_viability', weight: 10,
    title: 'Prepare the first pilot', description: 'Define the budget, owner, delivery plan, and success checks.',
    criterion: 'Pilot budget, owner, feasible delivery plan, and follow-up criteria are documented.',
    steps: ['Assign the pilot owner.', 'Set a feasible budget and plan.', 'Define success and follow-up checks.'] },
].map((item) => Object.freeze({ ...item, steps: Object.freeze(item.steps) })));

const MILESTONE_BY_ID = new Map(MILESTONES.map((item) => [item.id, item]));
if (MILESTONES.reduce((sum, item) => sum + item.weight, 0) !== 100 ||
    DIMENSIONS.some((dimension) => MILESTONES.filter((item) => item.dimension === dimension.id)
      .reduce((sum, item) => sum + item.weight, 0) !== 25)) {
  throw new Error('Maturity rubric must total 100 points, 25 per dimension.');
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function identifier(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 120 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(value)) throw fail(400, `Invalid ${label}.`);
  return value;
}

function optionalText(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw fail(400, `Invalid ${label}.`);
  return value.trim();
}

function normalizeCriterion(criterion) {
  const comparison = criterion?.comparison;
  const threshold = criterion?.threshold;
  if (!['at_least', 'more_than', 'at_most'].includes(comparison) ||
      typeof threshold !== 'number' || !Number.isFinite(threshold)) {
    throw fail(400, 'Set a numeric criterion before this mission.');
  }
  const unit = optionalText(criterion.unit, 60, 'metric unit');
  if (!unit) throw fail(400, 'Name the unit being measured.');
  return { comparison, threshold, unit };
}

function normalizeEvidence(evidence, source, outcome, milestone, preparedCriterion, origin) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || evidence.real !== true) {
    throw fail(400, 'Only documented real-world evidence can advance a project.');
  }
  const summary = optionalText(evidence.summary, 3000, 'evidence summary');
  if (summary.length < 30) throw fail(400, 'Describe the observed evidence in at least 30 characters.');
  const reference = optionalText(evidence.reference, 500, 'evidence reference');
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
      !['manual', 'experiment', 'import'].includes(source.kind)) throw fail(400, 'Choose an evidence source.');
  const sourceReference = optionalText(source.reference, 500, 'source reference');
  if (source.kind !== 'manual' && !sourceReference) throw fail(400, 'Linked evidence needs a source reference.');
  if (!['met', 'learned'].includes(outcome)) throw fail(400, 'Choose a valid mission outcome.');
  if (outcome === 'learned' && !milestone.learning) {
    throw fail(409, 'This readiness milestone needs its stated criterion to be met.');
  }

  let metric = null;
  if (milestone.metric) {
    if (outcome !== 'met') throw fail(409, 'The measured result must meet the predeclared threshold.');
    if (!preparedCriterion && origin !== 'diagnosis') {
      throw fail(409, 'Set the criterion before validating this mission.');
    }
    const suppliedCriterion = normalizeCriterion(evidence.criterion);
    const criterion = preparedCriterion || suppliedCriterion;
    if (preparedCriterion && JSON.stringify(suppliedCriterion) !== JSON.stringify(preparedCriterion)) {
      throw fail(409, 'The result must use the criterion fixed before this mission.');
    }
    const { comparison, threshold, unit } = criterion;
    const observed = evidence.observed;
    if (typeof observed !== 'number' || !Number.isFinite(observed)) throw fail(400, 'Include the observed numeric result.');
    const passed = comparison === 'at_least' ? observed >= threshold
      : comparison === 'more_than' ? observed > threshold : observed <= threshold;
    if (!passed) throw fail(409, 'The observed result does not meet the criterion.');
    metric = { comparison, threshold, observed, unit,
      provenance: preparedCriterion ? 'fixed_before_validation' : 'founder_confirmed_diagnosis' };
  }
  return {
    evidence: { summary, reference, real: true, metric },
    source: { kind: source.kind, reference: sourceReference },
    outcome,
  };
}

function projectKey(ownerId, projectId) { return `${ownerId}\u0000${projectId}`; }

function score(project) {
  const active = new Set(project?.credits?.filter((item) => !item.revokedAt).map((item) => item.milestoneId) || []);
  return MILESTONES.reduce((total, item) => total + (active.has(item.id) ? item.weight : 0), 0);
}

function snapshot(project, ownerId, projectId, projectName = '', projectSummary = '') {
  const credits = new Map(project?.credits?.filter((item) => !item.revokedAt)
    .map((item) => [item.milestoneId, item]) || []);
  const milestones = MILESTONES.map((item) => {
    const credit = credits.get(item.id);
    return {
      id: item.id, dimension: item.dimension, dimensionId: item.dimension,
      title: item.title, description: item.description,
      weight: item.weight, criterion: item.criterion, steps: [...item.steps],
      status: credit ? 'validated' : 'pending', validated: Boolean(credit),
      plannedCriterion: project?.criteria?.[item.id] || null,
      evidence: credit ? structuredClone(credit.evidence) : null,
      source: credit ? structuredClone(credit.source) : null,
      outcome: credit?.outcome || null, validatedAt: credit?.validatedAt || null,
      provenance: credit?.origin || null,
    };
  });
  const percent = score(project);
  const next = milestones.find((item) => item.status === 'pending');
  return {
    project: {
      id: projectId, ownerId,
      name: projectName || project?.name || 'My project',
      summary: projectSummary || project?.summary || '', roadmapVersion: ROADMAP_VERSION,
    },
    maturity: {
      percent, status: percent === 100 ? 'mature' : 'in_progress',
      label: percent === 100 ? 'Project at maturity' : 'Pilot maturity',
      scope: 'Readiness for the first defined pilot',
      dimensions: DIMENSIONS.map((dimension) => {
        const earned = milestones.filter((item) => item.dimension === dimension.id && item.status === 'validated')
          .reduce((total, item) => total + item.weight, 0);
        return { ...dimension, title: dimension.label, total: 25, earned, score: earned };
      }),
      milestones,
    },
    nextMission: next ? {
      id: next.id, milestoneId: next.id, gain: next.weight, title: next.title,
      description: next.description, status: 'available', steps: [...next.steps],
      criterion: next.criterion, cta: 'Start mission',
    } : {
      id: 'launch_pilot', milestoneId: null, gain: 0, title: 'Launch the pilot',
      description: 'The first pilot is ready to begin.', status: 'available',
      steps: [], criterion: 'Launch and follow up on the defined pilot.', cta: 'Launch pilot',
    },
    history: structuredClone(project?.history || []),
  };
}

export function createMaturityStore({ dataDir = process.env.LAB_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '.data') } = {}) {
  const path = join(dataDir, 'maturity.json');
  let store = { version: 1, projects: [] };
  let mutations = Promise.resolve();
  const ready = (async () => {
    try {
      const stat = await lstat(dataDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe maturity data directory.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
    }
    await chmod(dataDir, 0o700);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe maturity store.');
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      if (parsed?.version !== 1 || !Array.isArray(parsed.projects)) throw new Error('Invalid maturity store.');
      store = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  })();

  async function persist(nextStore) {
    const temp = join(dataDir, `.maturity-${randomUUID()}.tmp`);
    let file;
    try {
      file = await open(temp, 'wx', 0o600);
      await file.writeFile(JSON.stringify(nextStore), 'utf8');
      await file.sync();
      await file.close();
      file = null;
      await rename(temp, path);
    } catch (error) {
      if (file) await file.close().catch(() => {});
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  function mutate(operation) {
    const task = mutations.then(async () => {
      await ready;
      const draft = structuredClone(store);
      const result = operation(draft);
      if (result.changed) {
        await persist(draft);
        store = draft;
      }
      return result.value;
    });
    mutations = task.catch(() => {});
    return task;
  }

  function locate(current, ownerId, projectId) {
    const key = projectKey(ownerId, projectId);
    return current.projects.find((item) => projectKey(item.ownerId, item.id) === key);
  }

  function ensure(current, ownerId, projectId, projectName, projectSummary) {
    let project = locate(current, ownerId, projectId);
    if (!project) {
      if (current.projects.length >= 500) throw fail(429, 'Project limit reached.');
      project = { id: projectId, ownerId, name: projectName || 'My project',
        summary: projectSummary || '', roadmapVersion: ROADMAP_VERSION, credits: [],
        criteria: {}, history: [] };
      current.projects.push(project);
    }
    if (project.roadmapVersion !== ROADMAP_VERSION) throw fail(409, 'Project roadmap needs migration.');
    return project;
  }

  function credit(draft, input, origin = 'mission') {
    const ownerId = identifier(input.ownerId, 'owner ID');
    const projectId = identifier(input.projectId, 'project ID');
    const milestoneId = identifier(input.milestoneId, 'milestone ID');
    const milestone = MILESTONE_BY_ID.get(milestoneId);
    if (!milestone) throw fail(404, 'Unknown milestone.');
    const project = ensure(draft, ownerId, projectId,
      optionalText(input.projectName, 120, 'project name'),
      optionalText(input.projectSummary, 1000, 'project summary'));
    const requestId = input.requestId === undefined ? randomUUID() : identifier(input.requestId, 'request ID');
    const priorRequest = project.history.find((event) => event.requestId === requestId);
    if (priorRequest && priorRequest.milestoneId !== milestoneId) throw fail(409, 'Request ID already used.');
    if (priorRequest && priorRequest.milestoneId === milestoneId) {
      return { changed: false, value: { ...snapshot(project, ownerId, projectId),
        transition: { before: score(project), after: score(project), gain: 0, milestoneId, duplicate: true } } };
    }
    const existing = project.credits.find((item) => item.milestoneId === milestoneId && !item.revokedAt);
    if (existing) return { changed: false, value: {
      ...snapshot(project, ownerId, projectId),
      transition: { before: score(project), after: score(project), gain: 0, milestoneId, duplicate: true },
    } };
    const { evidence, source, outcome } = normalizeEvidence(input.evidence, input.source, input.outcome,
      milestone, project.criteria?.[milestoneId]?.criterion, origin);
    const before = score(project);
    const at = new Date().toISOString();
    const eventId = randomUUID();
    project.credits.push({ eventId, requestId, milestoneId, evidence, source, outcome,
      origin, validatedAt: at, revokedAt: null });
    const after = score(project);
    project.history.push({ id: eventId, requestId, type: 'validated', milestoneId, origin,
      at, before, after, gain: after - before, evidence: structuredClone(evidence),
      source: structuredClone(source), outcome });
    return { changed: true, value: {
      ...snapshot(project, ownerId, projectId),
      transition: { before, after, gain: after - before, milestoneId, duplicate: false },
    } };
  }

  return {
    async getSnapshot({ ownerId, projectId, projectName, projectSummary }) {
      ownerId = identifier(ownerId, 'owner ID');
      projectId = identifier(projectId, 'project ID');
      await ready;
      await mutations;
      return snapshot(locate(store, ownerId, projectId), ownerId, projectId,
        optionalText(projectName, 120, 'project name'), optionalText(projectSummary, 1000, 'project summary'));
    },
    setCriterion({ ownerId, projectId, milestoneId, criterion, projectName, projectSummary }) {
      ownerId = identifier(ownerId, 'owner ID');
      projectId = identifier(projectId, 'project ID');
      milestoneId = identifier(milestoneId, 'milestone ID');
      if (!MILESTONE_BY_ID.get(milestoneId)?.metric) throw fail(400, 'This milestone does not use a numeric criterion.');
      const normalized = normalizeCriterion(criterion);
      return mutate((draft) => {
        const project = ensure(draft, ownerId, projectId,
          optionalText(projectName, 120, 'project name'),
          optionalText(projectSummary, 1000, 'project summary'));
        project.criteria ||= {};
        const previous = project.criteria[milestoneId];
        if (previous) {
          if (JSON.stringify(previous.criterion) !== JSON.stringify(normalized)) {
            throw fail(409, 'A criterion is already fixed for this milestone.');
          }
          return { changed: false, value: snapshot(project, ownerId, projectId) };
        }
        if (project.credits.some((item) => item.milestoneId === milestoneId && !item.revokedAt)) {
          throw fail(409, 'This milestone is already validated.');
        }
        const at = new Date().toISOString();
        project.criteria[milestoneId] = { criterion: normalized, preparedAt: at };
        project.history.push({ id: randomUUID(), type: 'criterion_fixed', milestoneId, at,
          criterion: structuredClone(normalized) });
        return { changed: true, value: snapshot(project, ownerId, projectId) };
      });
    },
    validateMilestone(input) { return mutate((draft) => credit(draft, input)); },
    diagnoseProject({ ownerId, projectId, assessments, confirmed, projectName, projectSummary }) {
      if (confirmed !== true) throw fail(400, 'The founder must confirm the initial diagnosis.');
      if (!Array.isArray(assessments) || assessments.length < 1 || assessments.length > MILESTONES.length) {
        throw fail(400, 'Choose documented milestones for the diagnosis.');
      }
      return mutate((draft) => {
        let changed = false;
        let result;
        for (const item of assessments) {
          result = credit(draft, { ...item, ownerId, projectId, projectName, projectSummary }, 'diagnosis');
          changed ||= result.changed;
        }
        return { changed, value: result.value };
      });
    },
    revokeMilestone({ ownerId, projectId, milestoneId, reason }) {
      ownerId = identifier(ownerId, 'owner ID');
      projectId = identifier(projectId, 'project ID');
      milestoneId = identifier(milestoneId, 'milestone ID');
      reason = optionalText(reason, 1000, 'correction reason');
      if (reason.length < 20) throw fail(400, 'Explain why the evidence no longer applies.');
      return mutate((draft) => {
        const project = locate(draft, ownerId, projectId);
        const active = project?.credits.find((item) => item.milestoneId === milestoneId && !item.revokedAt);
        if (!active) throw fail(404, 'No active credit for this milestone.');
        const before = score(project);
        const at = new Date().toISOString();
        active.revokedAt = at;
        const after = score(project);
        project.history.push({ id: randomUUID(), type: 'revoked', milestoneId, at, before, after,
          gain: after - before, reason, creditEventId: active.eventId });
        return { changed: true, value: { ...snapshot(project, ownerId, projectId),
          transition: { before, after, gain: after - before, milestoneId, correction: true } } };
      });
    },
    deleteOwner(ownerId) {
      ownerId = identifier(ownerId, 'owner ID');
      return mutate((draft) => {
        const before = draft.projects.length;
        draft.projects = draft.projects.filter((project) => project.ownerId !== ownerId);
        const deletedProjects = before - draft.projects.length;
        return { changed: deletedProjects > 0, value: { deletedProjects } };
      });
    },
  };
}
