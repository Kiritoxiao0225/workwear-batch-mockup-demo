import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { parseWpsSpreadsheetWorkbook, wpsLinkId } from '@/lib/server/wps-spreadsheet';

async function workbookFixture() {
  const zip = new JSZip();
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="效果图任务管理" sheetId="1" r:id="rId1"/></sheets>
    </workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
    </Relationships>`);
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <si><t>任务要求说明</t></si><si><t>款式</t></si><si><t>客户旺旺ID</t></si><si><t>修改次数</t></si>
      <si><t>图1+poppy手机数码</t></si><si><t>B01SD-活力黑</t></si><si><t>张海健csj</t></si><si><t>第1次</t></si>
      <si><r><t>保留完整</t></r><r><t>原文</t></r></si><si><t>719SF-黑色</t></si>
    </sst>`);
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>
        <row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2" t="s"><v>6</v></c><c r="D2" t="s"><v>7</v></c></row>
        <row r="3"><c r="A3" t="s"><v>8</v></c><c r="B3" t="s"><v>9</v></c></row>
      </sheetData>
      <drawing r:id="rIdDrawing"/>
    </worksheet>`);
  zip.file('xl/worksheets/_rels/sheet1.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rIdDrawing" Type="drawing" Target="../drawings/drawing1.xml"/>
    </Relationships>`);
  zip.file('xl/drawings/drawing1.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:pic><xdr:blipFill><a:blip r:embed="rIdSecond"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor>
      <xdr:oneCellAnchor><xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:pic><xdr:blipFill><a:blip r:embed="rIdFirst"/></xdr:blipFill></xdr:pic></xdr:oneCellAnchor>
    </xdr:wsDr>`);
  zip.file('xl/drawings/_rels/drawing1.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rIdFirst" Type="image" Target="../media/first.png"/>
      <Relationship Id="rIdSecond" Type="image" Target="../media/second.png"/>
    </Relationships>`);
  zip.file('xl/media/first.png', Buffer.from('first-image'));
  zip.file('xl/media/second.png', Buffer.from('second-image'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('WPS traditional spreadsheet source', () => {
  it('extracts the link id from both WPS share URL shapes', () => {
    expect(wpsLinkId('https://365.kdocs.cn/view/l/cj5Qvp0WVtjz')).toBe('cj5Qvp0WVtjz');
    expect(wpsLinkId('https://365.kdocs.cn/wo/sl/v11WJkWI')).toBe('v11WJkWI');
  });

  it('keeps source text and maps floating originals to their anchored row in left-to-right order', async () => {
    const tasks = await parseWpsSpreadsheetWorkbook(await workbookFixture());

    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      customerId: '张海健csj',
      productStyleText: 'B01SD-活力黑',
      requirementText: '图1+poppy手机数码',
      revision: '第1次',
      rowNumber: 2,
      sheetName: '效果图任务管理',
    });
    expect(tasks[0].images.map((image) => image.sourceName)).toEqual(['first.png', 'second.png']);
    expect(tasks[0].images.map((image) => image.bytes.toString())).toEqual(['first-image', 'second-image']);
    expect(tasks[1].requirementText).toBe('保留完整原文');
    expect(tasks[1].images).toEqual([]);
  });

  it('rejects non-xlsx source bytes instead of silently returning test data', async () => {
    await expect(parseWpsSpreadsheetWorkbook(Buffer.from('not-a-zip')))
      .rejects.toThrow('不是可解析的 .xlsx');
  });
});
