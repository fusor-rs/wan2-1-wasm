// Runs a single-threaded wasm runtime build in Node against both bundles: the text runtime, in a
// worker thread (its own module instance and memory), encodes the prompt and the negative prompt;
// the video runtime generates a small clip step by step, previewing each step and decoding frame
// by frame, and the time of each stage is printed. Fails if a preview is missing, the frame count
// is wrong or a frame is blank. With `--out`, every frame's RGBA is written to that file, one
// after another. The request's fields are options (the e2e run takes its reference from here).
//
//   node scripts/node-smoke.mjs dist/model --build web-single [--steps 2] [--out clip.rgba]
//     [--prompt text] [--negative text] [--width 160] [--height 96] [--frames 9]
//     [--guidance 5] [--shift 5] [--seed 7]

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const PROMPT = 'A lighthouse on a rocky coast at sunset, waves crashing, cinematic';
// Wan's `sample_neg_prompt`: the negative prompt when none is given.
const NEGATIVE = '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走';
const CHUNK = 8 << 20;
const RGBA = 4;
const MIN_COLOURS = 2;

const seconds = (since) => ((performance.now() - since) / 1000).toFixed(2);

/** The class `className` of the runtime build, with the bundle at `bundle` pushed into it. */
async function load(className, bundle, build) {
  const dist = new URL(`../app/engine/dist/${build}/`, import.meta.url);
  const glue = await import(new URL('wan2_1_runtime.js', dist));
  glue.initSync({ module: readFileSync(new URL('wan2_1_runtime_bg.wasm', dist)) });
  const t0 = performance.now();
  const manifest = readFileSync(join(bundle, 'manifest.json'), 'utf8');
  const runtime = new glue[className](manifest);
  let ready = false;
  JSON.parse(manifest).parts.forEach((part, index) => {
    const bytes = readFileSync(join(bundle, part.file));
    for (let offset = 0; offset < bytes.length; offset += CHUNK) runtime.write_part(index, bytes.subarray(offset, offset + CHUNK));
    ready = runtime.end_part(index);
  });
  if (!ready) throw new Error(`${className} not ready after every part`);
  console.log(`${build} ${className}: load ${seconds(t0)}s`);
  return { glue, runtime };
}

/** In the worker thread: the states of the prompt and of the negative prompt. */
async function encode({ bundle, build, prompt: promptText, negative: negativeText }) {
  const { runtime } = await load('TextRuntime', join(bundle, 'text'), build);
  const t0 = performance.now();
  const prompt = runtime.encode(promptText);
  const negative = runtime.encode(negativeText);
  parentPort.postMessage({ prompt, negative, seconds: seconds(t0) }, [prompt.buffer, negative.buffer]);
}

/** The colours a frame has, up to `MIN_COLOURS`. */
function colours(frame) {
  const seen = new Set();
  for (let at = 0; at < frame.length && seen.size < MIN_COLOURS; at += RGBA) seen.add((frame[at] << 16) | (frame[at + 1] << 8) | frame[at + 2]);
  return seen.size;
}

async function generate() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      build: { type: 'string', default: 'web-single' },
      steps: { type: 'string', default: '2' },
      prompt: { type: 'string', default: PROMPT },
      negative: { type: 'string', default: NEGATIVE },
      width: { type: 'string', default: '160' },
      height: { type: 'string', default: '96' },
      frames: { type: 'string', default: '9' },
      guidance: { type: 'string', default: '5' },
      shift: { type: 'string', default: '5' },
      seed: { type: 'string', default: '7' },
      out: { type: 'string' },
    },
  });
  const bundle = positionals[0] ?? 'dist/model';
  const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { bundle, build: values.build, prompt: values.prompt, negative: values.negative } });
  const states = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  await worker.terminate();
  console.log(`  prompts: ${states.seconds}s`);

  const { runtime } = await load('VideoRuntime', join(bundle, 'video'), values.build);
  const request = Object.fromEntries(
    ['width', 'height', 'frames', 'steps', 'guidance', 'shift', 'seed'].map((field) => [field, Number(values[field])]),
  );
  let t0 = performance.now();
  const plan = JSON.parse(runtime.start(JSON.stringify(request), states.prompt, states.negative));
  console.log(`  start: ${seconds(t0)}s`);
  const frameBytes = plan.width * plan.height * RGBA;
  const frames = [];
  let failed = false;
  for (let done = false; !done; ) {
    t0 = performance.now();
    const progress = JSON.parse(runtime.step());
    done = progress.done;
    if (progress.decoded === 0) {
      const preview = progress.step < progress.steps ? runtime.preview() : null;
      failed ||= preview !== null && preview.length !== frameBytes;
      console.log(`  step ${progress.step}/${progress.steps}: ${seconds(t0)}s`);
    } else {
      const decoded = runtime.take_frames();
      for (let at = 0; at < decoded.length; at += frameBytes) frames.push(decoded.subarray(at, at + frameBytes));
      console.log(`  frames ${progress.decoded}/${progress.frames}: ${seconds(t0)}s`);
    }
  }
  if (values.out) writeFileSync(values.out, Buffer.concat(frames));
  const blank = frames.filter((frame) => colours(frame) < MIN_COLOURS).length;
  console.log(`  ${plan.width}×${plan.height}, ${frames.length} frames, ${blank} blank`);
  failed ||= frames.length !== plan.frames || blank > 0;
  if (failed) process.exit(1);
}

if (isMainThread) await generate();
else await encode(workerData);
