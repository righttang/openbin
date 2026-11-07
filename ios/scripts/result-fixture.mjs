// Isolated local data for the native recognition-result deletion UI test.
import crypto from 'node:crypto';
import pg from '../../server/node_modules/pg/lib/index.js';
import sharp from '../../server/node_modules/sharp/lib/index.js';

const database = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !database.pathname.includes('test')) {
  throw new Error('Native UI fixtures require the local test PostgreSQL database');
}
const [mode, userId, locationId, fixtureId] = process.argv.slice(2);
const client = new pg.Client({ connectionString: database.href });
await client.connect();
try {
  if (mode === 'cleanup') {
    await client.query('DELETE FROM bins WHERE id=$1 AND created_by=$2', [fixtureId, userId]);
  } else if (mode === 'prepare') {
    const placeID = crypto.randomUUID();
    const captureID = crypto.randomUUID();
    const photoID = crypto.randomUUID();
    const at = new Date().toISOString();
    const preview = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3388bb' } }).jpeg().toBuffer();
    const ids = { placeID, captureID, wrongItemID: crypto.randomUUID(), wrongObservationID: crypto.randomUUID(), correctObservationID: crypto.randomUUID() };
    await client.query('BEGIN');
    await client.query('INSERT INTO bins (id,short_code,location_id,name,created_by) VALUES ($1,$2,$3,$4,$5)', [placeID, placeID.slice(0, 8), locationId, '识别结果删除验收', userId]);
    await client.query('INSERT INTO bin_capture_state (bin_id) VALUES ($1)', [placeID]);
    await client.query(`INSERT INTO capture_batches (id,bin_id,created_by,captured_at,sequence,state,expires_at,created_at,updated_at)
      VALUES ($1,$2,$3,$4,1,'applied',$4,$4,$4)`, [captureID, placeID, userId, at]);
    await client.query(`INSERT INTO capture_photos (capture_id,id,position,sha256,size,mime_type,storage_path,received_at)
      VALUES ($1,$2,0,$3,$4,'image/jpeg',$5,$6)`, [captureID, photoID, crypto.createHash('sha256').update(preview).digest('hex'), preview.length, '/tmp/native-ui-result-fixture-' + photoID, at]);
    await client.query('INSERT INTO capture_photo_history (capture_id,photo_id,preview_jpeg,width,height) VALUES ($1,$2,$3,64,48)', [captureID, photoID, preview]);
    for (const [itemID, observationID, name] of [[ids.wrongItemID, ids.wrongObservationID, '识别错误项'], [crypto.randomUUID(), ids.correctObservationID, '正确物品']]) {
      await client.query(`INSERT INTO bin_items (id,bin_id,name,description,quantity,aliases_json,last_seen_batch_id,last_seen_at,observation_state,capture_created,created_at,updated_at)
        VALUES ($1,$2,$3,'界面验收记录',1,'[]',$4,$5,'seen',1,$5,$5)`, [itemID, placeID, name, captureID, at]);
      await client.query(`INSERT INTO observations (id,capture_id,item_id,name,description,quantity,aliases_json,photo_ids_json,created_at)
        VALUES ($1,$2,$3,$4,'界面验收记录',1,'[]',$5,$6)`, [observationID, captureID, itemID, name, JSON.stringify([photoID]), at]);
      await client.query(`INSERT INTO observation_photos (observation_id,capture_id,photo_id,bbox_json,crop_jpeg)
        VALUES ($1,$2,$3,'[0,0,1,1]',$4)`, [observationID, captureID, photoID, preview]);
    }
    await client.query('COMMIT');
    console.log(JSON.stringify(ids));
  } else { throw new Error('Unknown fixture action'); }
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally { await client.end(); }
