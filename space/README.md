---
title: wan2-1-wasm
short_description: Text to video on your own CPU
sdk: static
app_file: index.html
pinned: false
license: apache-2.0
models:
  - fusorlabs/wan2.1-t2v-1.3b-web
  - Wan-AI/Wan2.1-T2V-1.3B
custom_headers:
  cross-origin-embedder-policy: require-corp
  cross-origin-opener-policy: same-origin
  cross-origin-resource-policy: cross-origin
---

Text to video with Wan-AI's [Wan2.1-T2V-1.3B](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B),
computed on your own CPU in the browser: the model, compiled to WebAssembly with fusor-ai, downloads
once and then runs sealed from the network. Describe a clip and watch its first frame form step by
step, then play the clip back and download it as a WebM. It runs as two instances, one for the text
encoder and one for the video model, so each stays under the 4 GiB a WebAssembly memory can hold;
the prompt never leaves the page. The model is Apache-2.0; its license ships beside the bundle as
`model/LICENSE`. The page's code is MIT; its source is
[github.com/fusor-rs/wan2-1-wasm](https://github.com/fusor-rs/wan2-1-wasm).
