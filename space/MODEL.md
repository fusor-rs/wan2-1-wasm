---
license: apache-2.0
base_model:
  - Wan-AI/Wan2.1-T2V-1.3B
pipeline_tag: text-to-video
library_name: fusor-ai
tags:
  - webassembly
  - wasm
  - on-device
  - text-to-video
---

# Wan2.1-T2V-1.3B, compiled for the browser

Wan-AI's [Wan2.1-T2V-1.3B](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B) compiled into two
[fusor-ai](https://github.com/fusor-rs/fusor-ai) bundles: the weights the browser runtime of
[wan2-1-wasm](https://github.com/fusor-rs/wan2-1-wasm) loads to turn a prompt into a video on the
device's CPU. Try it in the Space
[fusorlabs/wan2-1-wasm](https://huggingface.co/spaces/fusorlabs/wan2-1-wasm).

- **Source:** `Wan-AI/Wan2.1-T2V-1.3B` at revision `37ec512624d61f7aa208f7ea8140a131f93afc9a`,
  compiled with the `mix` profile into two bundles, because one WebAssembly memory holds at most
  4 GiB:
  - `text/`: the umT5-XXL text encoder and its tokenizer, every large matrix 4-bit (3568 MB).
  - `video/`: the diffusion transformer and the VAE's decoder, every large matrix 7-bit
    (1732 MB). The few layers that read straight into or out of pixels stay in f32.
- **Format:** each `manifest.json` lists every tensor and part; each part is named by its BLAKE3
  hash, which the runtime checks as it loads.
- **Reproduce it:** `just model` in wan2-1-wasm downloads the checkpoint and compiles the same
  bundles.

This is not a PyTorch or safetensors checkpoint: it only loads in the wan2-1-wasm runtime.

The model is Apache-2.0 ([LICENSE](LICENSE)).
