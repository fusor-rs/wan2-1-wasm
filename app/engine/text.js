// The text encoder's home: umT5-XXL in a module Worker with its own runtime instance and memory (a
// wasm32 memory holds it or the video model, not both). It turns each prompt into umT5's states,
// which the page hands to the video worker.
//
// Load: fusor-ai's worker kit (`dist/host/worker.js`) starts the best runtime build and streams
// every part of the bundle into it; the runtime checks each part's size and BLAKE3.

import { engine, load, post, requestsSinceReady, serve } from './dist/host/worker.js';

serve({
  load: ({ modelUrl, threads, build }) =>
    load({
      modelUrl,
      threads,
      build,
      glueName: 'wan2_1_runtime',
      className: 'TextRuntime',
      cacheName: 'wan2-1-text',
      distUrl: new URL('./dist/', import.meta.url),
      onRuntime: (started) => post({ type: 'runtime', build: started.build.name, threads: started.threads }),
      onReady: (progress) => post({ type: 'ready', ...progress }),
    }),
  encode: ({ job, prompt, negative }) => {
    const t0 = performance.now();
    const states = { prompt: engine.rt.encode(prompt), negative: engine.rt.encode(negative) };
    post({ type: 'encoded', job, ...states, textMs: performance.now() - t0, networkRequests: requestsSinceReady() }, [states.prompt.buffer, states.negative.buffer]);
  },
});
