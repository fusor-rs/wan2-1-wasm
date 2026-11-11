// End-to-end run in headless Chrome, in a fresh profile.
//
// 1. Open the page and make the reference: the same build's single-threaded runtime in Node
//    (`scripts/node-smoke.mjs`) generates the clip for the page's own request: its prompt,
//    negative prompt, guidance and shift, at the e2e's size, frames, steps and seed.
// 2. Press Generate while the model is still loading: the request is queued and runs the moment
//    both bundles are ready. Check that a preview was drawn before the frames, that the clip has
//    every frame, that each frame is a picture (varied across the canvas), that the frames equal
//    the reference's byte for byte, that the WebM download exists, and that nothing was
//    requested after the model was ready.
// 3. Reload: the revisit must load every part from OPFS.
//
//   PORT=8787 node e2e/run.mjs --build web-threaded [--threads 8]
//   node e2e/run.mjs --build web-threaded --url https://example.org   # a deployed page
//
// `--build` is the page's runtime, `web-threaded` or `web-threaded-relaxed`; the reference runs
// its single-threaded twin, `web-single` or `web-single-relaxed` (`just runtimes`), on dist/model.
// Results (JSON, the reference's and the page's RGBA frames, one after another, and a screenshot)
// go to e2e/results/<timestamp>-*, or to `--out <dir>`.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetched, flags, run, STAMP } from '../vendor/fusor-ai/packages/e2e/kit.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const values = flags({});
const DEADLINE_MS = 30 * 60 * 1000;
const SIZE = { id: '160x96', width: 160, height: 96 };
const FRAMES = 9;
const STEPS = 4;
const SEED = 42;
const CHANNELS = 4;
// A frame's pixels spread over more than this standard deviation (0 to 255).
const MIN_SPREAD = 20;

// The page's state machine is `main[data-phase]`: loading, ready, generating, broken.
const settled = () => /^(ready|broken)$/.test(document.querySelector('main')?.dataset.phase ?? '');
const loadedOrBroken = () => document.querySelector('main')?.dataset.loaded === 'true' || document.querySelector('main')?.dataset.phase === 'broken';

/** In the page: the canvas's size, its distinct colours and the spread of its pixels. */
function inspectCanvas() {
  const canvas = document.querySelector('#picture');
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const colours = new Set();
  let sum = 0;
  let squares = 0;
  for (let at = 0; at < data.length; at += 4) {
    colours.add((data[at] << 16) | (data[at + 1] << 8) | data[at + 2]);
    const grey = (data[at] + data[at + 1] + data[at + 2]) / 3;
    sum += grey;
    squares += grey * grey;
  }
  const pixels = data.length / 4;
  return { width: canvas.width, height: canvas.height, colours: colours.size, spread: Math.sqrt(squares / pixels - (sum / pixels) ** 2) };
}

/** In the page: shows frame `index` of the clip, then the canvas's RGBA pixels, base64-encoded. */
async function frameAt(index) {
  const slider = document.querySelector('#frame');
  slider.value = index;
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const canvas = document.querySelector('#picture');
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  // Spread in slices: one call takes only so many arguments.
  const SLICE = 0x8000;
  let binary = '';
  for (let at = 0; at < data.length; at += SLICE) binary += String.fromCharCode(...data.subarray(at, at + SLICE));
  return btoa(binary);
}

/** In the page: the type and size of the file the download link holds. */
async function downloaded() {
  const blob = await (await fetch(document.querySelector('#download').href)).blob();
  return { type: blob.type, size: blob.size };
}

/** The bytes in which two buffers differ, those past the shorter one included. */
function differing(actual, expected) {
  let count = Math.abs(actual.length - expected.length);
  for (let at = 0; at < Math.min(actual.length, expected.length); at++) count += actual[at] !== expected[at];
  return count;
}

/** The frames of `request` from the single-threaded twin of the page's build in Node, in `file`. */
function makeReference(request, file) {
  if (!values.build) throw new Error('pass --build web-threaded or web-threaded-relaxed: the reference is its single-threaded twin');
  const settings = Object.entries(request).flatMap(([field, value]) => [`--${field}`, String(value)]);
  const smoke = join(ROOT, 'scripts/node-smoke.mjs');
  const build = values.build.replace('threaded', 'single');
  execFileSync(process.execPath, [smoke, join(ROOT, 'dist/model'), '--build', build, '--out', file, ...settings], { stdio: 'inherit' });
}

const launch = {
  root: ROOT,
  name: 'wan2-1',
  values,
  fields: { steps: STEPS, frames: FRAMES, size: SIZE.id },
};
await run(launch, async ({ page, requests, query, base, runDir, results, check, revisit }) => {
  const t0 = Date.now();
  await page.goto(`${base}/${query}`);
  await page.waitForSelector('main[data-phase]');
  const reference = join(runDir, `${STAMP}-reference.rgba`);
  const request = {
    prompt: await page.inputValue('#prompt'),
    negative: await page.inputValue('#negative'),
    width: SIZE.width,
    height: SIZE.height,
    frames: FRAMES,
    steps: STEPS,
    guidance: await page.inputValue('#guidance'),
    shift: await page.inputValue('#shift'),
    seed: SEED,
  };
  makeReference(request, reference);
  await page.click(`.size:has(input[value="${SIZE.id}"]) span`);
  for (const [id, value] of [['frames', FRAMES], ['steps', STEPS], ['seed', SEED]]) {
    await page.$eval(`#${id}`, (input, text) => {
      input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(value));
  }
  results.queuedWhileLoading = (await page.getAttribute('main', 'data-loaded')) !== 'true';
  await page.click('#generate');
  await page.waitForFunction(loadedOrBroken, null, { timeout: DEADLINE_MS, polling: 250 });
  results.loadMs = Date.now() - t0;
  const requestsAtReady = requests.length;
  await page.waitForFunction(() => document.querySelector('main')?.dataset.phase === 'generating', null, { timeout: DEADLINE_MS, polling: 100 });
  await page.waitForFunction(() => Number(document.querySelector('#steps-done')?.value) > 0, null, { timeout: DEADLINE_MS, polling: 250 });
  results.preview = await page.evaluate(inspectCanvas);
  await page.waitForFunction(settled, null, { timeout: DEADLINE_MS, polling: 500 });
  results.runtime = await page.textContent('#runtime');
  results.status = await page.textContent('#status');
  const tiles = ['time', 'per-step', 'steps-count', 'size', 'requests'];
  results.metrics = Object.fromEntries(await Promise.all(tiles.map(async (id) => [id, await page.textContent(`#${id}`)])));
  results.download = await page.evaluate(downloaded);
  if ((await page.textContent('#play')) === 'Pause') await page.click('#play');
  const clip = [];
  results.frames = [];
  for (let index = 0; index < FRAMES; index++) {
    clip.push(Buffer.from(await page.evaluate(frameAt, index), 'base64'));
    results.frames.push(await page.evaluate(inspectCanvas));
  }
  const video = Buffer.concat(clip);
  writeFileSync(join(runDir, `${STAMP}-video.rgba`), video);
  results.differingBytes = differing(video, readFileSync(reference));
  results.requestsWhileGenerating = fetched(requests, requestsAtReady);
  const frameBytes = SIZE.width * SIZE.height * CHANNELS;
  check(results.status === 'Done.', `generated (Generate pressed while ${results.queuedWhileLoading ? 'loading' : 'loaded'}; ${results.runtime}): ${results.metrics.time}, ${results.metrics['per-step']} per step, ${results.metrics.size}`);
  check(results.preview.colours > 1, `a preview before the frames (${results.preview.width}×${results.preview.height}, ${results.preview.colours} colours)`);
  check(video.length === FRAMES * frameBytes && results.frames.every((frame) => frame.width === SIZE.width && frame.height === SIZE.height), `${FRAMES} frames of ${SIZE.width}×${SIZE.height}`);
  check(results.frames.every((frame) => frame.spread > MIN_SPREAD), `every frame is a picture: spread ${results.frames.map((frame) => frame.spread.toFixed(1)).join(', ')}`);
  check(results.differingBytes === 0, `the frames equal the single-threaded runtime's in Node: ${results.differingBytes} bytes differ`);
  check(results.download.type === 'video/webm' && results.download.size > 0, `the download is ${results.download.type}, ${results.download.size} bytes`);
  check(results.requestsWhileGenerating.length === 0 && results.metrics.requests === '0', `requests while generating: ${results.requestsWhileGenerating.length} seen, page counts ${results.metrics.requests}`);
  await page.screenshot({ path: join(runDir, `${STAMP}-video.png`), fullPage: true });

  await revisit(loadedOrBroken, DEADLINE_MS);
});
