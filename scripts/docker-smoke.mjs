// Uses an isolated container and volumes. Never reads the owner's .env or data.
// Usage: node scripts/docker-smoke.mjs [image-tag]
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const image = process.argv[2] || 'remindme:local';
const name = `remindme-smoke-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const dataVolume = `${name}-data`;
const scratchVolume = `${name}-scratch`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let base;
let csrfCookie;
let csrfToken;

async function ready() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch { /* Container startup or restart in progress. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Container did not become healthy within 60 seconds');
}

async function session() {
  const response = await fetch(`${base}/api/auth/me`);
  assert.equal(response.status, 200);
  csrfCookie = response.headers.getSetCookie().find(value => value.startsWith('openbin-csrf='));
  assert(csrfCookie && !/;\s*Secure(?:;|$)/i.test(csrfCookie), 'LAN HTTP must receive a usable CSRF cookie');
  csrfCookie = csrfCookie.split(';')[0];
  csrfToken = csrfCookie.slice('openbin-csrf='.length);
  return response.json();
}

async function api(route, method = 'GET', body, extra = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      Cookie: csrfCookie, 'X-CSRF-Token': csrfToken,
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra,
    },
    body: Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  assert(response.ok, `${method} ${route}: HTTP ${response.status}`);
  return response.json();
}

try {
  docker('run', '-d', '--name', name, '--init', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:size=128m,mode=1777',
    '-p', '127.0.0.1::1453', '-v', `${dataVolume}:/data`, '-v', `${scratchVolume}:/scratch`,
    '-e', 'SELF_HOSTED=true', '-e', 'REMINDME_LOCAL_MODE=true', '-e', 'COOKIE_SECURE=false',
    '-e', 'DATABASE_URL=', '-e', `JWT_SECRET=${crypto.randomBytes(32).toString('hex')}`,
    '-e', 'ADMIN_EMAIL=docker-smoke@example.invalid', '-e', `ADMIN_PASSWORD=${crypto.randomBytes(24).toString('hex')}`,
    image);
  const mapping = docker('port', name, '1453/tcp').split('\n')[0];
  assert.match(mapping, /^127\.0\.0\.1:\d+$/);
  base = `http://${mapping}`;
  await ready();
  assert.notEqual(docker('exec', name, 'id', '-u'), '0', 'Runtime must not be root');
  assert.equal(docker('inspect', '--format', '{{.HostConfig.ReadonlyRootfs}}', name), 'true');
  const home = await fetch(`${base}/remindme`);
  assert.equal(home.status, 200);
  assert((await home.text()).includes('<div id="root">'), 'Built frontend must be served');
  assert.equal((await fetch(`${base}/api/auth/status`).then(response => response.json())).localMode, true);
  const user = await session();
  const bin = await api('/api/bins', 'POST', { name: 'Docker smoke bin', locationId: user.activeLocationId });
  const captureId = crypto.randomUUID();
  const photoId = crypto.randomUUID();
  await api('/api/captures', 'POST', { id: captureId, bin_id: bin.id });
  const png = execFileSync('docker', ['exec', name, 'node', '--input-type=module', '-e',
    "import sharp from 'sharp'; process.stdout.write(await sharp({create:{width:16,height:16,channels:3,background:'#2468af'}}).png().toBuffer());"],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  await api(`/api/captures/${captureId}/photos/${photoId}`, 'PUT', png, {
    'Content-Type': 'image/png', 'X-Photo-SHA256': crypto.createHash('sha256').update(png).digest('hex'),
  });
  const history = await api(`/api/captures/history?bin_id=${bin.id}`);
  assert.equal(history.photos.length, 1);
  assert(history.photos[0].preview_url, 'Image decoding and retained previews must work');
  assert.equal((await fetch(`${base}${history.photos[0].preview_url}`)).status, 200);
  docker('restart', '-t', '15', name);
  // Docker may allocate a new host port when restarting a :0 published port.
  const restartedMapping = docker('port', name, '1453/tcp').split('\n')[0];
  assert.match(restartedMapping, /^127\.0\.0\.1:\d+$/);
  base = `http://${restartedMapping}`;
  await ready();
  const resumed = await session();
  assert.equal(resumed.id, user.id, 'Local profile must survive restart');
  assert.equal((await api(`/api/bins/${bin.id}`)).name, 'Docker smoke bin');
  assert.equal((await api(`/api/captures/history?bin_id=${bin.id}`)).photos.length, 1);
  await api(`/api/captures/${captureId}/photos/${photoId}/history`, 'DELETE');
  assert.equal((await api(`/api/captures/history?bin_id=${bin.id}`)).photos.length, 0);
  assert.equal((await fetch(`${base}/api/captures/${captureId}/photos/${photoId}/preview`)).status, 404);
  console.log('Docker smoke passed: frontend, non-root/read-only runtime, LAN CSRF writes, image preview, restart persistence and history deletion.');
} finally {
  try { docker('rm', '-f', name); } catch { /* Container may not have started. */ }
  for (const volume of [dataVolume, scratchVolume]) {
    try { docker('volume', 'rm', volume); } catch { /* Volume may not have been created. */ }
  }
}
