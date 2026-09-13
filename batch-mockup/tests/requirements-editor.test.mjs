import test from 'node:test';
import assert from 'node:assert/strict';
import { changedText, promptParts, replaceSection, createAutosave } from '../experiments/workbench/requirements-editor.mjs';

test('只替换目标栏目，保留其他字句、CRLF、空格和分隔', () => {
  const text = '【左胸】\r\n\r\n主体：原图  \r\n\r\n文字：第一行\r\n第二行\r\n\r\n颜色：蓝色\r\n\r\n输出：透明图\r\n';
  assert.equal(replaceSection(text, '颜色', '白色\n黑色  '), text.replace('颜色：蓝色', '颜色：白色\n黑色  '));
  assert.equal(promptParts(text).parts[1].value, '第一行\r\n第二行');
  const first = replaceSection(text, '颜色', '白色\n', '\r\n\r\n');
  assert.equal(replaceSection(first, '颜色', '白色\n第二行', '\r\n\r\n'), text.replace('颜色：蓝色', '颜色：白色\n第二行'));
});
test('人工替换与追加仅高亮新文字，删除和恢复可区分', () => {
  const d = changedText('Logo用蓝色，居中，保留图1。', 'Logo用白色，居中，保留图1。  新增\n说明');
  assert.equal(d.segments.map(x => x.text).join(''), 'Logo用白色，居中，保留图1。  新增\n说明');
  assert.equal(d.segments.filter(x => x.changed).map(x => x.text).join(''), '白  新增\n说明');
  assert.equal(d.deleted, '蓝');
  assert.equal(changedText('蓝色原文', '蓝色原文').segments.some(x => x.changed), false);
  assert.equal(changedText('保留白色背景', '保留白色').deleted, '背景');
  assert.equal(changedText('图😀标', '图🐬标').segments.filter(x => x.changed).map(x => x.text).join(''), '🐬');
});

const initial = () => ({ caseId: 'T', revision: 1, supplement: { revision: 0 }, draft: { text: '模型原文' } });
test('连续编辑串行保存，第一次返回不覆盖其后的输入，也不提前显示全部保存', async () => {
  const sent = [], states = []; let release;
  const w = createAutosave({ initial: initial(), delay: 60000, write: b => { sent.push(b); return sent.length === 1 ? new Promise(r => { release = r; }) : Promise.resolve({ revision: 3 }); }, read: async () => {}, onChange: s => states.push({ ...s }) });
  w.update({ text: '第一处' }); const p = w.flush();
  w.update({ text: '第一处及第二处' }); assert.equal(w.snapshot().pending, true);
  release({ revision: 2 }); await p;
  assert.deepEqual(sent.map(x => [x.revision, x.draft.text]), [[1, '第一处'], [2, '第一处及第二处']]);
  assert.equal(w.snapshot().status, 'saved'); assert.equal(w.snapshot().pending, false);
  assert.equal(states.some(x => x.status === 'saved' && x.draft.text === '第一处'), false);
});
test('保存响应丢失后先回读，已落盘的相同正文不重复写入', async () => {
  let calls = 0;
  const w = createAutosave({ initial: initial(), delay: 60000, write: async () => { calls++; throw Error('断线'); }, read: async () => ({ ...initial(), revision: 2, draft: { text: '修改' } }) });
  w.update({ text: '修改' }); await w.flush();
  assert.equal(calls, 1); assert.equal(w.snapshot().status, 'saved'); assert.equal(w.snapshot().revision, 2);
});
test('失败保留编辑，恢复后允许重试；未得到持久化确认不报保存成功', async () => {
  let connected = false;
  const w = createAutosave({ initial: initial(), delay: 60000, write: async () => { if (!connected) throw Error('断线'); return { revision: 2 }; }, read: async () => initial() });
  w.update({ text: '未保存的新文字' }); assert.equal(await w.flush(), false);
  assert.equal(w.snapshot().status, 'error'); assert.equal(w.snapshot().draft.text, '未保存的新文字');
  connected = true; assert.equal(await w.retry(), true); assert.equal(w.snapshot().pending, false);
});
test('并发版本冲突不覆盖另一页面，持续保留当前编辑与错误提示', async () => {
  let calls = 0;
  const w = createAutosave({ initial: initial(), delay: 60000, write: async () => { calls++; throw Error('版本冲突'); }, read: async () => ({ ...initial(), revision: 2, draft: { text: '另一页面的修改' } }) });
  w.update({ text: '本页的修改' }); assert.equal(await w.flush(), false);
  w.update({ text: '本页继续修改' }); assert.match(w.snapshot().error, /另一处/);
  assert.equal(await w.retry(), false); assert.equal(calls, 1); assert.equal(w.snapshot().draft.text, '本页继续修改');
});
test('暂时清空必填栏目后，重新输入可自动恢复保存', async () => {
  const w = createAutosave({ initial: initial(), delay: 60000, write: async b => { if (!b.draft.text) throw Object.assign(Error('文字为空'), { status: 400 }); return { revision: 2 }; }, read: async () => initial() });
  w.update({ text: '' }); assert.equal(await w.flush(), false);
  w.update({ text: '重新填写' }); assert.equal(await w.flush(), true); assert.equal(w.snapshot().status, 'saved');
});
