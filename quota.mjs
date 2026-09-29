import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = process.env.LAB_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '.data');
const filePath = join(directory, 'demo-usage.json');
let used = 0;
let byUser = {};
let writes = Promise.resolve();

try {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe Lab data directory');
} catch (cause) {
  if (cause.code !== 'ENOENT') throw cause;
  await mkdir(directory, { recursive: true, mode: 0o700 });
}
await chmod(directory, 0o700);
try {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe demo usage store');
  const value = JSON.parse(await readFile(filePath, 'utf8'));
  if (value?.version !== 1 || !Number.isSafeInteger(value.used) || value.used < 0) throw new Error('Invalid demo usage store');
  used = value.used;
  if (value.byUser && typeof value.byUser === 'object' && !Array.isArray(value.byUser)) byUser = value.byUser;
} catch (cause) {
  if (cause.code !== 'ENOENT') throw cause;
}

async function writeUsage() {
  const temporary = join(directory, `.demo-usage-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify({ version: 1, used, byUser }), 'utf8');
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, filePath);
  } catch (cause) {
    if (file) await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw cause;
  }
}
export function aiCallsUsed() { return used; }
export function forgetAiUser(userId) {
  const task = writes.then(async () => {
    if (!Object.hasOwn(byUser, userId)) return;
    const before = byUser[userId];
    delete byUser[userId];
    try { await writeUsage(); }
    catch (error) { byUser[userId] = before; throw error; }
  });
  writes = task.catch(() => {});
  return task;
}
export function reserveAiCall(limit, userId = null, userLimit = 20) {
  const task = writes.then(async () => {
    if (!Number.isSafeInteger(limit) || limit < 0 || used >= limit) {
      throw Object.assign(new Error('The demo has reached its AI call limit.'), { status: 429 });
    }
    const now = Date.now();
    const previous = userId && byUser[userId];
    const current = previous?.resetAt > now ? previous : { used: 0, resetAt: now + 86_400_000 };
    if (userId && current.used >= userLimit) {
      throw Object.assign(new Error('Your daily AI call limit has been reached.'), { status: 429 });
    }
    const beforeUser = userId ? byUser[userId] : null;
    used += 1;
    if (userId) byUser[userId] = { ...current, used: current.used + 1 };
    try { await writeUsage(); }
    catch {
      used -= 1;
      if (userId) {
        if (beforeUser) byUser[userId] = beforeUser;
        else delete byUser[userId];
      }
      throw Object.assign(new Error('Demo call accounting is unavailable.'), { status: 503 });
    }
    return used;
  });
  writes = task.catch(() => {});
  return task;
}
