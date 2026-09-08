import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import sharp from 'sharp';

import type { SourceTaskRecord, TaskMaterial } from '@/lib/batch-task-review';
import { wpsUserAccessToken } from '@/lib/server/wps-user-oauth';

const WPS_API_ROOT = 'https://openapi.wps.cn/v7';
const CACHE_FILE = path.join(process.cwd(), 'data', 'wps-source-cache.json');
const SOURCE_ASSET_ROOT = path.join(process.cwd(), 'public', 'uploads', 'wps-source');
const MAX_WORKBOOK_BYTES = 200 * 1024 * 1024;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 600 * 1024 * 1024;
const MAX_RECORDS = 1_000;
const MAX_IMAGES = 5_000;
const MODEL_IMAGE_BYTES = 8 * 1024 * 1024;

const REQUIRED_ENVIRONMENT = ['WPS_APP_ID', 'WPS_APP_KEY', 'WPS_SOURCE_URL'] as const;
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
});

type XmlRecord = Record<string, unknown>;

type EmbeddedImage = {
  anchorColumn: number;
  anchorOffset: number;
  anchorRow: number;
  bytes: Buffer;
  extension: string;
  sourceName: string;
};

export type ParsedSpreadsheetTask = {
  customerId: string;
  images: EmbeddedImage[];
  productStyleText: string;
  requirementText: string;
  revision: string;
  rowNumber: number;
  sheetName: string;
};

type WpsSourceIdentity = {
  driveId: string;
  fileId: string;
  fileName: string;
  fileType: string;
  mtime: number;
  version: string;
};

type WpsSourceCache = WpsSourceIdentity & {
  cacheVersion: 1;
  linkId: string;
  records: SourceTaskRecord[];
  sourceUrl: string;
  syncedAt: string;
};

const HEADER_ALIASES = {
  requirement: ['任务要求说明', '任务需求说明', '任务要求', '作图要求', '作图需求', '需求原文', '需求说明', '效果图要求', '制作要求'],
  style: ['款式', '商品款式', '衣服款式', '产品款式', '货号', '款号'],
  customer: ['客户旺旺ID', '客户旺旺', '旺旺ID', '客户ID', '客户名称', '客户', '下单客户', '用户名'],
  revision: ['修改次数', '修改轮次', '次数', '第几次', '版本', '版本号'],
} as const;

function sha256(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex');
}

function environmentValue(name: (typeof REQUIRED_ENVIRONMENT)[number]) {
  return process.env[name]?.trim() ?? '';
}

export function wpsSpreadsheetConfigurationStatus() {
  const missing = REQUIRED_ENVIRONMENT.filter((name) => environmentValue(name).length === 0);
  return { configured: missing.length === 0, missing };
}

function sourceUrl() {
  const status = wpsSpreadsheetConfigurationStatus();
  if (!status.configured) throw new Error(`WPS_SYNC_NOT_CONFIGURED: 缺少 ${status.missing.join(', ')}`);
  return environmentValue('WPS_SOURCE_URL');
}

export function wpsLinkId(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`WPS_SOURCE_URL 不是有效网址：${value}`);
  }
  if (!/(?:^|\.)kdocs\.cn$/iu.test(url.hostname) && !/(?:^|\.)wps\.cn$/iu.test(url.hostname)) {
    throw new Error(`WPS_SOURCE_URL 必须是 kdocs.cn 或 wps.cn 链接，实际域名：${url.hostname}`);
  }
  const segments = url.pathname.split('/').filter(Boolean);
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    if ((segments[index] === 'l' || segments[index] === 'sl') && segments[index + 1]) {
      return segments[index + 1];
    }
  }
  throw new Error(`WPS_SOURCE_URL 中没有找到分享 link_id：${value}`);
}

function objectValue(value: unknown, label: string): XmlRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as XmlRecord;
}

function arrayValue<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function xmlDocument(value: string, label: string) {
  try {
    return objectValue(xmlParser.parse(value), label);
  } catch (error) {
    throw new Error(`${label} 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function xmlText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(xmlText).join('');
  if (!value || typeof value !== 'object') return '';
  const record = value as XmlRecord;
  if (record['#text'] !== undefined) return xmlText(record['#text']);
  if (record.t !== undefined) return xmlText(record.t);
  if (record.r !== undefined) return xmlText(record.r);
  return '';
}

function attribute(record: XmlRecord, name: string) {
  const value = record[`@_${name}`];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

async function zipText(zip: JSZip, partName: string, required = true) {
  const file = zip.file(partName);
  if (!file) {
    if (!required) return null;
    throw new Error(`WPS 原文件缺少 ${partName}`);
  }
  return file.async('string');
}

function relationshipsPart(sourcePart: string) {
  return path.posix.join(path.posix.dirname(sourcePart), '_rels', `${path.posix.basename(sourcePart)}.rels`);
}

function resolvedPart(sourcePart: string, target: string) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(sourcePart), target)).replace(/^\/+/, '');
}

async function relationshipMap(zip: JSZip, sourcePart: string) {
  const xml = await zipText(zip, relationshipsPart(sourcePart));
  const root = objectValue(xmlDocument(xml as string, `${sourcePart} 关系`).Relationships, `${sourcePart} Relationships`);
  return new Map(arrayValue(root.Relationship as XmlRecord | XmlRecord[] | undefined).flatMap((relationship) => {
    const id = attribute(relationship, 'Id');
    const target = attribute(relationship, 'Target');
    const targetMode = attribute(relationship, 'TargetMode');
    if (!id || !target || targetMode === 'External') return [];
    return [[id, resolvedPart(sourcePart, target)] as const];
  }));
}

function cellColumnIndex(reference: string) {
  const match = /^([A-Z]+)[1-9][0-9]*$/u.exec(reference.toUpperCase());
  if (!match) throw new Error(`无效的单元格地址：${reference}`);
  let index = 0;
  for (const character of match[1]) index = index * 26 + character.charCodeAt(0) - 64;
  return index - 1;
}

function numericNode(value: unknown, label: string) {
  const number = Number(xmlText(value));
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} 不是非负整数：${xmlText(value)}`);
  return number;
}

function sharedStrings(document: XmlRecord | null) {
  if (!document) return [];
  const root = objectValue(document.sst, 'sharedStrings.sst');
  return arrayValue(root.si as XmlRecord | XmlRecord[] | undefined).map(xmlText);
}

function worksheetCells(document: XmlRecord, strings: string[]) {
  const worksheet = objectValue(document.worksheet, 'worksheet');
  const sheetData = objectValue(worksheet.sheetData, 'worksheet.sheetData');
  const rows = new Map<number, Map<number, string>>();
  arrayValue(sheetData.row as XmlRecord | XmlRecord[] | undefined).forEach((row, rowIndex) => {
    const rowNumber = Number(attribute(row, 'r') || rowIndex + 1);
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) throw new Error(`工作表包含无效行号：${attribute(row, 'r')}`);
    const cells = new Map<number, string>();
    arrayValue(row.c as XmlRecord | XmlRecord[] | undefined).forEach((cell) => {
      const reference = attribute(cell, 'r');
      const columnIndex = cellColumnIndex(reference);
      const type = attribute(cell, 't');
      let value = '';
      if (type === 's') {
        const stringIndex = Number(xmlText(cell.v));
        if (!Number.isSafeInteger(stringIndex) || stringIndex < 0 || stringIndex >= strings.length) {
          throw new Error(`${reference} 引用了不存在的共享字符串 ${xmlText(cell.v)}`);
        }
        value = strings[stringIndex];
      } else if (type === 'inlineStr') {
        value = xmlText(cell.is);
      } else if (type === 'b') {
        value = xmlText(cell.v) === '1' ? 'TRUE' : 'FALSE';
      } else {
        value = xmlText(cell.v);
      }
      cells.set(columnIndex, value.trim());
    });
    rows.set(rowNumber, cells);
  });
  return { rows, worksheet };
}

function normalizedHeader(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s:：()（）\[\]【】_-]/gu, '');
}

function headerColumn(cells: Map<number, string>, aliases: readonly string[]) {
  const expected = new Set(aliases.map(normalizedHeader));
  for (const [column, value] of cells) {
    if (expected.has(normalizedHeader(value))) return column;
  }
  return null;
}

function headerMapping(rows: Map<number, Map<number, string>>, sheetName: string) {
  for (const [rowNumber, cells] of rows) {
    const requirement = headerColumn(cells, HEADER_ALIASES.requirement);
    if (requirement === null) continue;
    return {
      customer: headerColumn(cells, HEADER_ALIASES.customer),
      requirement,
      revision: headerColumn(cells, HEADER_ALIASES.revision),
      rowNumber,
      style: headerColumn(cells, HEADER_ALIASES.style),
    };
  }
  throw new Error(`工作表“${sheetName}”没有找到需求原文列；支持表头：${HEADER_ALIASES.requirement.join('、')}`);
}

async function drawingImages(zip: JSZip, worksheetPart: string, worksheet: XmlRecord) {
  const drawingReference = worksheet.drawing;
  if (!drawingReference || typeof drawingReference !== 'object' || Array.isArray(drawingReference)) return [];
  const drawingRelationshipId = attribute(drawingReference as XmlRecord, 'id');
  if (!drawingRelationshipId) return [];
  const worksheetRelationships = await relationshipMap(zip, worksheetPart);
  const drawingPart = worksheetRelationships.get(drawingRelationshipId);
  if (!drawingPart) throw new Error(`${worksheetPart} 的 drawing ${drawingRelationshipId} 没有内部关系目标`);

  const drawingXml = await zipText(zip, drawingPart);
  const drawingRoot = objectValue(xmlDocument(drawingXml as string, drawingPart).wsDr, `${drawingPart}.wsDr`);
  const drawingRelationships = await relationshipMap(zip, drawingPart);
  const anchors = [
    ...arrayValue(drawingRoot.twoCellAnchor as XmlRecord | XmlRecord[] | undefined),
    ...arrayValue(drawingRoot.oneCellAnchor as XmlRecord | XmlRecord[] | undefined),
  ];
  const images: EmbeddedImage[] = [];
  let totalBytes = 0;

  for (const anchor of anchors) {
    const from = objectValue(anchor.from, `${drawingPart} 图片锚点 from`);
    const pic = anchor.pic;
    if (!pic || typeof pic !== 'object' || Array.isArray(pic)) continue;
    const blipFill = objectValue((pic as XmlRecord).blipFill, `${drawingPart} blipFill`);
    const blip = objectValue(blipFill.blip, `${drawingPart} blip`);
    const relationshipId = attribute(blip, 'embed');
    if (!relationshipId) continue;
    const imagePart = drawingRelationships.get(relationshipId);
    if (!imagePart) throw new Error(`${drawingPart} 的图片 ${relationshipId} 没有可下载的内部文件`);
    const imageFile = zip.file(imagePart);
    if (!imageFile) throw new Error(`${drawingPart} 引用的图片不存在：${imagePart}`);
    const bytes = await imageFile.async('nodebuffer');
    if (bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(`WPS 原图 ${imagePart} 大小必须在 1B–${MAX_IMAGE_BYTES}B，实际 ${bytes.length}B`);
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) throw new Error(`WPS 原图解压后总大小超过 ${MAX_TOTAL_IMAGE_BYTES}B 安全上限`);
    images.push({
      anchorColumn: numericNode(from.col, `${drawingPart} anchor col`),
      anchorOffset: numericNode(from.colOff ?? 0, `${drawingPart} anchor colOff`),
      anchorRow: numericNode(from.row, `${drawingPart} anchor row`),
      bytes,
      extension: path.posix.extname(imagePart).slice(1).toLowerCase(),
      sourceName: path.posix.basename(imagePart),
    });
    if (images.length > MAX_IMAGES) throw new Error(`WPS 原图超过 ${MAX_IMAGES} 张安全上限`);
  }
  return images;
}

export async function parseWpsSpreadsheetWorkbook(archive: Buffer): Promise<ParsedSpreadsheetTask[]> {
  if (archive.length < 4 || archive.subarray(0, 2).toString('ascii') !== 'PK') {
    throw new Error('WPS 下载的源文件不是可解析的 .xlsx；请将原表另存为 .xlsx 后再同步');
  }
  if (archive.length > MAX_WORKBOOK_BYTES) throw new Error(`WPS 原文件超过 ${MAX_WORKBOOK_BYTES}B 安全上限`);
  const zip = await JSZip.loadAsync(archive, { checkCRC32: true });
  const workbookPart = 'xl/workbook.xml';
  const workbookXml = await zipText(zip, workbookPart);
  const workbook = objectValue(xmlDocument(workbookXml as string, workbookPart).workbook, 'workbook');
  const workbookRelationships = await relationshipMap(zip, workbookPart);
  const sharedStringsXml = await zipText(zip, 'xl/sharedStrings.xml', false);
  const strings = sharedStrings(sharedStringsXml ? xmlDocument(sharedStringsXml, 'xl/sharedStrings.xml') : null);
  const sheets = objectValue(workbook.sheets, 'workbook.sheets');
  const parsedTasks: ParsedSpreadsheetTask[] = [];
  const worksheetErrors: string[] = [];

  for (const sheet of arrayValue(sheets.sheet as XmlRecord | XmlRecord[] | undefined)) {
    const sheetName = attribute(sheet, 'name') || '未命名工作表';
    const worksheetPart = workbookRelationships.get(attribute(sheet, 'id'));
    if (!worksheetPart) throw new Error(`工作表“${sheetName}”缺少内部文件关系`);
    const worksheetXml = await zipText(zip, worksheetPart);
    const cellData = worksheetCells(xmlDocument(worksheetXml as string, worksheetPart), strings);
    let mapping: ReturnType<typeof headerMapping>;
    try {
      mapping = headerMapping(cellData.rows, sheetName);
    } catch (error) {
      worksheetErrors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const images = await drawingImages(zip, worksheetPart, cellData.worksheet);
    const imagesByRow = new Map<number, EmbeddedImage[]>();
    images.forEach((image) => {
      const rowNumber = image.anchorRow + 1;
      imagesByRow.set(rowNumber, [...(imagesByRow.get(rowNumber) ?? []), image]);
    });

    for (const [rowNumber, cells] of cellData.rows) {
      if (rowNumber <= mapping.rowNumber) continue;
      const requirementText = (cells.get(mapping.requirement) ?? '').trim();
      if (!requirementText) continue;
      const rowImages = [...(imagesByRow.get(rowNumber) ?? [])].sort((left, right) =>
        left.anchorColumn - right.anchorColumn || left.anchorOffset - right.anchorOffset);
      parsedTasks.push({
        customerId: mapping.customer === null ? `${sheetName} · 第${rowNumber}行` : (cells.get(mapping.customer) || `${sheetName} · 第${rowNumber}行`),
        images: rowImages,
        productStyleText: mapping.style === null ? '未填商品款式' : (cells.get(mapping.style) || '未填商品款式'),
        requirementText,
        revision: mapping.revision === null ? '未填修改次数' : (cells.get(mapping.revision) || '未填修改次数'),
        rowNumber,
        sheetName,
      });
      if (parsedTasks.length > MAX_RECORDS) throw new Error(`WPS 任务超过 ${MAX_RECORDS} 条安全上限`);
    }
  }

  if (parsedTasks.length === 0) {
    throw new Error(`WPS 原文件没有读到任务行。${worksheetErrors.join('；')}`);
  }
  return parsedTasks;
}

function imageExtension(image: EmbeddedImage, metadataFormat: string | undefined) {
  if (metadataFormat === 'jpeg') return 'jpg';
  if (metadataFormat === 'png' || metadataFormat === 'webp') return metadataFormat;
  if (image.extension === 'jpg' || image.extension === 'jpeg') return 'jpg';
  if (image.extension === 'png' || image.extension === 'webp') return image.extension;
  return 'png';
}

async function writeImageAsset(image: EmbeddedImage) {
  const imageHash = sha256(image.bytes);
  const metadata = await sharp(image.bytes, { failOn: 'error' }).metadata();
  const extension = imageExtension(image, metadata.format);
  const originalName = `${imageHash}.${extension}`;
  const originalPath = path.join(SOURCE_ASSET_ROOT, originalName);
  await mkdir(SOURCE_ASSET_ROOT, { recursive: true });
  try {
    await access(originalPath);
  } catch {
    const output = metadata.format === 'png' || metadata.format === 'jpeg' || metadata.format === 'webp'
      ? image.bytes
      : await sharp(image.bytes, { failOn: 'error' }).png().toBuffer();
    await writeFile(originalPath, output);
  }
  const originalUrl = `/uploads/wps-source/${originalName}`;
  if (image.bytes.length <= MODEL_IMAGE_BYTES && ['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) {
    return { hash: imageHash, originalUrl, previewUrl: originalUrl };
  }
  const previewName = `${imageHash}-preview.webp`;
  const previewPath = path.join(SOURCE_ASSET_ROOT, previewName);
  try {
    await access(previewPath);
  } catch {
    const preview = await sharp(image.bytes, { failOn: 'error' })
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 88, effort: 4 })
      .toBuffer();
    if (preview.length > MODEL_IMAGE_BYTES) throw new Error(`WPS 原图 ${image.sourceName} 的模型预览仍超过 8MB`);
    await writeFile(previewPath, preview);
  }
  return { hash: imageHash, originalUrl, previewUrl: `/uploads/wps-source/${previewName}` };
}

async function taskRecords(tasks: ParsedSpreadsheetTask[]) {
  const records: SourceTaskRecord[] = [];
  for (const task of tasks) {
    const imageAssets = await Promise.all(task.images.map(writeImageAsset));
    const recordId = `wps-${sha256(JSON.stringify({
      sheetName: task.sheetName,
      rowNumber: task.rowNumber,
      requirementText: task.requirementText,
      productStyleText: task.productStyleText,
      images: imageAssets.map((image) => image.hash),
    })).slice(0, 24)}`;
    const materials: TaskMaterial[] = imageAssets.map((image, index) => ({
      id: `${recordId}-m${index + 1}-${image.hash.slice(0, 12)}`,
      name: `图${index + 1}`,
      description: `${task.sheetName} 第${task.rowNumber}行原始素材图${index + 1}`,
      previewUrl: image.previewUrl,
      url: image.originalUrl,
    }));
    records.push({
      recordId,
      customerId: task.customerId,
      revision: task.revision,
      requirementText: task.requirementText,
      productStyleText: task.productStyleText,
      materials,
    });
  }
  return records;
}

async function wpsJson(url: string, accessToken: string, label: string, timeoutMs = 30_000) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs),
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`${label} 返回了无效 JSON：HTTP ${response.status}`);
  }
  const body = objectValue(value, `${label} 响应`);
  const code = Number(body.code);
  if (!response.ok || !Number.isFinite(code) || code !== 0) {
    const message = typeof body.msg === 'string' ? body.msg : '未返回错误信息';
    if (response.status === 401 || response.status === 403) {
      throw new Error(`WPS_USER_AUTH_REQUIRED: ${label}无权访问（HTTP ${response.status} · code=${String(body.code)} · ${message}）；请重新连接拥有原表权限的 WPS 账号，并确认应用已开通普通表格、文件和分享链接读取权限`);
    }
    throw new Error(`${label}失败：HTTP ${response.status} · code=${String(body.code)} · ${message}`);
  }
  return objectValue(body.data, `${label}.data`);
}

async function sourceIdentity(accessToken: string, linkId: string): Promise<WpsSourceIdentity> {
  const link = await wpsJson(`${WPS_API_ROOT}/links/${encodeURIComponent(linkId)}/meta`, accessToken, '读取 WPS 分享链接');
  const fileId = typeof link.file_id === 'string' ? link.file_id.trim() : '';
  const linkDriveId = typeof link.drive_id === 'string' ? link.drive_id.trim() : '';
  if (!fileId) throw new Error(`WPS 分享链接 ${linkId} 没有返回 file_id`);
  const file = await wpsJson(`${WPS_API_ROOT}/files/${encodeURIComponent(fileId)}/meta?with_drive=true&with_permission=true`, accessToken, '读取 WPS 文件信息');
  const driveId = typeof file.drive_id === 'string' && file.drive_id.trim() ? file.drive_id.trim() : linkDriveId;
  const fileType = typeof file.type === 'string' ? file.type.trim() : '';
  const fileName = typeof file.name === 'string' ? file.name.trim() : '';
  if (!driveId) throw new Error(`WPS 文件 ${fileId} 没有返回 drive_id`);
  if (fileType !== 'et') throw new Error(`WPS_SOURCE_URL 指向的不是普通电子表格：文件“${fileName || fileId}”类型为 ${fileType || '未知'}`);
  const permission = file.permission && typeof file.permission === 'object' && !Array.isArray(file.permission)
    ? file.permission as XmlRecord
    : null;
  if (permission?.download === false) throw new Error(`当前 WPS 账号没有下载原文件“${fileName || fileId}”的权限`);
  return {
    driveId,
    fileId,
    fileName: fileName || fileId,
    fileType,
    mtime: Number(file.mtime ?? link.mtime ?? 0),
    version: String(file.version ?? file.mtime ?? link.mtime ?? '0'),
  };
}

async function readCache(): Promise<WpsSourceCache | null> {
  try {
    const value = JSON.parse(await readFile(CACHE_FILE, 'utf8')) as unknown;
    const cache = objectValue(value, 'WPS 任务缓存');
    if (cache.cacheVersion !== 1 || !Array.isArray(cache.records)) return null;
    return cache as WpsSourceCache;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function cacheAssetsExist(cache: WpsSourceCache) {
  try {
    await Promise.all(cache.records.flatMap((record) => record.materials.flatMap((material) =>
      [material.url, material.previewUrl]
        .filter((url): url is string => Boolean(url?.startsWith('/uploads/wps-source/')))
        .map((url) => access(path.join(process.cwd(), 'public', url))))));
    return true;
  } catch {
    return false;
  }
}

async function writeCache(cache: WpsSourceCache) {
  await mkdir(path.dirname(CACHE_FILE), { recursive: true });
  const pendingPath = `${CACHE_FILE}.${process.pid}.${randomUUID()}.pending`;
  await writeFile(pendingPath, `${JSON.stringify(cache, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(pendingPath, CACHE_FILE);
}

async function downloadWorkbook(accessToken: string, source: WpsSourceIdentity) {
  const download = await wpsJson(
    `${WPS_API_ROOT}/drives/${encodeURIComponent(source.driveId)}/files/${encodeURIComponent(source.fileId)}/download?with_hash=true`,
    accessToken,
    '获取 WPS 原文件下载地址',
  );
  const downloadUrl = typeof download.url === 'string' ? download.url : '';
  if (!downloadUrl.startsWith('https://')) throw new Error('WPS 文件下载接口没有返回 HTTPS 地址');
  const response = await fetch(downloadUrl, { cache: 'no-store', signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`下载 WPS 原文件失败：HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_WORKBOOK_BYTES) {
    throw new Error(`WPS 原文件超过 ${MAX_WORKBOOK_BYTES}B 安全上限，实际 ${contentLength}B`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length < 1 || archive.length > MAX_WORKBOOK_BYTES) {
    throw new Error(`WPS 原文件大小必须在 1B–${MAX_WORKBOOK_BYTES}B，实际 ${archive.length}B`);
  }
  return archive;
}

export async function listWpsSourceTaskRecords() {
  const configuredSourceUrl = sourceUrl();
  const linkId = wpsLinkId(configuredSourceUrl);
  const accessToken = await wpsUserAccessToken();
  const identity = await sourceIdentity(accessToken, linkId);
  const cached = await readCache();
  if (cached
    && cached.linkId === linkId
    && cached.fileId === identity.fileId
    && cached.version === identity.version
    && cached.mtime === identity.mtime
    && await cacheAssetsExist(cached)) {
    return { records: cached.records, syncedAt: cached.syncedAt, source: identity, cacheHit: true };
  }

  const archive = await downloadWorkbook(accessToken, identity);
  const records = await taskRecords(await parseWpsSpreadsheetWorkbook(archive));
  const syncedAt = new Date().toISOString();
  await writeCache({
    cacheVersion: 1,
    linkId,
    records,
    sourceUrl: configuredSourceUrl,
    syncedAt,
    ...identity,
  });
  return { records, syncedAt, source: identity, cacheHit: false };
}
