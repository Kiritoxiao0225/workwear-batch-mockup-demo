export const fieldNames = ['主体', '文字', '字体', '颜色', '排版', '尺寸', '输出'];

export function promptParts(text) {
  const matches = [...text.matchAll(/^(主体|文字|字体|颜色|排版|尺寸|输出)：/gmu)];
  return { prefix: text.slice(0, matches[0]?.index ?? text.length), parts: matches.map((m, i) => {
    const raw = text.slice(m.index + m[0].length, matches[i + 1]?.index ?? text.length);
    const gap = raw.match(/(?:\r?\n)*$/u)[0];
    return { label: m[1], value: raw.slice(0, raw.length - gap.length), gap };
  }) };
}
export function replaceSection(prompt, label, value, originalGap) {
  const p = promptParts(prompt);
  return p.prefix + p.parts.map(x => x.label + '：' + (x.label === label ? value : x.value) + (x.label === label && originalGap !== undefined ? originalGap : x.gap)).join('');
}

// Return text segments, never markup. Labels and deletion notices stay outside the generation prompt.
export function changedText(before, after) {
  const a = Array.from(before), b = Array.from(after);
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end), y = b.slice(start, b.length - end);
  const segments = [], removed = [];
  const add = (text, changed) => { if (!text) return; const last = segments.at(-1); if (last?.changed === changed) last.text += text; else segments.push({ text, changed }); };
  add(b.slice(0, start).join(''), false);
  if (x.length * y.length > 1000000) { add(y.join(''), true); if (x.length) removed.push(x.join('')); }
  else {
    const rows = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) rows[i][j] = x[i] === y[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { add(y[j++], false); i++; }
      else if (j < y.length && (i === x.length || rows[i][j + 1] > rows[i + 1][j])) add(y[j++], true);
      else removed.push(x[i++]);
    }
  }
  add(end ? b.slice(b.length - end).join('') : '', false);
  return { segments, deleted: removed.join('') };
}

// One serial writer per case. Typing during a save is queued with the acknowledged revision.
export function createAutosave({ initial, write, read, onChange = () => {}, delay = 700 }) {
  let draft = structuredClone(initial.draft), revision = initial.revision, saved = JSON.stringify(draft);
  let timer, flight, status = 'saved', error = '', blocked = false, retryAfterEdit = false;
  const snapshot = () => ({ draft, revision, status, error, pending: JSON.stringify(draft) !== saved || !!flight });
  const notify = () => onChange(snapshot());
  function update(value) { draft = structuredClone(value); clearTimeout(timer); if (retryAfterEdit) { blocked = false; retryAfterEdit = false; } if (!blocked) error = ''; status = blocked ? 'error' : 'pending'; notify(); if (!blocked) timer = setTimeout(() => void flush(), delay); }
  async function flush() {
    clearTimeout(timer);
    if (flight) { await flight; if (!blocked && JSON.stringify(draft) !== saved) return flush(); return !blocked; }
    if (blocked) return false;
    const encoded = JSON.stringify(draft);
    if (encoded === saved) { status = 'saved'; error = ''; notify(); return true; }
    const sent = { caseId: initial.caseId, revision, supplementRevision: initial.supplement.revision, draft: JSON.parse(encoded) };
    status = 'saving'; error = ''; notify();
    flight = (async () => {
      try {
        const result = await write(sent); revision = result.revision; saved = encoded;
      } catch (e) {
        // A dropped response can occur after persistence. Read it before trying another write.
        let current;
        try { current = await read(initial.caseId); } catch { /* The editor retains unsaved text. */ }
        if (current && current.supplement.revision === sent.supplementRevision && JSON.stringify(current.draft) === encoded) { revision = current.revision; saved = encoded; }
        else { blocked = true; status = 'error'; const conflict = current && (current.revision !== sent.revision || current.supplement.revision !== sent.supplementRevision); retryAfterEdit = !conflict && e.status === 400; error = conflict ? '另一处已修改正文或素材。本页文字已保留，请复制修改后刷新核对；未覆盖其他版本。' : e.message || '保存失败，文字仍保留在当前页面。'; }
      }
    })();
    await flight; flight = undefined;
    if (!blocked) status = JSON.stringify(draft) === saved ? 'saved' : 'pending';
    notify();
    if (!blocked && JSON.stringify(draft) !== saved) return flush();
    return !blocked;
  }
  async function retry() {
    if (!blocked) return flush();
    try {
      const current = await read(initial.caseId);
      if (current.supplement.revision !== initial.supplement.revision || current.revision !== revision) {
        if (JSON.stringify(current.draft) === JSON.stringify(draft) && current.supplement.revision === initial.supplement.revision) { revision = current.revision; saved = JSON.stringify(draft); }
        else { error = '服务端版本已变化，请复制本页修改后刷新核对；未覆盖其他版本。'; notify(); return false; }
      }
      blocked = false; return flush();
    } catch { error = '仍无法连接保存服务，当前文字尚未保存。'; notify(); return false; }
  }
  return { update, flush, retry, snapshot };
}
