import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, 'server/data'), { recursive: true, mode: 0o700 });
const target = path.join(root, '.env');
if (fs.existsSync(target)) {
  console.log('Existing .env preserved. Start with npm run dev:all.');
} else {
  fs.writeFileSync(target, [
    'SELF_HOSTED=true',
    'REMINDME_LOCAL_MODE=true',
    'DATABASE_PATH=./data/remindme.db',
    'PHOTO_STORAGE_PATH=./uploads',
    'CAPTURE_SCRATCH_PATH=./capture-scratch',
    `JWT_SECRET=${crypto.randomBytes(32).toString('hex')}`,
    'PORT=1453',
    'CORS_ORIGIN=http://localhost:5173',
    'AI_PROVIDER=openai-compatible',
    'AI_ENDPOINT_URL=http://localhost:4000/v1',
    'AI_API_KEY=',
    'AI_MODEL=home-vision',
    'CAPTURE_MAX_PHOTOS=20',
    '',
  ].join('\n'), { mode: 0o600, flag: 'wx' });
  console.log('Created private .env. Set the LiteLLM address, key and vision model, then npm run dev:all.');
}
