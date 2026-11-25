"use strict";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_NS = "http://schemas.openxmlformats.org/package/2006";

function escapeXml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function worksheetXml(rows) {
  const sheetRows = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = row.map((value, colIndex) => {
      const ref = "ABC"[colIndex] + rowNumber;
      if (typeof value === "number") return '<c r="' + ref + '" s="1"><v>' + value + '</v></c>';
      const style = rowIndex === 0 || rowIndex === 6 ? 2 : colIndex === 2 ? 3 : 0;
      return '<c r="' + ref + '" s="' + style + '" t="inlineStr"><is><t xml:space="preserve">' +
        escapeXml(value) + '</t></is></c>';
    });
    return '<row r="' + rowNumber + '">' + cells.join("") + '</row>';
  });
  return XML_HEADER + '<worksheet xmlns="' + SHEET_NS + '"><cols>' +
    '<col min="1" max="1" width="34" customWidth="1"/><col min="2" max="2" width="30" customWidth="1"/>' +
    '<col min="3" max="3" width="88" customWidth="1"/></cols><sheetData>' + sheetRows.join("") + '</sheetData></worksheet>';
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// XLSX is a ZIP archive. Store the small XML files without compression.
function zipXmlFiles(files) {
  const encoder = new TextEncoder();
  const fileParts = [];
  const directoryParts = [];
  let offset = 0;
  let directorySize = 0;

  for (const [name, xml] of Object.entries(files)) {
    const filename = encoder.encode(name);
    const content = encoder.encode(xml);
    const checksum = crc32(content);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(12, 0x21, true); // DOS date of 1980-01-01.
    local.setUint32(14, checksum, true);
    local.setUint32(18, content.length, true);
    local.setUint32(22, content.length, true);
    local.setUint16(26, filename.length, true);
    fileParts.push(local.buffer, filename, content);

    const directory = new DataView(new ArrayBuffer(46));
    directory.setUint32(0, 0x02014b50, true);
    directory.setUint16(4, 20, true);
    directory.setUint16(6, 20, true);
    directory.setUint16(14, 0x21, true);
    directory.setUint32(16, checksum, true);
    directory.setUint32(20, content.length, true);
    directory.setUint32(24, content.length, true);
    directory.setUint16(28, filename.length, true);
    directory.setUint32(42, offset, true);
    directoryParts.push(directory.buffer, filename);

    offset += local.byteLength + filename.length + content.length;
    directorySize += directory.byteLength + filename.length;
  }

  const fileCount = Object.keys(files).length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, fileCount, true);
  end.setUint16(10, fileCount, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new Blob([...fileParts, ...directoryParts, end.buffer], { type: XLSX_TYPE });
}

function makeTripWorkbook(result) {
  const rows = [
    ["출장여비 계산 내역"],
    ["출발일", result.departure],
    ["복귀일", result.returnDate],
    ["출장 조건", result.context],
    ["예상 지급액 (원)", result.total],
    [],
    ["항목", "금액 (원)", "계산 근거"],
    ...result.rows.map(({ name, amount, basis }) => [name, amount, basis]),
    ...result.notes.map((note) => ["참고", "", note])
  ];
  return zipXmlFiles({
    "[Content_Types].xml": XML_HEADER + '<Types xmlns="' + PACKAGE_NS + '/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>',
    "_rels/.rels": XML_HEADER + '<Relationships xmlns="' + PACKAGE_NS + '/relationships">' +
      '<Relationship Id="rId1" Type="' + OFFICE_REL_NS + '/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": XML_HEADER + '<workbook xmlns="' + SHEET_NS + '" xmlns:r="' + OFFICE_REL_NS + '">' +
      '<sheets><sheet name="출장여비" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": XML_HEADER + '<Relationships xmlns="' + PACKAGE_NS + '/relationships">' +
      '<Relationship Id="rId1" Type="' + OFFICE_REL_NS + '/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="' + OFFICE_REL_NS + '/styles" Target="styles.xml"/></Relationships>',
    "xl/styles.xml": XML_HEADER + '<styleSheet xmlns="' + SHEET_NS + '">' +
      '<fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' +
      '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    "xl/worksheets/sheet1.xml": worksheetXml(rows)
  });
}
