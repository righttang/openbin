import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDrafts, saveDraft } from '../captureQueue';
import type { CaptureDraft } from '../types';

const expired = (id: string, cancelRequested = false): CaptureDraft => ({ id, ownerId: 'owner', binId: 'drawer',
  createdAt: '2000-01-01T00:00:00Z', expiresAt: '2000-01-01T01:00:00Z', sealed: true, automatic: true, cancelRequested,
  photos: [{ id: 'photo', name: 'original.jpg', sha256: 'hash', size: 5, order: 0 }] });

beforeEach(() => { localStorage.clear(); vi.stubGlobal('indexedDB', undefined); });

describe('durable capture manifests', () => {
  it('retains pending and cancelled records past their deadline, including when another photo is saved', async () => {
    await saveDraft(expired('offline'));
    await saveDraft(expired('cancelled', true));
    await saveDraft({ ...expired('new'), expiresAt: new Date(Date.now() + 3600000).toISOString() });
    const loaded = await loadDrafts('owner');
    expect(new Set(loaded.map((entry) => entry.id))).toEqual(new Set(['offline', 'cancelled', 'new']));
    expect(loaded.find((entry) => entry.id === 'cancelled')?.cancelRequested).toBe(true);
    expect(loaded.find((entry) => entry.id === 'offline')?.photos[0].name).toBe('original.jpg');
  });

  it('does not drop older cancellation intents when many new manifests are saved', async () => {
    await saveDraft(expired('cancelled', true));
    for (let index = 0; index < 45; index++) await saveDraft(expired(`photo-${index}`));
    const loaded = await loadDrafts('owner');
    expect(loaded).toHaveLength(46);
    expect(loaded.some((entry) => entry.id === 'cancelled' && entry.cancelRequested)).toBe(true);
  });

  it('reports metadata-only normal saves as unsafe but a saved cancellation as durable', async () => {
    expect(await saveDraft(expired('offline'))).toBe(false);
    expect(await saveDraft(expired('cancelled', true))).toBe(true);
    expect(await loadDrafts('someone-else')).toEqual([]);
  });
});
