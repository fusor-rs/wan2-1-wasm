// The video model's home: the diffusion transformer and the video decoder in a module Worker with
// their own runtime instance and memory.
//
// Load: fusor-ai's worker kit (`dist/host/worker.js`) starts the best runtime build and streams
// every part of the bundle into it; the runtime checks each part's size and BLAKE3.
//
// Generate: `start()` takes the text encoder's states, then one `step()` per macrotask, so a stop
// request is seen between steps. Each call is a denoising step, which the page gets a preview of
// the first frame after, or a latent frame decoded, whose video frames the page gets.
//
// After the model is loaded nothing else is fetched: generation is entirely local.

import { engine, load, post, requestsSinceReady, serve, yieldTask } from './dist/host/worker.js';

const RGBA = 4;

let stoppedJob = null;

serve({
  load: ({ modelUrl, threads, build }) =>
    load({
      modelUrl,
      threads,
      build,
      glueName: 'wan2_1_runtime',
      className: 'VideoRuntime',
      cacheName: 'wan2-1-video',
      distUrl: new URL('./dist/', import.meta.url),
      onRuntime: (started) => {
        post({ type: 'runtime', build: started.build.name, threads: started.threads, fps: started.glue.fps() });
      },
      onReady: (progress) => post({ type: 'ready', ...progress }),
    }),
  generate,
  stop: ({ job }) => (stoppedJob = job),
});

async function generate({ job, request, prompt, negative }) {
  const { rt } = engine;
  let t0 = performance.now();
  const plan = JSON.parse(rt.start(request, prompt, negative));
  const timing = { computeMs: performance.now() - t0, decodeMs: 0, step: 0 };
  const finish = (stopped) => post({ type: 'done', job, stopped, ...timing, networkRequests: requestsSinceReady() });
  post({ type: 'started', job, plan, ...timing });
  for (;;) {
    await yieldTask();
    if (stoppedJob === job) {
      rt.cancel();
      return finish(true);
    }
    t0 = performance.now();
    const progress = JSON.parse(rt.step());
    const denoising = progress.decoded === 0;
    const preview = denoising && progress.step < progress.steps ? { width: plan.width, height: plan.height, pixels: rt.preview() } : null;
    const stepMs = performance.now() - t0;
    timing.computeMs += stepMs;
    timing.step = progress.step;
    if (denoising) {
      post({ type: 'step', job, preview, ...timing, networkRequests: requestsSinceReady() }, preview ? [preview.pixels.buffer] : []);
      continue;
    }
    timing.decodeMs += stepMs;
    const pixels = rt.take_frames();
    const frames = { width: plan.width, height: plan.height, count: pixels.length / (plan.width * plan.height * RGBA), pixels };
    post({ type: 'frames', job, frames, ...timing, networkRequests: requestsSinceReady() }, [pixels.buffer]);
    if (progress.done) return finish(false);
  }
}
