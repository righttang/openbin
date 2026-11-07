// Real gateway check with synthetic place text; no database writes or recordings.
import assert from 'node:assert/strict';
import { correctPlaceWithModel } from '../server/dist/lib/captures/place-refine.js';
const result = await correctPlaceWithModel({ name: '车库架子', notes: '车库右侧。' },
  '位置名称保持不变，把位置说明改成车库右侧架子的第二层，靠门一侧。');
assert.equal(result.name, '车库架子');
assert.ok(result.notes.includes('第二层') && result.notes.includes('靠门'));
console.log(JSON.stringify({ verified: true, name_preserved: true, ...result }));
