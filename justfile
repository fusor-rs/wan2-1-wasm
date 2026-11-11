# Wan2.1-T2V-1.3B in the browser. `just ui` builds everything, the models included, and serves the
# page; `just build` then `just serve` do the same in two steps.

import 'vendor/fusor-ai/just/product.just'

name := "wan2-1"
# Each runtime instance's shared memory may grow to all of wasm32's 4 GiB: the text encoder's 3.6 GB
# bundle, or the video bundle with the DiT's activations and the decoder's frame histories.
export MAX_MEMORY := "4294967296"
checkpoint := env_var_or_default("CHECKPOINT", ".cache/checkpoint")
profile := env_var_or_default("PROFILE", "mix")
model_f32 := "dist/model-f32"
goldens := "fixtures/goldens"
# The reference the goldens come from (vendor/fusor-ai/models/wan2-1/reference): Wan2.1's own
# modules at a pinned commit, under pinned packages.
wan_repository := ".cache/Wan2.1"
wan_commit := "9737cba9c1c3c4d04b33fcad41c111989865d315"
reference := "uv run --no-project --python 3.12 --with torch==2.14.1 --with diffusers==0.41.0 --with transformers==5.19.0 --with accelerate==1.15.0 --with safetensors==0.8.0 --with numpy==2.5.4 --with einops==0.8.1 --with ftfy==6.3.1 --with regex==2025.11.3 --with easydict==1.13 python -I"

host:
    bash -n scripts/fetch-checkpoint.sh
    for file in app/web/app.js app/engine/text.js app/engine/video.js scripts/node-smoke.mjs scripts/site-bundle.mjs scripts/render-images.mjs e2e/run.mjs; do node --check "$file" || exit 1; done

# Checks the pinned checkpoint (17.5 GB, sha256, downloading what is missing), then compiles the
# text and video bundles into dist/model, the license beside them.
model: native
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model}}
    target/release/wan2-1 compile {{checkpoint}} {{model}} --profile {{profile}}
    cp {{checkpoint}}/LICENSE.txt {{model}}/LICENSE

# Try it on localhost. The bundles and the runtimes are rebuilt every time (incremental, seconds
# when nothing changed), so they always come from the same fusor-ai.
ui: model runtimes page serve

# Every stage against the reference's goldens, with the f32 bundles.
parity: native
    test -f {{goldens}}/golden_f32.safetensors || just goldens
    scripts/fetch-checkpoint.sh {{checkpoint}}
    rm -rf {{model_f32}}
    target/release/wan2-1 compile {{checkpoint}} {{model_f32}} --profile f32
    target/release/wan2-1 parity {{model_f32}} {{goldens}}/golden_f32.safetensors

# Golden tensors from Wan2.1's reference in f32 on the CPU (about a minute).
goldens:
    scripts/fetch-checkpoint.sh {{checkpoint}}
    test -d {{wan_repository}} || git clone --quiet https://github.com/Wan-Video/Wan2.1.git {{wan_repository}}
    git -C {{wan_repository}} checkout --quiet {{wan_commit}}
    mkdir -p {{goldens}}
    {{reference}} {{fusor_ai}}/models/wan2-1/reference/dump.py {{wan_repository}} {{checkpoint}} {{goldens}}/golden_f32.safetensors

# A video with the native CLI: `just generate --prompt "a red fox in the snow" --frames 9`.
generate *arguments: model
    target/release/wan2-1 generate {{model}} {{arguments}}

bench: model
    target/release/wan2-1 bench {{model}}

images:
    cd vendor/fusor-ai/packages/e2e && npm ci --no-audit --no-fund --silent && npx playwright install chromium
    node scripts/render-images.mjs

site: runtimes page
    rm -rf target/site
    mkdir -p target/site
    cp -R {{app}}/dist/. target/site/
    find target/site -name '.fusor-*.json' -delete
    for bundle in text video; do node scripts/site-bundle.mjs {{model}}/$bundle target/site/model/$bundle || exit 1; done
    cp {{model}}/LICENSE target/site/model/

# The Space holds at most 1 GB, so it gets the page, the runtimes and the license, and the page
# loads the bundles from the model repo fusorlabs/wan2.1-t2v-1.3b-web (`just deploy-model`). The
# Space is created as a static Space first: creating it with the upload makes a Gradio Space,
# which Hugging Face refuses for a free organization.
# The site to the Hugging Face Space fusorlabs/wan2-1-wasm, configured by space/README.md.
deploy-space: site
    #!/usr/bin/env bash
    set -euo pipefail
    rm -rf target/space
    rsync -a --exclude /model target/site/ target/space/
    rsync -a --include '*/' --include 'LICENSE*' --exclude '*' target/site/model/ target/space/model/
    cp space/README.md target/space/
    uv run --no-project --with huggingface_hub==0.36.2 python - target/space <<'PY'
    import sys
    from huggingface_hub import HfApi

    api = HfApi()
    api.create_repo("fusorlabs/wan2-1-wasm", repo_type="space", space_sdk="static", exist_ok=True)
    api.upload_folder(
        repo_id="fusorlabs/wan2-1-wasm",
        repo_type="space",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy wan2-1-wasm {{version}}",
    )
    PY

# Deploy them before the Space whenever a bundle changes: a runtime only loads a bundle compiled
# with the same fusor-ai.
# The site's two bundles, with space/MODEL.md as their card, to the model repo
# fusorlabs/wan2.1-t2v-1.3b-web.
deploy-model: site
    #!/usr/bin/env bash
    set -euo pipefail
    cp space/MODEL.md target/site/model/README.md
    uv run --no-project --with huggingface_hub==0.36.2 python - target/site/model <<'PY'
    import sys
    from huggingface_hub import HfApi

    api = HfApi()
    api.create_repo("fusorlabs/wan2.1-t2v-1.3b-web", exist_ok=True)
    api.upload_folder(
        repo_id="fusorlabs/wan2.1-t2v-1.3b-web",
        folder_path=sys.argv[1],
        delete_patterns="*",
        commit_message="Deploy the wan2-1-wasm {{version}} bundles",
    )
    PY

# No fixed inputs: the e2e makes its reference with the same build's single-threaded runtime in Node.
fixtures:
