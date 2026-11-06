import { useEffect, useState, useSyncExternalStore } from 'react';
import { Events, notify } from '@/lib/eventBus';
import { AutomaticCaptureQueue, type PhotoTask } from './automaticCaptureQueue';
import { automaticCaptureClient, getCaptureConfig } from './captureClient';
import { createCaptureId } from './captureCrypto';
import { clearDraft, loadDrafts, saveDraft } from './captureQueue';
import { preparePhoto } from './preparePhoto';
import type { CaptureConfig } from './types';

const queues = new Map<string, AutomaticCaptureQueue>();
const empty: PhotoTask[] = [];
const noSubscription = () => () => {};
const emptySnapshot = () => empty;
const configKey = 'remindme-capture-config';
const recoveryConfig: CaptureConfig = { maxPhotos: 20, maxPhotoBytes: 5 * 1024 * 1024, uploadExpiryMs: 3600000, supportedMimeTypes: ['image/jpeg'], modelConfigured: false };

function cachedConfig(): CaptureConfig | null {
  try {
    const value = JSON.parse(localStorage.getItem(configKey) || 'null') as CaptureConfig | null;
    return value && value.maxPhotoBytes > 0 && value.uploadExpiryMs > 0 && typeof value.modelConfigured === 'boolean' ? value : null;
  } catch { return null; }
}

/** The queue stays alive when moving between scan, find and history. */
export function useAutomaticCaptureQueue(ownerId?: string) {
  const [config, setConfig] = useState<CaptureConfig | null>(cachedConfig);
  const [error, setError] = useState('');
  const [queue, setQueue] = useState<AutomaticCaptureQueue | null>(null);
  useEffect(() => {
    let active = true;
    let instance = ownerId ? queues.get(ownerId) : undefined;
    if (ownerId && !instance) {
      instance = new AutomaticCaptureQueue(ownerId, cachedConfig() ?? recoveryConfig, {
        client: automaticCaptureClient, storage: { load: loadDrafts, save: saveDraft, clear: clearDraft },
        prepare: preparePhoto, id: createCaptureId, changed: () => notify(Events.BINS),
      });
      queues.set(ownerId, instance);
      window.addEventListener('online', instance.retryDisconnected);
    }
    setQueue(instance ?? null);
    // Local recovery and cancellation must not depend on a successful config request.
    void instance?.start();
    const refreshConfig = async () => {
      try {
        const next = await getCaptureConfig();
        if (!active) return;
        setConfig(next); setError('');
        instance?.updateConfig(next);
        instance?.retryDisconnected();
        try { localStorage.setItem(configKey, JSON.stringify(next)); } catch { /* In-memory configuration is enough for this session. */ }
      } catch {
        if (active) setError('暂时无法联网，待处理照片仍保留。恢复联网后会自动继续。');
      }
    };
    void refreshConfig();
    window.addEventListener('online', refreshConfig);
    return () => { active = false; window.removeEventListener('online', refreshConfig); };
  }, [ownerId]);
  const tasks = useSyncExternalStore(queue?.subscribe ?? noSubscription, queue?.getSnapshot ?? emptySnapshot);
  return { queue, tasks, config, error };
}
