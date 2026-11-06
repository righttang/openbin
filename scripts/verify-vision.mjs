// A synthetic transport/schema smoke test, not a real-drawer accuracy benchmark.
// Run: node --env-file=.env scripts/verify-vision.mjs [photo-count]
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
const count = Number(process.argv[2] || 20);
if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('Choose 1–20 photos');
const { AI_ENDPOINT_URL, AI_API_KEY, AI_MODEL } = process.env;
if (!AI_ENDPOINT_URL || !AI_API_KEY || !AI_MODEL) throw new Error('Configure AI_ENDPOINT_URL, AI_API_KEY and AI_MODEL');
const content = [{ type: 'text', text: 'These are synthetic test cards. Return JSON with card_numbers, a list of every visible numbered card, in order. Read the number from each image. Do not infer missing cards.' }];
for (let n = 1; n <= count; n++) {
  const svg = `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="480" fill="#faf7ed"/><rect x="30" y="30" width="580" height="420" rx="24" fill="#dcece5"/><text x="320" y="140" font-family="sans-serif" font-size="40" text-anchor="middle">RemindMe test card</text><text x="320" y="320" font-family="sans-serif" font-size="150" text-anchor="middle">${n}</text></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } });
}
const started = Date.now();
const response = await fetch(`${AI_ENDPOINT_URL.replace(/\/$/, '')}/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${AI_API_KEY}`, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store' },
  body: JSON.stringify({ model: AI_MODEL, messages: [{ role: 'user', content }], response_format: { type: 'json_object' }, 'no-log': true, store: false, cache: { 'no-cache': true, 'no-store': true } }),
  signal: AbortSignal.timeout(180_000),
});
if (!response.ok) throw new Error(`Vision gateway returned HTTP ${response.status}; response body omitted`);
const result = await response.json();
const data = JSON.parse(result.choices?.[0]?.message?.content || 'null');
if (!Array.isArray(data?.card_numbers) || data.card_numbers.length !== count || data.card_numbers.some((n, i) => Number(n) !== i + 1)) {
  throw new Error('Model did not identify every test card correctly');
}
console.log(JSON.stringify({ model: AI_MODEL, images: count, structured_response: 'passed', all_cards_read: true, elapsed_seconds: Math.round((Date.now() - started) / 1000) }));
