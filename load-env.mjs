import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Preview launchers may run `node server.mjs` instead of the npm start script.
// Load local secrets before application modules initialize their data paths.
const file = join(dirname(fileURLToPath(import.meta.url)), '.env');
if (process.env.BUEELD_SKIP_LOCAL_ENV !== '1' && existsSync(file)) process.loadEnvFile(file);
