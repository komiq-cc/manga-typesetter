# Third-party notices

Manga Typesetter is [MIT](LICENSE.md) licensed. It builds on open-source
components that carry their own licenses and copyright notices, reproduced
below as those licenses require.

This file covers what the distributed application contains or fetches. It is
not a full transitive dependency list - the Rust side alone resolves to a few
hundred crates. `npm ls` and `cargo tree` produce those; what follows is the
set with terms worth stating.

## Bundled JavaScript

| Component | Version | License | Copyright |
| --- | --- | --- | --- |
| [ag-psd](https://github.com/Agamnentzar/ag-psd) | 31.0.2 | MIT | © 2016 Agamnentzar |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT | © 2026 Arjun Barrett |
| [hypher](https://github.com/bramstein/hypher) | 0.2.5 | BSD-3-Clause | © 2011 Bram Stein |
| [hyphenation.en-us](https://github.com/bramstein/hyphenation-patterns) | 0.2.1 | see below | Bram Stein |
| [Svelte](https://svelte.dev) | 5.x | MIT | © Svelte contributors |

`hypher` is BSD-3-Clause. Its terms require this notice to accompany binary
distributions:

> Copyright (c) 2011, Bram Stein
> All rights reserved.
>
> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice,
>    this list of conditions and the following disclaimer.
> 2. Redistributions in binary form must reproduce the above copyright notice,
>    this list of conditions and the following disclaimer in the documentation
>    and/or other materials provided with the distribution.
> 3. The name of the author may not be used to endorse or promote products
>    derived from this software without specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE AUTHOR "AS IS" AND ANY EXPRESS OR IMPLIED
> WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
> MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO
> EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
> SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
> PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS;
> OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
> WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
> OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
> ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

`hyphenation.en-us` ships the en-US Liang hyphenation patterns and declares no
license of its own. Its source header points at the TeX hyphenation repository
(`tug.org/svn/texhyphen`), whose en-US patterns are distributed without
restriction. The package is used unmodified, for pattern data only.

## Ported code

The bubble-outline finder (`src/lib/bubble-outline.js`) is a JavaScript port
of the outline ladder in [Komatose](https://github.com/innominata/komatose)
(`ocr/workflow.py`, commit `d9be51e`), which is MIT licensed:

> MIT License
>
> Copyright (c) 2026 innominata
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Bundled Rust

The desktop shell is [Tauri 2](https://tauri.app) (MIT / Apache-2.0). Its
dependency graph resolves to roughly 580 crates. Every one is permissive:
MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0, or a dual license including one
of those. There is no GPL, LGPL, or AGPL code in the build.

Five crates are MPL-2.0, reached through Tauri's CSS handling and its
directory lookups:

- `cssparser` 0.36.0
- `cssparser-macros` 0.6.1
- `selectors` 0.36.1
- `dtoa-short` 0.3.5
- `option-ext` 0.2.0

MPL-2.0 is per-file copyleft. These crates are used unmodified, so naming them
here and pointing to their source repositories satisfies the license:
<https://github.com/servo/rust-cssparser>, <https://github.com/servo/stylo>,
<https://github.com/upsuper/dtoa-short>, <https://github.com/soc/option-ext>.
Their source is available under MPL-2.0 from those repositories.

Also worth noting:

- [ONNX Runtime](https://onnxruntime.ai), MIT, © Microsoft Corporation.
  Prebuilt binaries are fetched at build time by
  [`ort`](https://ort.pyke.io) and shipped inside the application.
- [SQLite](https://sqlite.org), public domain. Compiled in through
  `rusqlite`'s bundled amalgamation, used read-only to parse `.sut` brush
  files.

## Machine-learning models

No model weights are distributed with the application. The app downloads them
on first use into the user's cache. PaddleOCR/RapidOCR ONNX files come from a
byte-for-byte Hugging Face mirror of RapidOCR v3.9.2 because ModelScope rejects
the desktop HTTP client. Each model is governed by its publisher's terms, not
by this project's license.

| Model | Source | Terms |
| --- | --- | --- |
| manga109 YOLO detector | [deepghs/manga109_yolo](https://huggingface.co/deepghs/manga109_yolo) | YOLO11 lineage; Ultralytics applies AGPL-3.0 to its models |
| comic text detector | [manga-image-translator](https://github.com/zyddnys/manga-image-translator) | published from a GPL-3.0 repository |
| manga-ocr-base | [kha-white/manga-ocr](https://github.com/kha-white/manga-ocr), [ONNX build](https://huggingface.co/onnx-community/manga-ocr-base-ONNX) | Apache-2.0 |
| PP-OCRv4/v5 Korean and PP-OCRv5/v6 Chinese recognition | [RapidOCR](https://github.com/RapidAI/RapidOCR), derived from [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR); [download mirror](https://huggingface.co/DjB314/RapidOCR) | Apache-2.0 |

The application runs these as ONNX graphs through `ort`. It does not link,
vendor, or redistribute the Ultralytics package or any other AGPL or GPL code.

## Fonts

No fonts are bundled. The interface uses the operating system's font
stack, and lettering uses fonts already installed on the user's machine.
