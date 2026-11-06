import { generateUuid, query, withTransaction } from '../db.js';
import { config } from './config.js';
import { generateInviteCode } from './inviteCode.js';

const DEFAULT_LOCAL_ID = '5f46266f-66ea-4a9a-9b8d-d50bb8aa4558';

export async function getLocalUser(): Promise<{ id: string; email: string }> {
  const result = await query<{ id: string; email: string }>(
    'SELECT id, email FROM users WHERE id = $1 AND deleted_at IS NULL AND suspended_at IS NULL',
    [config.localUserId || DEFAULT_LOCAL_ID],
  );
  if (!result.rows[0]) throw new Error('Local household profile is unavailable');
  return result.rows[0];
}

/** Keep one stable identity so all devices share inventory and upload recovery. */
export async function initializeLocalMode(): Promise<void> {
  if (!config.localMode) return;
  await withTransaction(async (tx) => {
    const userId = config.localUserId || DEFAULT_LOCAL_ID;
    if (!config.localUserId) {
      await tx(
        `INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)
         ON CONFLICT(id) DO NOTHING`,
        [userId, 'local@remindme.invalid', '我的家'],
      );
    }
    const user = (await tx<{ active_location_id: string | null; deleted_at: string | null; suspended_at: string | null }>(
      'SELECT active_location_id, deleted_at, suspended_at FROM users WHERE id = $1', [userId],
    )).rows[0];
    if (!user || user.deleted_at || user.suspended_at) throw new Error('Local household profile is unavailable');
    const locations = await tx<{ id: string }>(
      `SELECT l.id FROM locations l JOIN location_members lm ON lm.location_id = l.id
       WHERE lm.user_id = $1 ORDER BY l.created_at, l.id`, [userId],
    );
    let locationId = locations.rows.find((l) => l.id === user.active_location_id)?.id || locations.rows[0]?.id;
    if (!locationId) {
      locationId = generateUuid();
      await tx(
        'INSERT INTO locations (id, name, created_by, invite_code, app_name) VALUES ($1, $2, $3, $4, $5)',
        [locationId, '我的家', userId, generateInviteCode(), 'RemindMe'],
      );
      await tx(
        'INSERT INTO location_members (id, location_id, user_id, role) VALUES ($1, $2, $3, $4)',
        [generateUuid(), locationId, userId, 'admin'],
      );
    }
    await tx('UPDATE users SET active_location_id = $1 WHERE id = $2', [locationId, userId]);
  });
}
