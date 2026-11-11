# AGENTS.md

Rules for coding agents in this repository that are its own. fusor-ai's
`vendor/fusor-ai/AGENTS.md` is the standard and binds here too (`CLAUDE.md`
imports both); this file adds what is particular to this product.

wan2-1 is the Wan2.1-T2V-1.3B text-to-video app: Wan-AI's text-to-video
diffusion model (Wan-AI/Wan2.1-T2V-1.3B), running in the browser on the CPU,
sealed from the network, the first frame forming step by step. The README
describes what it does; don't invent scope, features or options beyond the task.

## Repository

- `vendor/fusor-ai/models/wan2-1/runtime`: the wasm-bindgen surface of the
  model, two runtimes of one model (the text encoder's and the video model's:
  bundle parts and a request in, text states, step previews and RGBA frames
  out), each built as four browser runtimes.
- `vendor/fusor-ai/models/wan2-1/cli`: the native CLI `wan2-1` (`compile`,
  `generate`, `bench`, `parity`).
- `app/`: the page, a [fusor](https://github.com/fusor-rs/fusor) app with its own
  Cargo workspace: the form, the loading and the live measurements as Rust
  signals in `src/app.rs`, the template in `web/index.html` on fusor-ai's
  `packages/ui/base.css`, the engine bridge, the canvas and the WebM recording in
  `web/app.js`, and in `engine/` the two workers (`text.js`, `video.js`) on
  fusor-ai's worker kit, beside the runtimes `just runtimes` builds.
- `scripts/`: the checkpoint download (pinned to a revision, sha256-checked),
  the Node smoke test, the site bundle and the README's images;
  `e2e/run.mjs`: the headless Chrome run on fusor-ai's e2e kit.
- [fusor-ai](https://github.com/fusor-rs/fusor-ai): the model (`wan2-1`), its
  compiler (`wan2-1-compile`), the kernels, the blocks (`t5`, `wan_dit`,
  `wan_vae`, `dpm`) and the bundle format come from `vendor/fusor-ai`, a git
  submodule pinned to a commit pushed to fusor-ai, with the browser loader and
  compute pool, the runtime build, the import check and the dev server.

What belongs where: model code (dimensions, tensor names, wiring, the prompt
frontend, the sampler's settings) and anything another model could reuse go to
fusor-ai, following its `AGENTS.md`. This repository holds what turns the model
into an app: the page, the checks against the reference and the deployment. A
change to fusor-ai lands there first; this repository never patches it.

Constraints that hold everywhere:

- fusor-ai comes only from `vendor/fusor-ai`, never a crates.io version, a
  `[patch]` table or a sibling checkout. The submodule moves to another pushed
  fusor-ai commit in a change of its own, with the parity numbers and the e2e
  result it gave. No copies of fusor-ai code here.
- The page owns every capability: drawing on the canvas, recording the WebM,
  caching the bundles (OPFS) and measuring itself. The runtimes receive a
  request and return text states, previews and frames; they do no I/O.
- The model runs as two runtime instances, each in its own worker and memory,
  because umT5-XXL and the video model together do not fit in one wasm32
  memory; the text states cross from one to the other as bytes through the
  page. Each instance's shared memory may grow to 4 GiB (`MAX_MEMORY` in the
  justfile): the text bundle (3.57 GB) with its activations, or the video bundle
  (1.73 GB) with the transformer's activations and the decoder's frame histories
  at the largest request. A change that grows the activations says by how much.
- Generation matches Wan's reference (its own modules, pinned in the justfile)
  stage by stage up to the int8 attention and the quantized weights; frames of
  the same seed differ from the reference's, whose noise comes from torch's
  generator. Say so where a comparison could suggest otherwise.
- The e2e compares the page's frames byte for byte with the same build's
  single-threaded runtime in Node, and `MIN_SPREAD` (every frame a picture) is
  never loosened.
- The model is Apache-2.0. The page, the README and the Space credit Wan-AI,
  with links.

## Checks

A change is done only when this passes:

```sh
just check
```

It runs formatting and Clippy on the page and syntax checks of the scripts;
fusor-ai's `just check` covers the runtimes and the CLI. A change to the
runtimes, the page, the CLI or fusor-ai also needs `just runtimes`, `just
smoke`, `just parity` (the same numbers as before unless the change is meant to
move them) and `just e2e`; a change meant to move speed also needs `just
bench`. The model is checked stage by stage against the reference goldens by
`wan2-1 parity`; extend it rather than adding a parallel harness.

## Commits

- Don't commit, push, tag, release or deploy unless asked. Deploying is
  described in the justfile (`deploy-model`, then `deploy-space`) and is done by
  the maintainer.
