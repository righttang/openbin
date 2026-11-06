import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { expect, it } from 'vitest';
import { runBackup } from '../backup.js';
import { captureDirectory } from './cleanup.js';

it('backs up the database without copying temporary capture image payloads', async () => {
  const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), 'remindme-backup-test-'));
  const scratch = captureDirectory('backup-scratch-test');
  fs.mkdirSync(scratch, { recursive: true });
  const sentinel = 'temporary-photo-content-that-must-never-enter-backups';
  fs.writeFileSync(path.join(scratch, 'photo.jpg'), sentinel);
  try {
    const filename = await runBackup({ backupPath });
    const entries = unzipSync(fs.readFileSync(filename));
    expect(Object.keys(entries)).toContain('openbin.db');
    expect(Object.keys(entries).some(name => name.includes('capture') || name.includes('scratch'))).toBe(false);
    expect(Object.values(entries).some(bytes => Buffer.from(bytes).includes(sentinel))).toBe(false);
  } finally {
    fs.rmSync(backupPath, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
