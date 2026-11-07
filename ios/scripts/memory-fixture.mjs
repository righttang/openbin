import crypto from 'node:crypto';
import pg from '../../server/node_modules/pg/lib/index.js';
import sharp from '../../server/node_modules/sharp/lib/index.js';
const database = new URL(process.env.DATABASE_URL);
if (!['localhost','127.0.0.1'].includes(database.hostname) || !database.pathname.includes('test')) throw new Error('Local test database required');
const [mode,userId,locationId,fixtureId] = process.argv.slice(2);
const client = new pg.Client({connectionString:database.href}); await client.connect();
try {
  if (mode === 'cleanup') { await client.query('DELETE FROM bins WHERE id=$1 AND created_by=$2',[fixtureId,userId]); }
  else {
    const placeID=crypto.randomUUID(), newestCaptureID=crypto.randomUUID(), targetItemID=crypto.randomUUID(), targetObservationID=crypto.randomUUID();
    const preview=await sharp({create:{width:960,height:720,channels:3,background:'#4288a9'}}).jpeg().toBuffer();
    const crop=await sharp(preview).resize(512,384).jpeg().toBuffer();
    await client.query('BEGIN');
    await client.query('INSERT INTO bins (id,short_code,location_id,name,created_by) VALUES ($1,$2,$3,$4,$5)',[placeID,placeID.slice(0,8),locationId,'照片内存压力验收',userId]);
    await client.query('INSERT INTO bin_capture_state (bin_id) VALUES ($1)',[placeID]);
    for (let i=0;i<80;i++) {
      const captureID=i===0?newestCaptureID:crypto.randomUUID(), photoID=crypto.randomUUID();
      const at=new Date(Date.now()-i*1000).toISOString();
      await client.query(`INSERT INTO capture_batches (id,bin_id,created_by,captured_at,sequence,state,expires_at,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,'applied',$4,$4,$4)`,[captureID,placeID,userId,at,i+1]);
      await client.query(`INSERT INTO capture_photos (capture_id,id,position,sha256,size,mime_type,storage_path,received_at)
        VALUES ($1,$2,0,$3,$4,'image/jpeg',$5,$6)`,[captureID,photoID,crypto.createHash('sha256').update(preview).digest('hex'),preview.length,'/tmp/memory-fixture-'+photoID,at]);
      await client.query('INSERT INTO capture_photo_history (capture_id,photo_id,preview_jpeg,width,height) VALUES ($1,$2,$3,960,720)',[captureID,photoID,preview]);
      for(let j=0;j<2;j++) {
        const itemID=i===0&&j===0?targetItemID:crypto.randomUUID(), observationID=i===0&&j===0?targetObservationID:crypto.randomUUID();
        const name=`压力物品${i}-${j}`;
        await client.query(`INSERT INTO bin_items (id,bin_id,name,position,description,quantity,aliases_json,last_seen_batch_id,last_seen_at,capture_created,created_at,updated_at)
          VALUES ($1,$2,$3,$4,'压力测试物品',1,'[]',$5,$6,1,$6,$6)`,[itemID,placeID,name,i*2+j,captureID,at]);
        await client.query(`INSERT INTO observations (id,capture_id,item_id,name,description,quantity,aliases_json,photo_ids_json,created_at)
          VALUES ($1,$2,$3,$4,'压力测试物品',1,'[]',$5,$6)`,[observationID,captureID,itemID,name,JSON.stringify([photoID]),at]);
        await client.query('INSERT INTO observation_photos (observation_id,capture_id,photo_id,crop_jpeg) VALUES ($1,$2,$3,$4)',[observationID,captureID,photoID,crop]);
      }
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({placeID,newestCaptureID,targetItemID,targetObservationID,photos:80,items:160}));
  }
} catch(error) {await client.query('ROLLBACK');throw error;} finally {await client.end();}
