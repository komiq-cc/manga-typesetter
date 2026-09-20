<div align="center">

<pre>
█▀▄▀█ ▄▀█ █▄ █ █▀▀ ▄▀█   ▀█▀ █▄█ █▀█ █▀▀ █▀ █▀▀ ▀█▀ ▀█▀ █▀▀ █▀█
█ ▀ █ █▀█ █ ▀█ █▄█ █▀█    █   █  █▀▀ ██▄ ▄█ ██▄  █   █  ██▄ █▀▄

        lettering for scanlation, without Photoshop
</pre>

[![macOS](https://img.shields.io/badge/macOS-Apple%20Silicon-111?logo=apple&logoColor=white)](#install)
[![Windows](https://img.shields.io/badge/Windows-x86__64-0078D4?logo=windows&logoColor=white)](#install)
[![Linux](https://img.shields.io/badge/Linux-x86__64%20%7C%20ARM64-FCC624?logo=linux&logoColor=black)](#install)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![Svelte](https://img.shields.io/badge/Svelte-5-FF3E00?logo=svelte&logoColor=white)](https://svelte.dev)
[![latest](https://img.shields.io/badge/latest-v0.3.1-E8A33D)](https://typesetter.komiq.cc)
[![license](https://img.shields.io/badge/license-MIT-6E8CBF)](LICENSE.md)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/vhuYWbZNX5)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/komiq)

</div>

A desktop app that puts translated lettering into speech balloons. Light on
memory, works over hundreds of pages, no Photoshop needed.

**[Download](https://typesetter.komiq.cc)** · **[User guide (HOWTO)](HOWTO.md)**

> Public beta. In daily use, but expect rough edges.

![The editor](.github/readme/editor.png)

## Recommended use

Translators work in **translate** mode: translate each bubble and tag it
(tagging shortcuts are still in progress). Typesetters then set a font per tag,
place the text boxes, and tune them. Auto placement can be turned off.

## Features

- Text box detection and auto placement
- **Tags**, so you stop scrolling the font list for every line. Tags are saved
  per project, so the first tagging pass is the slow one
- Auto fit to balloon. It is flaky, so it can be turned off in Settings, or per
  bubble with a shortcut
- Autosave
- Bulk restyle by tag or by selection, for when you change your mind
- Effects: transform (warp), stacked strokes and shadows, text clipping
  (untested), circular curve, arc, a controllable curve for wavy text, motion
  blur and normal blur, font roughening, text mask clipping
- Fills: solid, pattern and gradient (a better colour picker is in progress)
- The normal layout controls you expect
- Export to PNG, JPG, WebP or JSON, per page or per chapter
- Auto updates
- Low resource use, with heavy offloading to disk

> **Do not use PSD export yet.** It is unfinished, and low priority, because it
> is genuinely hard.

## Install

Grab the installer from **<https://typesetter.komiq.cc>**.

- macOS (Apple Silicon): open the `.dmg`, drag the app to Applications. The
  bundle is not notarised yet, so first launch needs right-click > **Open**.
- Windows: run the setup `.exe`.
- Linux (x86_64 or ARM64): choose the download matching your architecture.
  Install the `.deb`, or mark the `.AppImage`
  executable and run it. Both use your distro's GTK 3 and WebKitGTK 4.1
  (the `.deb` pulls them in; the AppImage tells you the install command if
  they are missing: `libwebkit2gtk-4.1-0` on Debian and Ubuntu,
  `webkit2gtk4.1` on Fedora, `webkit2gtk-4.1` on Arch).
  - The Linux builds need glibc 2.39 or newer: Ubuntu 24.04, Mint 22, Fedora
    39, Debian 13, Arch, or anything newer. On an older distro it refuses to
    start with `version 'GLIBC_2.39' not found`, and there is no build that
    does: the floor comes from the prebuilt ONNX Runtime, which is compiled
    against glibc 2.38 with or without a GPU feature. Reaching Ubuntu 22.04 or
    Debian 12 would take a Flatpak, which carries its own runtime.
  - The x86_64 build uses WebGPU over Vulkan when a usable driver is there and
    the CPU when it is not. The ARM64 build is CPU-only because its prebuilt
    ONNX Runtime has no WebGPU or CUDA provider.

  `ldd --version` prints your glibc version.

Updates arrive in-app and are signature-verified. Each Linux build only
updates to its own kind.

## Build from source

Requires [Node](https://nodejs.org) 20+ and a [Rust toolchain](https://rustup.rs)
(see the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)).

```sh
git clone https://github.com/komiq-cc/manga-typesetter.git
cd manga-typesetter
npm install

npm run tauri dev     # run it
npm run tauri build   # bundle in src-tauri/target/release/bundle
npm test              # vitest
```

Detection models download on first use and are cached under your home
directory; nothing ships in the bundle. Chinese and Korean recognizers can be
selected independently under **Settings → System → Models**. PP-OCRv6 Medium
is the quality-first Chinese default. Korean defaults to the Korean-specific
PP-OCRv5 model; PP-OCRv6 does not support Korean. Alternate smaller or legacy
models remain available.

### GPU

Detection and OCR run on the GPU where one is usable, falling back to CPU per
model, and the settings dialog names the device in use:

- macOS: CoreML.
- Windows: CUDA on NVIDIA machines with CUDA 13 and cuDNN 9 installed,
  otherwise DirectML (any GPU, nothing to install).
- Linux: WebGPU over Vulkan (any GPU, nothing to install), CPU when there is
  no usable driver. An NVIDIA-only CUDA build exists for people with CUDA 13 +
  cuDNN 9, and is faster than WebGPU on those machines:

  ```sh
  npm run tauri build -- --features gpu-cuda --config src-tauri/tauri.linux-cuda.conf.json
  ```

  Plain `cargo build` on Linux has no GPU provider; pass `--features gpu-webgpu`
  or `gpu-cuda`, not both. The WebGPU feature only links on a host with glibc
  2.38+ and GCC 13's libstdc++ (Ubuntu 24.04 or newer).

Set `MT_DEVICE=cpu` (or `cuda`, `directml`, `webgpu`, `coreml`) before
launching to pin a device when a driver misbehaves. The first device probe
runs in a helper copy of the app (`app --probe-device`), so a driver that
aborts while starting up only kills that helper; detection then stays on CPU
for the rest of the run and the log says why.

On Linux the app switches WebKit's DMA-BUF renderer off when the NVIDIA
proprietary driver is loaded (a blank window otherwise). Set
`WEBKIT_DISABLE_DMABUF_RENDERER=0` before launching to force it back on; the
app leaves the variable alone when it is already set.

The AppImage bundles no GTK or WebKit on purpose: it uses the host's, exactly
like the `.deb`, so WebKit's UI process and its helper processes are always the
same version on every distro. `scripts/build-appimage.sh` explains why.

## Built with

[Svelte 5](https://svelte.dev) · [Vite](https://vite.dev) ·
[Tauri 2](https://tauri.app) · [ag-psd](https://github.com/Agamnentzar/ag-psd) ·
[hypher](https://github.com/bramstein/hypher) ·
[ONNX Runtime](https://onnxruntime.ai) via [`ort`](https://ort.pyke.io)

Detection models from
[deepghs/manga109_yolo](https://huggingface.co/deepghs/manga109_yolo) and
[kha-white/manga-ocr](https://github.com/kha-white/manga-ocr), plus PP-OCRv4/v5
Korean and PP-OCRv5/v6 Chinese recognizers published by
[RapidOCR](https://github.com/RapidAI/RapidOCR). No model weights ship in the
app - they download on first use from a byte-for-byte RapidOCR mirror, and
each carries its publisher's own terms rather than this project's.

## License

[MIT](LICENSE.md) © 2026 k-omiq

Third-party licenses and notices are in [THIRD-PARTY.md](THIRD-PARTY.md).
