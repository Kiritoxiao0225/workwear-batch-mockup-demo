import { applyRepairStroke, validateRepairStrokes } from '/repair-pixels.mjs';

export function createRepairEditor({ api, onSaved }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'repair-editor';
  dialog.setAttribute('aria-labelledby', 'repair-title');
  dialog.innerHTML = `<div class="repair-head"><div><h2 id="repair-title">局部修补</h2><div class="repair-subtitle" data-subtitle>读取原图与抠图结果…</div></div><button data-exit>关闭</button></div>
    <div class="repair-controls"><div class="repair-modes" role="group" aria-label="修补工具"><button data-mode="fill" aria-pressed="true">补空白</button><button data-mode="keep" aria-pressed="false">＋ 保留</button><button data-mode="remove" aria-pressed="false">－ 去除</button><button data-mode="pan" aria-pressed="false">移动画布</button></div>
    <label data-fill-options>范围 <select data-fill-scope aria-label="补空白范围"><option value="brush">画笔圈内</option><option value="region">单块空白</option></select></label>
    <label data-brush-options>画笔 <input data-brush type="range" min="2" max="512" value="160" aria-label="画笔大小"><output data-brush-label>160 px</output></label>
    <label>缩放 <select data-zoom aria-label="画布缩放"><option value="fit">适合窗口</option><option value="0.25">25%</option><option value="0.5">50%</option><option value="1">100%</option><option value="2">200%</option><option value="4">400%</option></select></label>
    <label>背景 <select data-background aria-label="修补预览背景"><option value="dark">深色</option><option value="light">白色</option><option value="checker">棋盘格</option></select></label>
    <label><input data-guide type="checkbox">原图辅助显示</label><div class="repair-shortcuts"><button data-undo>撤销</button><button data-redo>重做</button><button data-reset>恢复原抠图</button></div></div>
    <p class="repair-instruction" data-instruction>补空白：点一下补回画笔圈内的空洞，已有图案不动；与外部背景连通的区域不填补。</p>
    <div class="repair-viewport" data-background="dark"><div class="repair-center"><div class="repair-stage"><canvas aria-label="局部修补画布"></canvas><img data-guide-image alt="抠图前原图辅助层" hidden><div class="repair-cursor" hidden></div></div></div></div>
    <div class="repair-discard" hidden><span>还有未保存的修补，关闭会丢弃这些笔画。</span><div class="tools"><button data-continue>继续修补</button><button data-discard>放弃并关闭</button></div></div>
    <div class="repair-bottom"><div><p data-status role="status">正在载入…</p><p data-error class="error" role="alert"></p></div><div class="tools"><button data-save class="primary" disabled>保存修补</button></div></div>`;
  document.body.append(dialog);
  const $ = selector => dialog.querySelector(selector), canvas = $('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
  const viewport = $('.repair-viewport'), stage = $('.repair-stage'), cursor = $('.repair-cursor');
  let input, base, source, original, imageData, strokes = [], redo = [], active, mode = 'fill', zoom = 1, ready = false, saving = false, pending = null, drawingFrame = false, space = false, loadId = 0, hasLayout = false;

  function dirty() { return strokes.length > 0; }
  function controls() {
    for (const el of dialog.querySelectorAll('.repair-controls button,.repair-controls input,.repair-controls select')) el.disabled = !ready || saving || !!pending;
    $('[data-undo]').disabled ||= !strokes.length;
    $('[data-redo]').disabled ||= !redo.length;
    $('[data-save]').disabled = !ready || saving || !dirty();
    $('[data-save]').textContent = saving ? '保存中…' : pending ? '重试保存' : '保存修补';
    $('[data-status]').textContent = !ready ? '正在载入…' : saving ? '正在保存修补图片…' : pending ? '保存未确认；笔画仍保留，请重试保存。' : dirty() ? `${strokes.length} 笔修改 · 尚未保存` : input.revision ? `人工修补 v${input.revision} 已保存` : '当前为原始制作结果 · 修改后保存';
  }
  function paint() { ctx.putImageData(imageData, 0, 0); }
  function schedulePaint() { if (!drawingFrame) { drawingFrame = true; requestAnimationFrame(() => { drawingFrame = false; if (ready) paint(); }); } }
  function replay() { imageData.data.set(base); for (const s of strokes) applyRepairStroke(imageData.data, source, original, canvas.width, canvas.height, s); paint(); controls(); }
  function addStroke(s) {
    try {
      validateRepairStrokes([...strokes, s], canvas.width, canvas.height);
      // Commit history only after the candidate pixels are valid. A rejected fill is a no-op.
      const candidate = new Uint8ClampedArray(base);
      for (const previous of strokes) applyRepairStroke(candidate, source, original, canvas.width, canvas.height, previous);
      const result = applyRepairStroke(candidate, source, original, canvas.width, canvas.height, s);
      strokes.push(s); redo = []; imageData.data.set(candidate); paint(); controls();
      $('[data-error]').textContent = '';
      if (result?.restoredPixels) $('[data-status]').textContent += ` · 本次补回 ${result.restoredPixels.toLocaleString()} 像素`;
    } catch (e) { $('[data-error]').textContent = e.message; replay(); }
  }
  function resize() {
    if (!ready) return;
    const viewportRect = viewport.getBoundingClientRect(), before = stage.getBoundingClientRect();
    const cx = hasLayout ? (viewportRect.left + viewport.clientWidth / 2 - before.left) / before.width : .5;
    const cy = hasLayout ? (viewportRect.top + viewport.clientHeight / 2 - before.top) / before.height : .5;
    zoom = $('[data-zoom]').value === 'fit' ? Math.min(1, Math.max(.05, (viewport.clientWidth - 48) / canvas.width), Math.max(.05, (viewport.clientHeight - 48) / canvas.height)) : Number($('[data-zoom]').value);
    stage.style.width = canvas.width * zoom + 'px'; stage.style.height = canvas.height * zoom + 'px';
    const after = stage.getBoundingClientRect();
    viewport.scrollLeft += after.left + cx * after.width - viewportRect.left - viewport.clientWidth / 2;
    viewport.scrollTop += after.top + cy * after.height - viewportRect.top - viewport.clientHeight / 2;
    hasLayout = true;
  }
  function setMode(next) {
    mode = next;
    for (const el of dialog.querySelectorAll('[data-mode]')) el.setAttribute('aria-pressed', String(el.dataset.mode === mode));
    stage.dataset.pan = String(mode === 'pan' || space);
    cursor.classList.toggle('is-removing', mode === 'remove');
    cursor.hidden = true;
    $('[data-fill-options]').hidden = mode !== 'fill';
    $('[data-brush-options]').hidden = mode === 'pan' || mode === 'fill' && $('[data-fill-scope]').value === 'region';
    $('[data-brush]').max = mode === 'fill' ? '512' : '160'; $('[data-brush]').oninput();
    $('[data-instruction]').textContent = mode === 'fill' ? $('[data-fill-scope]').value === 'brush' ? '补空白：点一下补回画笔圈内的空洞，已有图案不动；与外部背景连通的区域不填补。' : '单块空白：点中一个空洞，补回连通的整块；与外部背景连通时不填补，可改用保留笔细修。' : mode === 'remove' ? '去除：涂抹区域变透明，不会填成白色。可切换深浅背景检查边缘。' : mode === 'pan' ? '拖动画布查看放大后的细节。也可随时按住空格拖动，松开后继续修补。' : '保留：涂抹恢复被误删的内容。细字请放大并调小画笔；画笔经过的背景也会恢复。';
    resize();
  }
  function point(e) { const r = canvas.getBoundingClientRect(); return [Math.max(0, Math.min(canvas.width - .001, (e.clientX - r.left) * canvas.width / r.width)), Math.max(0, Math.min(canvas.height - .001, (e.clientY - r.top) * canvas.height / r.height))]; }
  function showCursor(e) {
    const r = stage.getBoundingClientRect(); cursor.hidden = false;
    cursor.style.left = e.clientX - r.left + 'px'; cursor.style.top = e.clientY - r.top + 'px';
    cursor.style.width = cursor.style.height = (mode === 'fill' && $('[data-fill-scope]').value === 'region' ? 12 : Number($('[data-brush]').value) * zoom) + 'px';
  }
  canvas.addEventListener('pointerdown', e => {
    if (!ready || saving || pending || e.button !== 0 || active) return;
    e.preventDefault();
    if (mode === 'fill' && !space) {
      const scope = $('[data-fill-scope]').value;
      addStroke({ mode: 'fill', scope, point: point(e), ...(scope === 'brush' ? { radius: Number($('[data-brush]').value) / 2 } : {}) });
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    if (mode === 'pan' || space) active = { pan: true, x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, pointerId: e.pointerId };
    else { active = { mode, radius: Number($('[data-brush]').value) / 2, points: [point(e)], pointerId: e.pointerId }; applyRepairStroke(imageData.data, source, original, canvas.width, canvas.height, active); schedulePaint(); }
  });
  canvas.addEventListener('pointermove', e => {
    showCursor(e);
    if (!active || active.pointerId !== e.pointerId) return;
    if (active.pan) { viewport.scrollLeft = active.left - (e.clientX - active.x); viewport.scrollTop = active.top - (e.clientY - active.y); return; }
    const p = point(e), previous = active.points.at(-1);
    if (Math.hypot(p[0] - previous[0], p[1] - previous[1]) < .5) return;
    active.points.push(p);
    applyRepairStroke(imageData.data, source, original, canvas.width, canvas.height, { ...active, points: [previous, p] }); schedulePaint();
  });
  function finish(e) {
    if (!active || e && e.pointerId !== active.pointerId) return;
    const s = active; active = null;
    if (canvas.hasPointerCapture(s.pointerId)) canvas.releasePointerCapture(s.pointerId);
    if (!s.pan) addStroke({ mode: s.mode, radius: s.radius, points: s.points });
  }
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('lostpointercapture', finish);
  canvas.addEventListener('pointercancel', e => { if (active?.pointerId === e.pointerId) { active = null; replay(); } });
  canvas.addEventListener('pointerleave', () => { cursor.hidden = true; });
  for (const el of dialog.querySelectorAll('[data-mode]')) el.onclick = () => setMode(el.dataset.mode);
  $('[data-fill-scope]').onchange = () => setMode('fill');
  $('[data-brush]').oninput = () => { $('[data-brush-label]').textContent = $('[data-brush]').value + ' px'; };
  $('[data-zoom]').onchange = resize;
  $('[data-background]').onchange = () => { viewport.dataset.background = $('[data-background]').value; };
  $('[data-guide]').onchange = () => { $('[data-guide-image]').hidden = !$('[data-guide]').checked; };
  $('[data-undo]').onclick = () => { if (strokes.length) { redo.push(strokes.pop()); replay(); } };
  $('[data-redo]').onclick = () => { if (redo.length) { strokes.push(redo.pop()); replay(); } };
  $('[data-reset]').onclick = () => addStroke({ mode: 'reset' });
  dialog.addEventListener('keydown', e => {
    if (e.code === 'Space' && !/INPUT|SELECT|BUTTON/.test(e.target.tagName)) { e.preventDefault(); space = true; stage.dataset.pan = 'true'; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !saving && !pending && ready && !active) { e.preventDefault(); (e.shiftKey ? $('[data-redo]') : $('[data-undo]')).click(); }
  });
  dialog.addEventListener('keyup', e => { if (e.code === 'Space') { space = false; stage.dataset.pan = String(mode === 'pan'); } });
  window.addEventListener('blur', () => { space = false; stage.dataset.pan = String(mode === 'pan'); finish(); });
  window.addEventListener('resize', resize);
  function close() { if (saving) return; finish(); if (dirty()) $('.repair-discard').hidden = false; else dialog.close(); }
  $('[data-exit]').onclick = close;
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  $('[data-continue]').onclick = () => { $('.repair-discard').hidden = true; };
  $('[data-discard]').onclick = () => { strokes = []; pending = null; dialog.close(); };
  dialog.addEventListener('close', () => { loadId++; ready = false; active = null; base = source = original = imageData = null; });
  window.addEventListener('beforeunload', e => { if (dialog.open && dirty()) { e.preventDefault(); e.returnValue = ''; } });
  async function loadPixels(file) {
    const img = new Image(); img.src = '/' + file.asset; await img.decode();
    if (img.naturalWidth !== input.raw.width || img.naturalHeight !== input.raw.height) throw Error('图片尺寸不一致，无法准确修补');
    const surface = document.createElement('canvas'); surface.width = img.naturalWidth; surface.height = img.naturalHeight;
    const context = surface.getContext('2d', { willReadFrequently: true }); context.drawImage(img, 0, 0); return context.getImageData(0, 0, surface.width, surface.height).data;
  }
  $('[data-save]').onclick = async () => {
    if (saving || !dirty()) return;
    finish(); saving = true; $('.repair-discard').hidden = true;
    pending ||= { jobId: input.jobId, revision: input.revision, currentSHA256: input.current.sha256, rawSHA256: input.raw.sha256, requestId: crypto.randomUUID(), strokes: structuredClone(strokes) };
    controls(); $('[data-error]').textContent = '';
    try {
      const result = await api('/api/production/repair', pending);
      input.revision = result.revision; input.current = result.current.file;
      base = await loadPixels(input.current); imageData.data.set(base); paint();
      strokes = []; redo = []; pending = null;
      $('[data-status]').textContent = '修补已保存';
      await onSaved();
    } catch (e) { $('[data-error]').textContent = e.message; if (e.status && e.status < 500 && e.status !== 409) pending = null; }
    finally { saving = false; controls(); }
  };
  return {
    async open(jobId) {
      const opening = ++loadId;
      ready = false; strokes = []; redo = []; active = null; pending = null; space = false; hasLayout = false;
      $('[data-error]').textContent = ''; $('.repair-discard').hidden = true; $('[data-guide]').checked = false; $('[data-guide-image]').hidden = true;
      $('[data-zoom]').value = 'fit'; canvas.width = canvas.height = 1; controls(); dialog.showModal();
      try {
        const received = await api('/api/production/repair?jobId=' + encodeURIComponent(jobId));
        if (opening !== loadId || !dialog.open) return;
        input = received;
        const values = await Promise.all([loadPixels(input.raw), loadPixels(input.current), loadPixels(input.original)]);
        if (opening !== loadId || !dialog.open) return;
        [source, base, original] = values;
        canvas.width = input.raw.width; canvas.height = input.raw.height; imageData = ctx.createImageData(canvas.width, canvas.height); imageData.data.set(base);
        $('[data-guide-image]').src = '/' + input.raw.asset;
        $('[data-subtitle]').textContent = `${input.name} · ${canvas.width} × ${canvas.height} · 原图辅助层与预览背景不会保存进图片`;
        $('[data-fill-scope]').value = 'brush'; $('[data-brush]').max = '512';
        $('[data-brush]').value = String(Math.max(32, Math.min(256, Math.round(canvas.width / 10)))); $('[data-brush]').oninput();
        ready = true; setMode('fill'); paint(); controls();
      } catch (e) { if (opening !== loadId || !dialog.open) return; $('[data-error]').textContent = e.message; $('[data-status]').textContent = '图片未载入，未做任何修改'; }
    }
  };
}
