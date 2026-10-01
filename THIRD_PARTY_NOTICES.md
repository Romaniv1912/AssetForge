# Third-party components

AssetForge is licensed under GPL-3.0-or-later (see `LICENSE`) because it
bundles libimagequant. Other bundled or downloaded components:

| Component | Used for | Licence |
| --- | --- | --- |
| [libimagequant](https://github.com/ImageOptim/libimagequant) via [libimagequant-wasm](https://github.com/akshetpandey/libimagequant-wasm) | PNG / WebP palette quantisation | GPL-3.0-or-later (wrapper: MIT) |
| [jSquash](https://github.com/jamsinclair/jSquash) codecs (Squoosh builds) | JPEG, WebP, AVIF, PNG, oxipng, resize | Apache-2.0 |
| ↳ MozJPEG / libjpeg-turbo | JPEG | IJG / BSD-3-Clause |
| ↳ libwebp | WebP | BSD-3-Clause |
| ↳ libavif, libaom, dav1d | AVIF | BSD-2-Clause |
| ↳ oxipng | PNG optimisation | MIT |
| [image-q](https://github.com/ibezkrovnyi/image-quantization) | fallback quantiser (Wu) | MIT |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | background-removal inference (downloaded on first use) | MIT |
| [BRIA RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) | background-removal model (downloaded on first use) | bria-rmbg-1.4, **non-commercial use only** |
| [BiRefNet lite](https://github.com/ZhengPeng7/BiRefNet) | background-removal model, WebGPU (downloaded on first use) | MIT |
| [fflate](https://github.com/101arrowz/fflate) | ZIP export, zlib | MIT |
| [React](https://react.dev) | UI | MIT |
| [Inter](https://rsms.me/inter/) (Google Fonts) | UI font | SIL OFL 1.1 |

Sample images in `fixtures/images/` come from scikit-image; see `fixtures/README.md`.
