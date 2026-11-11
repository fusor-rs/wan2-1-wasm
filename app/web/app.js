import { ComputePool, SPAWN_COMPUTE } from '../../vendor/fusor-ai/packages/host/compute.js';

// The engine bridge. The page's state lives in Rust (src/app.rs); this module owns the two engine
// workers (the text encoder's and the video model's, each with its own memory) and, in threaded
// builds, their compute workers (fusor-ai's ComputePool). A generation encodes the prompts in the
// text worker, hands their states to the video worker, draws each step's preview and each decoded
// frame on the canvas, plays the finished clip in a loop, and records it as a WebM. It measures
// each generation and reports back with `engine` events.

const params = new URLSearchParams(location.search);
const cores = navigator.hardwareConcurrency || 4;
// One compute worker per core minus two (the page and the engine worker), at most 8; `?threads=1`
// forces the single-threaded build. Never more than the cores: the barriers spin.
const requestedThreads = Number.parseInt(params.get('threads') ?? '', 10);
const THREADS = Math.min(cores, requestedThreads > 0 ? requestedThreads : Math.max(1, Math.min(8, cores - 2)));
// The bundles served next to the page (`just serve` mounts dist/model there); `?model=<url>` loads
// another one, `?build=web-single` pins a runtime build.
// A Hugging Face Space holds at most 1 GB, so the Space loads the bundles from the model repo
// fusorlabs/wan2.1-t2v-1.3b-web (`just deploy-model`) instead of from beside the page.
const HOSTED_MODEL = 'https://huggingface.co/fusorlabs/wan2.1-t2v-1.3b-web/resolve/main/';
const DEFAULT_MODEL = location.hostname.endsWith('.hf.space') ? HOSTED_MODEL : 'model/';
const MODEL_URL = new URL(params.get('model') ?? DEFAULT_MODEL, document.baseURI).href;
const WEBM_TYPES = ['video/webm;codecs=vp9', 'video/webm'];
const RGBA = 4;

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function onMount({ root, inputs, onCleanup }) {
  const report = (detail) => root.dispatchEvent(new CustomEvent('engine', { detail: JSON.stringify(detail) }));
  let fps = 0;
  let notice = '';
  let loaded = false;
  let broken = false;
  let jobs = 0;
  let job = null;
  let clip = null;
  let playback = null;
  let videoUrl = null;
  let readyAt = Infinity;

  const handlers = {
    text: {
      encoded: (message) => {
        if (message.job !== job?.id || job.stopped) return;
        job.textMs = message.textMs;
        job.textRequests = message.networkRequests;
        job.encoding = false;
        report({ type: 'progress', status: 'Denoising…', metrics: metrics() });
        const { prompt, negative } = message;
        bundles.video.worker.postMessage({ type: 'generate', job: job.id, request: inputs.request.get(), prompt, negative }, [prompt.buffer, negative.buffer]);
      },
    },
    video: {
      started: (message) => {
        if (message.job !== job?.id) return;
        job.plan = message.plan;
        job.engine = message;
      },
      step: (message) => {
        if (message.job !== job?.id) return;
        job.engine = message;
        if (message.preview) draw(split({ ...message.preview, count: 1 })[0]);
        const status = message.step < job.plan.steps ? `Step ${message.step} of ${job.plan.steps}` : 'Decoding the video…';
        report({ type: 'progress', status, metrics: metrics() });
      },
      frames: (message) => {
        if (message.job !== job?.id) return;
        job.engine = message;
        const frames = split(message.frames);
        job.frames.push(...frames);
        draw(frames.at(-1));
        report({ type: 'progress', status: `Decoding frame ${job.frames.length} of ${job.plan.frames}…`, metrics: metrics() });
      },
      done: (message) => finish(message),
    },
  };

  /** Starts the worker of bundle `name`, whose messages go to the page's loading and `handlers[name]`. */
  function start(name) {
    const worker = new Worker(new URL(`engine/${name}.js`, document.baseURI), { type: 'module', name: `wan2-1-${name}` });
    const pool = new ComputePool(crash);
    const bundle = { name, worker, pool, build: null, progress: { done: 0, total: 0, network: 0, cache: 0 }, ready: null };
    const routes = {
      [SPAWN_COMPUTE]: (message) => pool.spawn(message),
      runtime: (message) => {
        bundle.build = message;
        if (message.fps) fps = message.fps;
      },
      warning: ({ message }) => {
        console.warn(message);
        notice = ` (${message})`;
      },
      progress: (message) => {
        bundle.progress = message;
        reportLoading();
      },
      ready: (message) => {
        bundle.ready = message;
        if (Object.values(bundles).every((each) => each.ready)) ready();
      },
      error: ({ message }) => {
        if (!loaded) return fail(message);
        if (job) job.encoding = false;
        report({ type: 'error', message });
      },
      fatal: ({ message }) => fail(message),
      ...handlers[name],
    };
    worker.onmessage = ({ data }) => {
      if (!broken) routes[data.type]?.(data);
    };
    worker.onerror = (event) => crash(event.message || 'an engine worker failed');
    worker.postMessage({ type: 'load', modelUrl: new URL(`${name}/`, MODEL_URL).href, threads: THREADS, build: params.get('build') });
    return bundle;
  }

  const total = (key) => Object.values(bundles).reduce((sum, bundle) => sum + bundle.progress[key], 0);

  function reportLoading() {
    const [done, size, network, cache] = ['done', 'total', 'network', 'cache'].map(total);
    const source = cache && !network ? 'from this device' : cache ? `${mb(network)} downloaded, ${mb(cache)} cached` : 'downloading';
    report({ type: 'loading', fraction: size ? done / size : 0, detail: `${mb(done)} / ${mb(size)} · ${source}` });
  }

  function ready() {
    loaded = true;
    readyAt = performance.now();
    const parts = Object.values(bundles);
    const bundleBytes = parts.reduce((sum, bundle) => sum + bundle.ready.total, 0);
    const cached = parts.reduce((sum, bundle) => sum + bundle.ready.cache, 0);
    const loadedInfo = {
      build: `${bundles.video.build.build}${notice}`,
      threads: bundles.video.build.threads,
      bundle_bytes: bundleBytes,
      load_ms: Math.max(...parts.map((bundle) => bundle.ready.ms)),
      from_device: cached === bundleBytes,
    };
    report({ type: 'ready', loaded: loadedInfo });
  }

  /** Runs the request the page holds, timed from now (the click, or the model being ready). */
  function dispatch() {
    stopPlayback();
    clip = null;
    job = { id: ++jobs, t0: performance.now(), encoding: true, stopped: false, plan: null, engine: null, textMs: 0, textRequests: 0, frames: [] };
    bundles.text.worker.postMessage({ type: 'encode', job: job.id, ...JSON.parse(inputs.prompts.get()) });
  }

  function stop() {
    if (!job) return;
    job.stopped = true;
    if (job.encoding) {
      job.encoding = false;
      // A subscription callback runs inside Rust's update: report once it has returned.
      queueMicrotask(() => report({ type: 'done', status: 'Stopped.', video: null, metrics: metrics() }));
      return;
    }
    bundles.video.worker.postMessage({ type: 'stop', job: job.id });
  }

  const canvas = () => root.querySelector('#picture');

  /** `{ width, height, pixels }` (RGBA) as one `ImageData` per frame. */
  function split({ width, height, count, pixels }) {
    const frameBytes = width * height * RGBA;
    return Array.from({ length: count }, (_, index) => new ImageData(new Uint8ClampedArray(pixels.buffer, pixels.byteOffset + index * frameBytes, frameBytes), width, height));
  }

  /** Puts an `ImageData` on the canvas, which takes the video's size. */
  function draw(image) {
    const picture = canvas();
    if (!picture) return;
    if (picture.width !== image.width || picture.height !== image.height) {
      picture.width = image.width;
      picture.height = image.height;
    }
    picture.getContext('2d').putImageData(image, 0, 0);
  }

  function metrics() {
    const engineStats = job.engine ?? {};
    const ownRequests = performance.getEntriesByType('resource').filter((entry) => entry.startTime >= readyAt).length;
    return {
      wall_ms: performance.now() - job.t0,
      text_ms: job.textMs,
      compute_ms: engineStats.computeMs ?? 0,
      decode_ms: engineStats.decodeMs ?? 0,
      step: engineStats.step ?? 0,
      steps: job.plan?.steps ?? 0,
      decoded: job.frames.length,
      frames: job.plan?.frames ?? 0,
      fps,
      width: job.plan?.width ?? 0,
      height: job.plan?.height ?? 0,
      requests: ownRequests + job.textRequests + (engineStats.networkRequests ?? 0),
    };
  }

  async function finish(message) {
    if (message.job !== job?.id) return;
    job.engine = message;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = null;
    if (!message.stopped) {
      report({ type: 'progress', status: 'Recording the clip…', metrics: metrics() });
      videoUrl = await record(job.frames);
      clip = job.frames;
    }
    report({ type: 'done', status: message.stopped ? 'Stopped.' : 'Done.', video: videoUrl, metrics: metrics() });
  }

  /** The frames as a WebM, played into a detached canvas at the clip's rate; its blob URL. */
  async function record(frames) {
    const { width, height } = frames[0];
    const recording = Object.assign(document.createElement('canvas'), { width, height });
    const context = recording.getContext('2d');
    const recorder = new MediaRecorder(recording.captureStream(fps), { mimeType: WEBM_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) });
    const chunks = [];
    recorder.ondataavailable = ({ data }) => chunks.push(data);
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.start();
    for (const frame of frames) {
      context.putImageData(frame, 0, 0);
      await sleep(1000 / fps);
    }
    recorder.stop();
    await stopped;
    return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
  }

  /** Shows the clip's frame `index`, if the clip is finished. */
  function show(index) {
    if (clip?.[index]) draw(clip[index]);
  }

  /** Plays the clip in a loop from the frame on show, one frame per 1 / fps seconds. */
  function startPlayback() {
    if (!clip) return;
    const origin = performance.now() - (inputs.frame.get() * 1000) / fps;
    let shown = -1;
    const tick = () => {
      playback = requestAnimationFrame(tick);
      const index = Math.floor(((performance.now() - origin) * fps) / 1000) % clip.length;
      if (index !== shown) {
        shown = index;
        show(index);
        report({ type: 'frame', index });
      }
    };
    // Not called here: a subscription callback runs inside Rust's update, which a report re-enters.
    playback = requestAnimationFrame(tick);
  }

  function stopPlayback() {
    cancelAnimationFrame(playback);
    playback = null;
  }

  function terminate() {
    stopPlayback();
    for (const bundle of Object.values(bundles)) {
      bundle.worker.terminate();
      bundle.pool.terminate();
    }
  }

  /** The model could not load, or an engine or a compute thread died. */
  function fail(message) {
    broken = true;
    terminate();
    report({ type: 'broken', message });
  }

  function crash(message) {
    fail(`The engine stopped: ${message}.`);
  }

  const bundles = {
    text: start('text'),
    video: start('video'),
  };

  onCleanup(onClicks(inputs.starts, dispatch));
  onCleanup(onClicks(inputs.stops, stop));
  onCleanup(inputs.playing.subscribe((playing) => (playing ? startPlayback() : stopPlayback())));
  onCleanup(inputs.frame.subscribe((index) => !inputs.playing.get() && show(index)));
  onCleanup(() => {
    terminate();
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  });
}

/** Runs `action` once per click a click counter counts, clicks before this module loaded included. */
function onClicks(counter, action) {
  let seen = 0;
  return counter.subscribe((count) => {
    for (; seen < count; seen++) action();
  });
}
