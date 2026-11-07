// 外部ライブラリなしで PDF を組み立てる（各ページを JPEG 画像として埋め込む）
import { PAGE_W, PAGE_H, renderPage, preloadImages } from './render.js';
import { openDialog, toast, saveFile, safeFileName } from './ui.js';

const PX_W = 1240; // 約150dpi（A4）
const PX_H = Math.round((PX_W * PAGE_H) / PAGE_W);
const PT_W = 595.28;
const PT_H = +((PT_W * PAGE_H) / PAGE_W).toFixed(2);

function pdfText(s) {
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0');
  return `<${hex.toUpperCase()}>`;
}

export async function pagesToPdf(pages, title, onProgress) {
  await preloadImages(pages);
  const canvas = document.createElement('canvas');
  canvas.width = PX_W;
  canvas.height = PX_H;
  const ctx = canvas.getContext('2d');
  const k = PX_W / PAGE_W;

  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let len = 0;
  const push = (d) => {
    const b = typeof d === 'string' ? enc.encode(d) : d;
    chunks.push(b);
    len += b.length;
  };
  const begin = (num) => {
    offsets[num] = len;
    push(`${num} 0 obj\n`);
  };

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const n = pages.length;
  const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ');
  begin(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  begin(2);
  push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);
  begin(3);
  push(`<< /Title ${pdfText(title)} /Producer (iPad Note) >>\nendobj\n`);

  for (let i = 0; i < n; i++) {
    const pageNum = 4 + i * 3;
    const contentNum = pageNum + 1;
    const imgNum = pageNum + 2;

    ctx.setTransform(k, 0, 0, k, 0, 0);
    renderPage(ctx, pages[i]);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    const img = new Uint8Array(await blob.arrayBuffer());

    begin(pageNum);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PT_W} ${PT_H}] ` +
        `/Resources << /XObject << /Im0 ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    const content = `q ${PT_W} 0 0 ${PT_H} 0 0 cm /Im0 Do Q`;
    begin(contentNum);
    push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    begin(imgNum);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${PX_W} /Height ${PX_H} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`,
    );
    push(img);
    push('\nendstream\nendobj\n');

    onProgress && onProgress(i + 1, n);
    await new Promise((r) => setTimeout(r, 0));
  }

  const total = 3 + n * 3;
  const xrefAt = len;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}

export async function exportPdfFlow(pages, name) {
  const t = toast('PDFを作成中…', { persist: true });
  try {
    const blob = await pagesToPdf(pages, name, (i, n) => t.update(`PDFを作成中… ${i}/${n}`));
    t.close();
    const filename = safeFileName(name) + '.pdf';
    await openDialog({
      title: 'PDFを作成しました',
      message: `${filename}（${pages.length}ページ）`,
      buttons: [
        { label: '閉じる' },
        { label: '保存・共有', primary: true, onClick: () => saveFile(blob, filename) },
      ],
    });
  } catch (e) {
    console.error(e);
    t.close();
    toast('PDFの作成に失敗しました');
  }
}
