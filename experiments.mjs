import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

function fail(status, message) { return Object.assign(new Error(message), { status }); }
function string(value, max, label, minimum = 1) {
  if (typeof value !== 'string') throw fail(400, `${label} is required.`);
  const result = value.trim();
  if (result.length < minimum || result.length > max) throw fail(400, `${label} must contain ${minimum}–${max} characters.`);
  return result;
}
function fields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'Provide the experiment fields.');
  const options = input.options;
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) throw fail(400, 'Provide two to four answer options.');
  const normalizedOptions = options.map((option) => string(option, 90, 'Answer option'));
  if (new Set(normalizedOptions.map((option) => option.toLowerCase())).size !== normalizedOptions.length) throw fail(400, 'Answer options must be distinct.');
  const successOption = string(input.successOption, 90, 'Success option');
  if (!normalizedOptions.includes(successOption)) throw fail(400, 'The success option must match an answer option.');
  const minimumResponses = Number(input.minimumResponses);
  const thresholdPercent = Number(input.thresholdPercent);
  if (!Number.isInteger(minimumResponses) || minimumResponses < 1 || minimumResponses > 100) throw fail(400, 'Minimum responses must be between 1 and 100.');
  if (!Number.isInteger(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 100) throw fail(400, 'Threshold must be between 1 and 100 percent.');
  return {
    title: string(input.title, 120, 'Title'),
    hypothesis: string(input.hypothesis, 500, 'Hypothesis'),
    audience: string(input.audience, 220, 'Audience'),
    question: string(input.question, 220, 'Question'),
    options: normalizedOptions,
    successOption,
    minimumResponses,
    thresholdPercent,
  };
}
function ownerExperiment(item) {
  const { ownerId, projectId, responses, ...rest } = item;
  return { ...rest, responseCount: responses.length, publicUrl: item.publicId ? `/e/${item.publicId}` : null };
}
function publicExperiment(item) {
  return { title: item.title, audience: item.audience, question: item.question,
    options: item.options, status: item.status };
}
function computeStats(item) {
  const responseIds = item.closedResponseIds || item.responses.map((response) => response.id);
  const eligible = new Set(responseIds);
  const responses = item.responses.filter((response) => eligible.has(response.id));
  const qualified = responses.filter((response) => response.qualified);
  const matching = qualified.filter((response) => response.choice === item.successOption);
  const percentage = qualified.length ? Math.round(matching.length * 10_000 / qualified.length) / 100 : null;
  const enoughResponses = qualified.length >= item.minimumResponses;
  return { responses: responses.length, qualified: qualified.length, matching: matching.length,
    percentage, minimumResponses: item.minimumResponses, thresholdPercent: item.thresholdPercent,
    enoughResponses, metThreshold: enoughResponses && percentage >= item.thresholdPercent,
    version: item.version };
}

export function createExperimentStore({ dataDir }) {
  if (!dataDir) throw new Error('A private data directory is required.');
  const filePath = join(dataDir, 'experiments.json');
  let state = { version: 1, experiments: [] };
  let writes = Promise.resolve();
  const initialized = (async () => {
    try {
      const info = await lstat(dataDir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe experiment directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
    }
    await chmod(dataDir, 0o700);
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe experiment store');
      const parsed = JSON.parse(await readFile(filePath, 'utf8'));
      if (parsed?.version !== 1 || !Array.isArray(parsed.experiments)) throw new Error('Invalid experiment store');
      state = parsed;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  })();
  async function save(next) {
    const temp = join(dataDir, `.experiments-${randomUUID()}.tmp`);
    let file;
    try {
      file = await open(temp, 'wx', 0o600);
      await file.writeFile(JSON.stringify(next));
      await file.sync();
      await file.close();
      file = null;
      await rename(temp, filePath);
      state = next;
    } finally {
      if (file) await file.close().catch(() => {});
      await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  function mutate(fn) {
    const task = writes.then(async () => {
      await initialized;
      const next = structuredClone(state);
      const result = fn(next);
      await save(next);
      return result;
    });
    writes = task.catch(() => {});
    return task;
  }
  async function read(fn) { await initialized; await writes; return fn(state); }
  function owned(next, id, ownerId, projectId) {
    const item = next.experiments.find((entry) => entry.id === id && entry.ownerId === ownerId && entry.projectId === projectId);
    if (!item) throw fail(404, 'Experiment not found.');
    return item;
  }
  function publicById(next, publicId) {
    const item = next.experiments.find((entry) => entry.publicId === publicId && entry.status !== 'draft');
    if (!item) throw fail(404, 'Experiment not found.');
    return item;
  }
  return {
    async list({ ownerId, projectId }) {
      return read((current) => current.experiments.filter((item) => item.ownerId === ownerId && item.projectId === projectId)
        .map(ownerExperiment).sort((a,b) => b.createdAt - a.createdAt));
    },
    async propose({ ownerId, projectId, missionId, ...input }) {
      const safe = fields(input);
      const mission = string(missionId, 100, 'Mission ID');
      return mutate((next) => {
        if (next.experiments.filter((item) => item.ownerId === ownerId).length >= 30) throw fail(429, 'Experiment limit reached.');
        const now = Date.now();
        const item = { id: randomUUID(), ownerId, projectId, missionId: mission, ...safe,
          version: 1, status: 'draft', publicId: null, responses: [], closedResponseIds: null,
          review: null, createdAt: now, updatedAt: now, publishedAt: null, closedAt: null };
        next.experiments.push(item);
        return ownerExperiment(item);
      });
    },
    async update({ ownerId, projectId, id, ...input }) {
      const safe = fields(input);
      return mutate((next) => {
        const item = owned(next, id, ownerId, projectId);
        if (item.status !== 'draft') throw fail(409, 'A published experiment cannot be edited.');
        Object.assign(item, safe, { updatedAt: Date.now() });
        return ownerExperiment(item);
      });
    },
    async publish({ ownerId, projectId, id }) {
      return mutate((next) => {
        const item = owned(next, id, ownerId, projectId);
        if (item.status === 'draft') {
          item.status = 'published';
          item.publicId = randomBytes(18).toString('base64url');
          item.publishedAt = item.updatedAt = Date.now();
        }
        return ownerExperiment(item);
      });
    },
    async getPublic(publicId) { return read((next) => publicExperiment(publicById(next, publicId))); },
    async submit({ publicId, qualified, choice, comment, submissionId }) {
      if (typeof qualified !== 'boolean') throw fail(400, 'Answer the audience question.');
      const safeChoice = string(choice, 90, 'Answer');
      const safeComment = typeof comment === 'string' ? comment.trim().slice(0, 500) : '';
      const safeSubmission = string(submissionId, 100, 'Submission ID');
      return mutate((next) => {
        const item = publicById(next, publicId);
        if (item.status !== 'published') throw fail(409, 'This experiment has closed.');
        if (!item.options.includes(safeChoice)) throw fail(400, 'Choose a listed answer.');
        const existing = item.responses.find((response) => response.submissionId === safeSubmission);
        if (existing) return { responseId: existing.id, accepted: true, duplicate: true };
        if (item.responses.length >= 500) throw fail(429, 'This experiment has reached its response limit.');
        const response = { id: randomUUID(), submissionId: safeSubmission, qualified,
          choice: safeChoice, comment: safeComment, createdAt: Date.now() };
        item.responses.push(response);
        item.updatedAt = Date.now();
        return { responseId: response.id, accepted: true, duplicate: false };
      });
    },
    async results({ ownerId, projectId, id }) {
      return read((next) => {
        const item = owned(next, id, ownerId, projectId);
        return { experiment: ownerExperiment(item), stats: computeStats(item),
          responses: item.responses.map(({ submissionId, ...response }) => response) };
      });
    },
    async close({ ownerId, projectId, id }) {
      return mutate((next) => {
        const item = owned(next, id, ownerId, projectId);
        if (item.status === 'draft') throw fail(409, 'Publish the experiment first.');
        if (item.status === 'published') {
          item.status = 'closed';
          item.closedResponseIds = item.responses.map((response) => response.id);
          item.closedAt = item.updatedAt = Date.now();
        }
        return { experiment: ownerExperiment(item), stats: computeStats(item),
          responses: item.responses.map(({ submissionId, ...response }) => response) };
      });
    },
    async reviewInput({ ownerId, projectId, id }) {
      return read((next) => {
        const item = owned(next, id, ownerId, projectId);
        if (item.status !== 'closed') throw fail(409, 'Close the experiment before its final review.');
        return { experiment: ownerExperiment(item), stats: computeStats(item),
          comments: item.responses.filter((response) => item.closedResponseIds.includes(response.id))
            .map((response) => response.comment).filter(Boolean).slice(0, 25) };
      });
    },
    async saveReview({ ownerId, projectId, id, review }) {
      return mutate((next) => {
        const item = owned(next, id, ownerId, projectId);
        if (item.status !== 'closed') throw fail(409, 'Close the experiment first.');
        if (!item.review) item.review = { ...review, reviewedAt: Date.now() };
        return { experiment: ownerExperiment(item), stats: computeStats(item), review: item.review };
      });
    },
    async evidenceFor({ ownerId, projectId, id }) {
      return read((next) => {
        const item = owned(next, id, ownerId, projectId);
        if (item.status !== 'closed') throw fail(409, 'Close the experiment first.');
        return { item: ownerExperiment(item), stats: computeStats(item) };
      });
    },
    async deleteOwner(ownerId) {
      return mutate((next) => { next.experiments = next.experiments.filter((item) => item.ownerId !== ownerId); return true; });
    },
  };
}
