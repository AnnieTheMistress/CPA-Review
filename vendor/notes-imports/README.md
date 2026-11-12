# Browser note import resources

Pinned versions, upstream URLs, tarball SHA256/npm integrity, per-file SHA256 and license declarations are recorded in [manifest.json](manifest.json). Original package licenses/notices and the traineddata upstream license are included. npm language-wrapper metadata declares MIT; upstream traineddata models use Apache-2.0. `4.0.0_best_int` is the integer fast LSTM model family bundled in `@tesseract.js-data` 1.0.0.

From the repository root:

```text
python scripts/vendor_note_imports.py             # verify existing resources; download on initial setup
python scripts/vendor_note_imports.py --verify    # offline per-file SHA256 verification
python scripts/vendor_note_imports.py --refresh   # fetch same pinned archives; reject changed archive hashes
node tests/test_notes_import.js
```

The downloader obtains npm version metadata before archives. SheetJS 0.20.3 comes from the official SheetJS tarball, whose package version is also checked by the Node test. The model-license source is pinned to upstream commit `806cd9adc8c6e8abc11c782db1818c990576bebc`. For that GitHub download only, the script can read the explicitly allowed repository-local `http.https://github.com/.proxy` setting; its value is never printed and no credentials are read.

All runtime files are served from this directory. No CDN fallback or recognition service is used. Keep the directory layout intact when publishing. Serve `.mjs` as JavaScript and `.wasm` as `application/wasm`; allow same-origin scripts/workers and WebAssembly in any site CSP. The importer resolves resources relative to its own script URL, including a site subpath. PDF.js requires a modern browser with ES modules, Web Workers and its supported JavaScript features.

OCR and PDF modules load only when needed. OCR uses local worker, SIMD/non-SIMD LSTM core and gzipped English/Chinese data, with no language cache writes. The original file is not stored by this module: the caller owns attachment persistence.

`extract(file, {pageStart, pageEnd, sheets, signal, onProgress})` reports progress objects `{stage, progress, page?, pages?, sheet?, status?}`. Stage is `start`, `pdf-load`, `pdf-page`, `ocr`, `excel`, or `done`; progress is local to that stage, so a UI should display the stage beside the bar. PDF pages are one-based and inclusive. Omitted page/sheet selections import all. `sheets: []` is an error. Cancellation rejects with `name: 'AbortError'`, other errors have a stable `code`. No partial extracted body is returned as success after failure/cancellation. An initializing Tesseract worker is terminated as soon as its initialization promise exposes it; cancellation immediately rejects the caller and suppresses later progress.

Safety limits: original file 20 MiB; decoded image 40 million pixels; PDF OCR canvas 16 million pixels per page; Excel 200000 cells per selected sheet. Word/Excel parsing runs synchronously inside their third-party parsers and yields between sheets; cancellation is observed at the surrounding asynchronous boundaries. Embedded DOCX images are not OCRed. PDF pages with a usable text layer use that layer; mixed text-plus-image pages are not additionally OCRed. Excel uses existing formatted/cached values, never macros or formula recalculation; merged cells are represented by their anchor and empty covered cells.

Actual Node tests cover Mammoth, SheetJS xlsx/xls, PDF.js text/ranges/encryption/corruption and both Tesseract WASM cores with local models. To run actual OCR tests, install `tesseract.js@6.0.1` in an isolated temporary environment (no app dependency) and set `NOTE_IMPORT_OCR_MODULE` to its installed module path. Without that environment the OCR test is explicitly skipped, never reported as an OCR pass. No real browser integration test has been performed; browser canvas/image decoding, worker startup and deployment headers/CSP still need browser acceptance.
