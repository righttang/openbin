// Real-model check using a synthetic image, without database writes or voice recording.
import assert from 'node:assert/strict';
import sharp from '../server/node_modules/sharp/lib/index.js';
import { correctItemWithModel } from '../server/dist/lib/captures/refine.js';

const image = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
<rect width="640" height="480" fill="#cbd5e1"/><rect x="150" y="100" width="340" height="210" rx="44" fill="white"/>
<circle cx="320" cy="200" r="68" fill="#111827"/><circle cx="320" cy="200" r="38" fill="#334155"/>
<rect x="295" y="310" width="50" height="80" fill="#f8fafc"/><ellipse cx="320" cy="400" rx="110" ry="22" fill="white"/>
<text x="320" y="457" text-anchor="middle" font-size="22" font-family="sans-serif">OUTDOOR CAMERA</text></svg>`)).jpeg().toBuffer();
const result = await correctItemWithModel({ current: { name: '白色设备', description: '白色外壳的电子设备。', aliases: ['设备'] },
  instruction: '这是小米室外的摄像头，请把名称改成小米室外摄像头，说明写清楚用于室外监控。', image });
assert.ok(result.name.includes('小米') && result.name.includes('摄像头'));
assert.ok(result.description.includes('室外'));
assert.ok(Array.isArray(result.aliases));
console.log(JSON.stringify({ verified: true, image_supplied: true, name: result.name, description: result.description, aliases: result.aliases }));
