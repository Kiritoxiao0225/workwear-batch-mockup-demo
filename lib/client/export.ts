'use client';

import { placementCenter, placementWidthRatio } from '@/lib/mockup';
import { productByCode } from '@/lib/products';
import type { MockupTask, PlacementKey } from '@/lib/types';

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`导出图片加载失败：${url}`));
    image.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('浏览器未能生成 PNG 文件')),
      'image/png',
    );
  });
}

export async function renderTaskPng(task: MockupTask) {
  const product = productByCode(task.productCode);
  if (!product) throw new Error(`任务 ${task.id} 引用了不存在的商品 ${task.productCode}`);
  if (Object.keys(task.placements).length === 0) throw new Error(`任务 ${task.id} 尚未上传 Logo`);
  const productImage = await loadImage(product.originalUrl);
  const canvas = document.createElement('canvas');
  canvas.width = productImage.naturalWidth;
  canvas.height = productImage.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法创建导出画布');
  context.drawImage(productImage, 0, 0);
  for (const [rawKey, placement] of Object.entries(task.placements)) {
    if (!placement) continue;
    const key = rawKey as PlacementKey;
    const logo = await loadImage(placement.logoUrl);
    const center = placementCenter(key, placement);
    const width = canvas.width * placementWidthRatio(placement, product);
    const height = width * (logo.naturalHeight / logo.naturalWidth);
    context.save();
    context.translate(center.x * canvas.width, center.y * canvas.height);
    context.rotate((placement.rotation * Math.PI) / 180);
    context.drawImage(logo, -width / 2, -height / 2, width, height);
    context.restore();
  }
  return {
    blob: await canvasBlob(canvas),
    fileName: `${product.code}-task-${task.id.slice(0, 8)}.png`,
  };
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportTasks(tasks: MockupTask[]) {
  const exportable = tasks.filter((task) => Object.keys(task.placements).length > 0);
  const skipped = tasks.length - exportable.length;
  if (exportable.length === 0) throw new Error('所选任务均未上传 Logo，无法导出');
  if (exportable.length === 1) {
    const output = await renderTaskPng(exportable[0]);
    downloadBlob(output.blob, output.fileName);
    return { exportedTaskIds: [exportable[0].id], skipped };
  }
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const exportedTaskIds: string[] = [];
  for (const task of exportable) {
    const output = await renderTaskPng(task);
    zip.file(output.fileName, output.blob);
    exportedTaskIds.push(task.id);
  }
  downloadBlob(await zip.generateAsync({ type: 'blob' }), `workwear-mockups-${Date.now()}.zip`);
  return { exportedTaskIds, skipped };
}
