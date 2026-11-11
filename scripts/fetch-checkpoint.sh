#!/usr/bin/env bash
# Checks what `wan2-1 compile` and the reference read in $1 against the pinned sha256s, downloading
# any file missing (17.5 GB in all): Wan-AI/Wan2.1-T2V-1.3B's DiT, umT5-XXL encoder, autoencoder,
# config, license and umT5 tokenizer files.
set -euo pipefail
DIR="$1"
MODEL="https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B/resolve/37ec512624d61f7aa208f7ea8140a131f93afc9a"
FILES="
96b6b242ca1c2f24e9d02cd6596066fab6d310e2d7538f33ae267cb18d957e8f  diffusion_pytorch_model.safetensors  $MODEL
7cace0da2b446bbbbc57d031ab6cf163a3d59b366da94e5afe36745b746fd81d  models_t5_umt5-xxl-enc-bf16.pth  $MODEL
38071ab59bd94681c686fa51d75a1968f64e470262043be31f7a094e442fd981  Wan2.1_VAE.pth  $MODEL
ab37994c43740513f94b3ba6233a784035a67b43c8cde83c8f31aa90468c67ce  config.json  $MODEL
c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4  LICENSE.txt  $MODEL
6e197b4d3dbd71da14b4eb255f4fa91c9c1f2068b20a2de2472967ca3d22602b  google/umt5-xxl/tokenizer.json  $MODEL
ed9a3a8b0faa71a70a32847e0435fe036e6e112d4df4edb7bb48a921e344dc05  google/umt5-xxl/tokenizer_config.json  $MODEL
7b8a9f5040adb67b5805abdfd42c1f8d0f3d0e711f10726580eb3789cd0ad61d  google/umt5-xxl/special_tokens_map.json  $MODEL
e3909a67b780650b35cf529ac782ad2b6b26e6d1f849d3fbb6a872905f452458  google/umt5-xxl/spiece.model  $MODEL
"
mkdir -p "$DIR/google/umt5-xxl"
while read -r _ file base; do
  if [ -z "$file" ] || [ -s "$DIR/$file" ]; then continue; fi
  echo "downloading $file"
  curl -fsSL --retry 3 -o "$DIR/$file.part" "$base/$file"
  mv "$DIR/$file.part" "$DIR/$file"
done <<< "$FILES"
(cd "$DIR" && awk 'NF { print $1 "  " $2 }' <<< "$FILES" | shasum -a 256 -c --quiet -)
