/* Local-only note extraction. No file contents leave the browser.
 * Public API: await inspect(File|Blob), await extract(File|Blob, options).
 * onProgress receives {stage, progress: 0..1, page?, pages?, sheet?}.
 * AbortSignal rejects with AbortError; failed extraction never reports success.
 */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReviewNoteImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const MAX_BYTES = 20 * 1024 * 1024;
  const node = typeof module === 'object' && !!module.exports;
  const scriptURL = !node && root.document && (root.document.currentScript && root.document.currentScript.src || root.document.baseURI);
  const loads = new Map();
  const attachmentWarning = '未提取正文：此文件仅作为原附件保存；旧版 .doc 请另存为 .docx 后重新导入。';
  const excelWarning = 'Excel 仅导入文件内已有的显示值；不执行宏，不重新计算公式，缓存值可能过期。';

  function failure(message, code) { const e = new Error(message); e.code = code; return e; }
  function abortError() { const e = new Error('导入已取消'); e.name = 'AbortError'; return e; }
  function checkAbort(signal) { if (signal && signal.aborted) throw abortError(); }
  function abortable(promise, signal, cleanup) {
    checkAbort(signal);
    if (!signal) return Promise.resolve(promise);
    return new Promise((resolve, reject) => {
      const abort = () => { try { if (cleanup) cleanup(); } catch (_) {} reject(abortError()); };
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  function progress(options, event) {
    checkAbort(options.signal);
    if (typeof options.onProgress === 'function') options.onProgress(event);
    checkAbort(options.signal);
  }
  function validateFile(file) {
    if (!file || typeof file.arrayBuffer !== 'function' || typeof file.slice !== 'function' || !Number.isFinite(file.size)) throw failure('请选择浏览器 File 或 Blob 文件。', 'INVALID_FILE');
    if (file.size > MAX_BYTES) throw failure('文件超过 20MB 上限，请拆分或压缩后导入。', 'FILE_TOO_LARGE');
    if (!file.size) throw failure('文件为空，无法提取正文。', 'EMPTY_FILE');
  }
  function classify(file) {
    validateFile(file);
    const name = String(file.name || '').toLowerCase();
    const extension = name.includes('.') ? name.split('.').pop() : '';
    const extensions = { docx: 'word', doc: 'attachment', pdf: 'pdf', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', xlsx: 'excel', xls: 'excel' };
    if (extension) return extensions[extension] || 'attachment';
    return ({ 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word', 'application/pdf': 'pdf', 'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'excel', 'application/vnd.ms-excel': 'excel' })[file.type] || 'attachment';
  }
  async function bytes(file, signal) { checkAbort(signal); const data = await abortable(file.arrayBuffer(), signal); checkAbort(signal); return data; }
  async function verifySignature(file, kind, signal) {
    const b = new Uint8Array(await bytes(file.slice(0, 1024), signal));
    const starts = a => a.every((v, i) => b[i] === v);
    const zip = starts([0x50, 0x4b, 3, 4]);
    const ole = starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const ascii = new TextDecoder('latin1').decode(b);
    const ok = kind === 'word' ? zip : kind === 'excel' ? zip || ole : kind === 'pdf' ? ascii.includes('%PDF-') : kind === 'image' ? starts([137,80,78,71,13,10,26,10]) || starts([255,216,255]) || (ascii.startsWith('RIFF') && ascii.slice(8,12) === 'WEBP') : true;
    if (!ok) throw failure('文件内容与格式不符或文件已损坏，请重新导出后导入。', 'INVALID_FORMAT');
  }
  function asset(relative) {
    if (node) return require('node:url').pathToFileURL(require('node:path').join(__dirname, 'vendor/notes-imports', relative)).href;
    if (!scriptURL) throw failure('无法确定导入资源路径。', 'DEPENDENCY_LOAD_FAILED');
    return new URL('vendor/notes-imports/' + relative, scriptURL).href;
  }
  function script(relative, globalName) {
    const url = asset(relative);
    if (!loads.has(url)) {
      const promise = new Promise((resolve, reject) => {
        const el = root.document.createElement('script');
        el.src = url; el.async = true;
        el.onload = () => root[globalName] ? resolve(root[globalName]) : reject(failure('导入依赖未正确初始化：' + relative, 'DEPENDENCY_LOAD_FAILED'));
        el.onerror = () => { el.remove(); reject(failure('无法加载本地导入依赖：' + relative + '；请检查离线资源或站点部署。', 'DEPENDENCY_LOAD_FAILED')); };
        root.document.head.appendChild(el);
      });
      loads.set(url, promise);
      promise.catch(() => loads.delete(url));
    }
    return loads.get(url);
  }
  async function dependency(kind) {
    try {
      if (kind === 'word') return node ? require('./vendor/notes-imports/mammoth/mammoth.browser.min.js') : await script('mammoth/mammoth.browser.min.js', 'mammoth');
      if (kind === 'excel') return node ? require('./vendor/notes-imports/sheetjs/dist/xlsx.full.min.js') : await script('sheetjs/dist/xlsx.full.min.js', 'XLSX');
      if (kind === 'ocr') {
        if (node) throw failure('图片 OCR 需要浏览器 canvas/worker；Node 实际 OCR 验证请运行独立验证脚本。', 'BROWSER_REQUIRED');
        return await script('tesseract/dist/tesseract.min.js', 'Tesseract');
      }
      if (kind === 'pdf') {
        const url = asset('pdfjs/build/pdf.min.mjs');
        if (!loads.has(url)) { const p = import(url); loads.set(url, p); p.catch(() => loads.delete(url)); }
        const pdfjs = await loads.get(url);
        pdfjs.GlobalWorkerOptions.workerSrc = asset('pdfjs/build/pdf.worker.min.mjs');
        return pdfjs;
      }
    } catch (error) {
      if (error.code) throw error;
      throw failure('无法加载本地 ' + kind + ' 导入依赖：' + error.message, 'DEPENDENCY_LOAD_FAILED');
    }
  }
  function pageRange(total, start, end) {
    const parse = (v, fallback) => v === undefined ? fallback : typeof v === 'number' ? v : typeof v === 'string' && /^[1-9]\d*$/.test(v) ? Number(v) : NaN;
    start = parse(start, 1); end = parse(end, total);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end > total || end < start) throw failure('PDF 页码范围无效；请输入 1 到 ' + total + ' 之间的起止页码。', 'INVALID_PAGE_RANGE');
    return { start, end };
  }
  function selectedSheets(names, requested) {
    if (requested === undefined) return names.slice();
    if (!Array.isArray(requested) || !requested.length || requested.some(n => typeof n !== 'string' || !names.includes(n))) throw failure('请选择至少一张存在的工作表。', 'INVALID_SHEETS');
    return [...new Set(requested)];
  }
  function markdownCell(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>'); }
  function tableMarkdown(rows) {
    if (!rows.length) return '';
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    if (!width) return '';
    const line = row => '| ' + Array.from({ length: width }, (_, i) => markdownCell(row[i])).join(' | ') + ' |';
    return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
  }
  async function workbook(file, options) {
    const xlsx = await abortable(dependency('excel'), options.signal);
    const data = await bytes(file, options.signal);
    try {
      const book = xlsx.read(data, { type: 'array', cellText: true, cellDates: false, cellFormula: true, bookVBA: false, WTF: false });
      if (!book.SheetNames.length) throw new Error('没有工作表');
      checkAbort(options.signal);
      return { xlsx, book };
    } catch (e) { if (e.name === 'AbortError') throw e; throw failure('Excel 解析失败（可能已加密或损坏）：' + e.message, 'EXCEL_PARSE_FAILED'); }
  }
  async function openPDF(file, options) {
    const pdfjs = await abortable(dependency('pdf'), options.signal);
    const data = new Uint8Array(await bytes(file, options.signal));
    const task = pdfjs.getDocument({ data, cMapUrl: asset('pdfjs/cmaps/'), cMapPacked: true, standardFontDataUrl: asset('pdfjs/standard_fonts/'), isEvalSupported: false, useSystemFonts: true });
    const destroy = () => { Promise.resolve(task.destroy()).catch(() => {}); };
    const onAbort = () => destroy();
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    let rejectProgress;
    const progressError = new Promise((_, reject) => { rejectProgress = reject; });
    task.onProgress = info => {
      if (options.signal && options.signal.aborted) return;
      try { progress(options, { stage: 'pdf-load', progress: info.total ? Math.min(1, info.loaded / info.total) : 0 }); }
      catch (e) { rejectProgress(e); destroy(); }
    };
    try {
      const doc = await abortable(Promise.race([task.promise, progressError]), options.signal, destroy);
      checkAbort(options.signal);
      return { doc, close: async () => { if (options.signal) options.signal.removeEventListener('abort', onAbort); await task.destroy(); } };
    } catch (e) {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      destroy();
      if (e.name === 'AbortError') throw e;
      if (e.name === 'PasswordException') throw failure('PDF 已加密，需要先解除密码保护再导入。', 'PDF_PASSWORD');
      throw failure('PDF 解析失败，文件可能损坏：' + e.message, 'PDF_PARSE_FAILED');
    }
  }
  function pdfText(items) {
    let text = '', previousY;
    for (const item of items) {
      if (typeof item.str !== 'string') continue;
      const y = item.transform && item.transform[5];
      if (text && previousY !== undefined && y !== undefined && Math.abs(y - previousY) > 3 && !text.endsWith('\n')) text += '\n';
      else if (text && !text.endsWith('\n') && !text.endsWith(' ')) text += ' ';
      text += item.str;
      if (item.hasEOL) text += '\n';
      previousY = y;
    }
    return text.trim();
  }
  async function ocrSession(options) {
    const tess = await abortable(dependency('ocr'), options.signal);
    let worker, timer, rejectWorker, disposed = false;
    const workerError = new Promise((_, reject) => { rejectWorker = reject; });
    const terminate = () => { disposed = true; if (worker) Promise.resolve(worker.terminate()).catch(() => {}); };
    const onAbort = () => terminate();
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      timer = setTimeout(() => rejectWorker(failure('OCR 本地资源加载超时，请检查 worker、wasm 和语言包是否完整。', 'OCR_LOAD_FAILED')), 120000);
      const creation = tess.createWorker(['chi_sim', 'eng'], 1, {
        workerPath: asset('tesseract/dist/worker.min.js'), corePath: asset('tesseract-core/'), langPath: asset('lang/'),
        workerBlobURL: false, gzip: true, cacheMethod: 'none',
        logger: info => {
          if (!disposed && (!options.signal || !options.signal.aborted)) {
            try { progress(options, { stage: 'ocr', status: info.status, progress: Math.max(0, Math.min(1, info.progress || 0)) }); }
            catch (e) { rejectWorker(e); terminate(); }
          }
        },
        errorHandler: e => rejectWorker(failure('OCR 失败，无法加载资源或识别图片：' + (e.message || e), 'OCR_FAILED')),
      });
      creation.then(w => { worker = w; if (disposed || options.signal && options.signal.aborted) terminate(); }, () => {});
      worker = await abortable(Promise.race([creation, workerError]), options.signal, terminate);
      clearTimeout(timer);
      return {
        recognize: async image => {
          checkAbort(options.signal);
          try {
            const result = await abortable(Promise.race([worker.recognize(image), workerError]), options.signal, terminate);
            checkAbort(options.signal);
            return { text: String(result.data.text || '').trim(), confidence: result.data.confidence };
          } catch (e) { if (e.name === 'AbortError' || e.code) throw e; throw failure('图片识别失败：' + e.message, 'OCR_FAILED'); }
        },
        close: async () => { disposed = true; if (options.signal) options.signal.removeEventListener('abort', onAbort); await worker.terminate(); },
      };
    } catch (e) {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      terminate();
      // If worker initialization finishes after failure, dispose it as well.
      if (e.name === 'AbortError' || e.code) throw e;
      throw failure('OCR 初始化失败：' + e.message, 'OCR_LOAD_FAILED');
    }
  }
  async function decodeImage(file, signal) {
    if (!root.document) throw failure('图片解码需要浏览器。', 'BROWSER_REQUIRED');
    const url = URL.createObjectURL(file), img = new root.Image();
    try {
      await abortable(new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(failure('图片损坏或浏览器不支持此格式，请转换为 PNG/JPEG/WebP。', 'IMAGE_DECODE_FAILED')); img.src = url; }), signal, () => { img.src = ''; });
      if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 40000000) throw failure('图片像素过大或尺寸无效，请缩小后导入。', 'IMAGE_SIZE');
      return { image: img, close: () => { URL.revokeObjectURL(url); img.src = ''; } };
    } catch (e) { URL.revokeObjectURL(url); throw e; }
  }
  function ocrWarnings(result, label) {
    if (!result.text) return [label + '未识别到文字；请检查清晰度，或手动填写正文。'];
    return result.confidence < 60 ? [label + '识别置信度较低，请核对并修改文字。'] : [];
  }
  async function inspect(file) {
    const kind = classify(file);
    await verifySignature(file, kind);
    if (kind === 'attachment') return { kind, warnings: [attachmentWarning] };
    if (kind === 'pdf') { const handle = await openPDF(file, {}); try { return { kind, pages: handle.doc.numPages, warnings: [] }; } finally { await handle.close(); } }
    if (kind === 'excel') { const { book } = await workbook(file, {}); return { kind, sheets: book.SheetNames.slice(), warnings: [excelWarning] }; }
    return { kind, warnings: [] };
  }
  async function extract(file, options = {}) {
    options = options || {};
    checkAbort(options.signal);
    const kind = classify(file);
    await verifySignature(file, kind, options.signal);
    const title = String(file.name || '导入笔记').replace(/\.[^.]+$/, '');
    progress(options, { stage: 'start', progress: 0 });
    let result;
    if (kind === 'attachment') result = { body: '', warnings: [attachmentWarning] };
    if (kind === 'word') {
      const mammoth = await abortable(dependency('word'), options.signal);
      try {
        const parsed = await abortable(mammoth.extractRawText({ arrayBuffer: await bytes(file, options.signal) }), options.signal);
        const body = parsed.value.trim();
        result = { body, warnings: parsed.messages.map(m => m.message) };
        if (!body) result.warnings.push('Word 中没有可提取正文；嵌入的扫描图片需另存图片后识别。');
      } catch (e) { if (e.name === 'AbortError') throw e; throw failure('Word 正文提取失败，文件可能已加密或损坏：' + e.message, 'WORD_PARSE_FAILED'); }
    }
    if (kind === 'excel') {
      const { xlsx, book } = await workbook(file, options);
      const names = selectedSheets(book.SheetNames, options.sheets), parts = [], warnings = [excelWarning];
      for (let i = 0; i < names.length; i++) {
        checkAbort(options.signal);
        const name = names[i], sheet = book.Sheets[name];
        if (sheet['!ref']) {
          const range = xlsx.utils.decode_range(sheet['!ref']);
          if ((range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > 200000) throw failure('工作表过大（超过 200000 个单元格），请拆分后导入。', 'SHEET_TOO_LARGE');
          const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '', blankrows: true });
          if (rows.some(row => row.some(value => value !== ''))) parts.push('## ' + markdownCell(name).replace(/([#*_`\[\]])/g, '\\$1') + '\n\n' + tableMarkdown(rows));
          else warnings.push('工作表“' + name + '”为空。');
          if (Object.values(sheet).some(cell => cell && cell.f && cell.v === undefined)) warnings.push('工作表“' + name + '”有公式缺少缓存显示值，对应单元格留空。');
        } else warnings.push('工作表“' + name + '”为空。');
        progress(options, { stage: 'excel', progress: (i + 1) / names.length, sheet: name });
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      result = { body: parts.join('\n\n'), warnings };
    }
    if (kind === 'image') {
      const decoded = await decodeImage(file, options.signal);
      let ocr;
      try { ocr = await ocrSession(options); const recognized = await ocr.recognize(decoded.image); result = { body: recognized.text, warnings: ocrWarnings(recognized, '图片') }; }
      finally { decoded.close(); if (ocr) await ocr.close(); }
    }
    if (kind === 'pdf') {
      const handle = await openPDF(file, options);
      let ocr;
      try {
        const { start, end } = pageRange(handle.doc.numPages, options.pageStart, options.pageEnd);
        const parts = [], warnings = ['实际导入 PDF 第 ' + start + '–' + end + ' 页（共 ' + handle.doc.numPages + ' 页）。'];
        for (let n = start; n <= end; n++) {
          checkAbort(options.signal);
          const page = await abortable(handle.doc.getPage(n), options.signal);
          try {
            let text = pdfText((await abortable(page.getTextContent(), options.signal)).items);
            if (!text) {
              if (!root.document) throw failure('此 PDF 页面需要浏览器 canvas 和 OCR。', 'BROWSER_REQUIRED');
              const viewport = page.getViewport({ scale: 2 });
              if (viewport.width * viewport.height > 16000000) throw failure('PDF 页面尺寸过大，请缩小后识别。', 'PDF_PAGE_SIZE');
              const canvas = root.document.createElement('canvas');
              canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
              try {
                const renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
                await abortable(renderTask.promise, options.signal, () => renderTask.cancel());
                if (!ocr) ocr = await ocrSession(options);
                const recognized = await ocr.recognize(canvas); text = recognized.text;
                warnings.push('PDF 第 ' + n + ' 页使用文字识别，请核对结果。', ...ocrWarnings(recognized, '第 ' + n + ' 页'));
              } finally { canvas.width = canvas.height = 0; }
            }
            parts.push('## 第 ' + n + ' 页\n\n' + text);
            progress(options, { stage: 'pdf-page', page: n, pages: handle.doc.numPages, progress: (n - start + 1) / (end - start + 1) });
          } finally { page.cleanup(); }
        }
        result = { body: parts.join('\n\n'), warnings };
      } finally { if (ocr) await ocr.close(); await handle.close(); }
    }
    checkAbort(options.signal);
    progress(options, { stage: 'done', progress: 1 });
    return { ...result, title };
  }
  return Object.freeze({ inspect, extract, MAX_BYTES, classify, pageRange, selectedSheets, tableMarkdown, pdfText });
});
