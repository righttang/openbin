import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../db.js';
import { replaceBinItems } from '../binUpdateHelpers.js';

const binId = 'stable-item-bin';

beforeEach(() => {
  const db = getDb();
  db.prepare("INSERT INTO users (id,email,display_name) VALUES ('editor','editor@example.com','Editor')").run();
  db.prepare("INSERT INTO locations (id,name,invite_code,created_by) VALUES ('home','Home','stable-items','editor')").run();
  db.prepare("INSERT INTO bins (id,short_code,location_id,name,created_by) VALUES (?,'STABLE','home','Drawer','editor')").run(binId);
  db.prepare('INSERT INTO bin_capture_state (bin_id) VALUES (?)').run(binId);
  db.prepare(`INSERT INTO bin_items
    (id,bin_id,name,quantity,position,normalized_name,description,aliases_json,last_seen_batch_id,last_seen_at,observation_state)
    VALUES ('cable',?,'USB-C Cable',3,0,'usb-c cable','Black braided cable','["charging cable"]','capture-before-edit','2026-11-06T01:00:00.000Z','seen'),
      ('hidden',?,'Scissors',1,1,'scissors','Red handles','[]','capture-older','2026-11-05T01:00:00.000Z','not_seen_in_latest_capture')`)
    .run(binId, binId);
});

describe('replaceBinItems stable identities', () => {
  it('retains capture identity, metadata and omitted quantity across normalized-name edits and reordering', async () => {
    const db = getDb();
    await replaceBinItems(binId, ['Scissors', '  ＵＳＢ-Ｃ   cable  ', 'Batteries']);
    const cable = db.prepare('SELECT * FROM bin_items WHERE id=?').get('cable');
    expect(cable).toMatchObject({
      id: 'cable', name: '  ＵＳＢ-Ｃ   cable  ', quantity: 3, position: 1,
      normalized_name: 'usb-c cable', description: 'Black braided cable', aliases_json: '["charging cable"]',
      last_seen_batch_id: 'capture-before-edit', last_seen_at: '2026-11-06T01:00:00.000Z', observation_state: 'seen',
    });
    expect(db.prepare('SELECT position,observation_state FROM bin_items WHERE id=?').get('hidden'))
      .toEqual({ position: 0, observation_state: 'not_seen_in_latest_capture' });
    expect(db.prepare('SELECT * FROM bin_items WHERE bin_id=?').all(binId)).toHaveLength(3);
  });

  it('replaces supplied counts without incrementing and accepts explicit unknown quantities', async () => {
    const db = getDb();
    await replaceBinItems(binId, [{ name: 'USB-C Cable', quantity: 2 }, 'Scissors']);
    await replaceBinItems(binId, [{ name: 'USB-C Cable', quantity: 2 }, 'Scissors']);
    expect(db.prepare('SELECT id,quantity FROM bin_items WHERE id=?').get('cable')).toEqual({ id: 'cable', quantity: 2 });
    await replaceBinItems(binId, [{ name: 'USB-C Cable', quantity: null }, 'Scissors']);
    expect(db.prepare('SELECT id,quantity FROM bin_items WHERE id=?').get('cable')).toEqual({ id: 'cable', quantity: null });
  });

  it('keeps observation links for matched items while explicitly removed and renamed items are deleted', async () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO capture_batches (id,bin_id,created_by,captured_at,sequence,state,expires_at,created_at,updated_at)
      VALUES ('capture-before-edit',?,'editor',?,1,'applied',?,?,?)`).run(binId, now, now, now, now);
    db.prepare(`INSERT INTO observations (id,capture_id,item_id,name,created_at)
      VALUES ('observed-cable','capture-before-edit','cable','USB-C Cable',?)`).run(now);
    const changes = await replaceBinItems(binId, ['USB-C Cable', 'Kitchen scissors']);
    expect(changes).toEqual({
      items_added: { old: null, new: ['Kitchen scissors'] }, items_removed: { old: ['Scissors'], new: null },
    });
    expect(db.prepare('SELECT item_id FROM observations WHERE id=?').get('observed-cable')).toEqual({ item_id: 'cable' });
    expect(db.prepare('SELECT id FROM bin_items WHERE id=?').get('hidden')).toBeUndefined();
    expect(db.prepare('SELECT id,description,last_seen_at FROM bin_items WHERE name=?').get('Kitchen scissors'))
      .toMatchObject({ description: '', last_seen_at: null });
    await replaceBinItems(binId, []);
    expect(db.prepare('SELECT * FROM bin_items WHERE bin_id=?').all(binId)).toHaveLength(0);
  });

  it('does not force an identity when existing or incoming names are ambiguous', async () => {
    const db = getDb();
    db.prepare("INSERT INTO bin_items (id,bin_id,name,position) VALUES ('other-cable',?,'usb-c cable',2)").run(binId);
    await replaceBinItems(binId, ['USB-C Cable', 'Scissors', 'scissors']);
    const items = db.prepare('SELECT id,description,last_seen_at FROM bin_items WHERE bin_id=?').all(binId) as Array<{ id: string }>;
    expect(items).toHaveLength(3);
    expect(items.every((item) => !['cable', 'other-cable', 'hidden'].includes(item.id))).toBe(true);
  });
});
