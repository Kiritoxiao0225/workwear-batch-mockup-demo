import { readProductionFile, productionUser } from '@/lib/server/production-storage';

import JSZip from 'jszip';
import { NextResponse } from 'next/server';

import { readWpsProductionState } from '@/lib/server/wps-production-store';
import { listWpsSourceTaskRecords } from '@/lib/server/wps-dbsheet';
import { liveWpsProductionState } from '@/lib/wps-source';
import { WPS_COMPOSITOR_VERSION } from '@/lib/wps-production';

export const dynamic = 'force-dynamic';

function csvCell(value: unknown) {
  const text = String(value ?? '');
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function safeArchiveName(value: string) {
  return value.replace(/[\\/\u0000-\u001f]/gu, '-').slice(0, 180) || 'asset.png';
}

export async function GET(request?: Request) {
  try {
    await productionUser(request);
    const [source, stored] = await Promise.all([listWpsSourceTaskRecords(), readWpsProductionState()]);
    const state = liveWpsProductionState(stored, source.records);
    const approved = state.mockupVersions.filter((version) => version.status === 'approved' && version.output);
    if (approved.length === 0) {
      return NextResponse.json({ error: '当前没有通过成品确认的效果图，不能导出' }, { status: 422 });
    }
    const unframed = approved.filter(version => version.output!.compositorVersion !== WPS_COMPOSITOR_VERSION);
    if (unframed.length) return NextResponse.json({ error: `请更新为带框客户图并重新确认后导出：${unframed.map(version => version.garmentLabel).join('、')}` }, { status: 422 });

    const zip = new JSZip();
    const files: { name: string; url: string }[] = [];
    const unitById = new Map(state.units.map(unit => [unit.id, unit]));
    const mappings = [];
    const exportedArtwork = new Set<string>();
    for (const version of approved) {
      const output = version.output!;
      files.push({ name: `成品/${output.name}`, url: output.url });
      const units = version.unitIds.map((unitId) => {
        const unit = unitById.get(unitId);
        if (!unit) throw new Error(`${version.id} 引用了不存在的定制单元：${unitId}`);
        return unit;
      });
      for (const unit of units) {
        if (!unit.artwork || exportedArtwork.has(unit.artwork.validation.sha256)) continue;
        exportedArtwork.add(unit.artwork.validation.sha256);
        files.push({ name: `透明素材/${unit.artwork.validation.sha256.slice(0, 12)}-${safeArchiveName(unit.artwork.name)}`, url: unit.artwork.url });
      }
      mappings.push({
        versionId: version.id,
        sourceRecordId: version.sourceRecordId,
        garmentLabel: version.garmentLabel,
        variantLabel: version.variantLabel,
        productCode: version.productCode,
        garment: version.garment ?? null,
        outputFile: `成品/${output.name}`,
        outputSha256: output.sha256,
        unitIds: version.unitIds,
        placements: units.map((unit) => ({
          unitId: unit.id,
          placement: unit.placement,
          garment: unit.garment ?? null,
          artworkSha256: unit.artwork?.validation.sha256 ?? null,
        })),
        approvedAt: version.finalConfirmation?.confirmedAt ?? null,
        approvedBy: version.finalConfirmation?.actor ?? null,
      });
    }

    const failures = state.mockupVersions
      .filter((version) => version.status !== 'approved')
      .map((version) => ({
        versionId: version.id,
        sourceRecordId: version.sourceRecordId,
        status: version.status,
        error: version.compositionError,
        units: version.unitIds.map((unitId) => {
          const unit = unitById.get(unitId);
          return {
            unitId,
            status: unit?.status ?? 'missing',
            error: unit?.error ?? null,
            returnReason: unit?.returnReason ?? null,
          };
        }),
      }));
    // Bound OSS reads and retain archive order. Never return a partial archive
    // after a failed read. PNGs are already compressed; keep their exact bytes.
    for (let offset = 0; offset < files.length; offset += 3) {
      const group = files.slice(offset, offset + 3);
      const results = await Promise.allSettled(group.map(file => readProductionFile(file.url)));
      results.forEach((result, index) => {
        if (result.status === 'rejected') throw result.reason;
        zip.file(group[index].name, result.value, { compression: 'STORE' });
      });
    }
    zip.file('mapping.json', `${JSON.stringify({ batchId: state.batchId, revision: state.revision, mappings }, null, 2)}\n`);
    zip.file('failures.json', `${JSON.stringify(failures, null, 2)}\n`);
    const csvRows = [
      ['version_id', 'source_record_id', 'garment_label', 'variant_label', 'product_code', 'color', 'variant_id', 'asset_version_id', 'output_file', 'output_sha256', 'approved_at', 'approved_by'],
      ...mappings.map((mapping) => [
        mapping.versionId,
        mapping.sourceRecordId,
        mapping.garmentLabel,
        mapping.variantLabel,
        mapping.productCode,
        mapping.garment?.colorName,
        mapping.garment?.variantId,
        mapping.garment?.assetVersionId,
        mapping.outputFile,
        mapping.outputSha256,
        mapping.approvedAt,
        mapping.approvedBy,
      ]),
    ];
    zip.file('mapping.csv', `\uFEFF${csvRows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`);
    const archive = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    return new Response(Buffer.from(archive), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="wps-production-${state.batchId}.zip"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `导出失败：${message}` }, { status: 500 });
  }
}
