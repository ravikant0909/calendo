import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The dashboard's inline QR generator had 3 bugs that made codes render but never
// scan: wrong EC level in the format info, a broken Reed-Solomon encoder, and
// transposed format-bit placement. These tests guard all three. (End-to-end
// scannability was verified separately by decoding generated codes with OpenCV.)
function loadQR() {
  const html = readFileSync(join(process.cwd(), 'public/dashboard/index.html'), 'utf8');
  const start = html.indexOf('const QR = (() => {');
  const endMarker = 'return { generate, renderCanvas };\n    })();';
  let src = html.slice(start, html.indexOf(endMarker) + endMarker.length);
  src = src.replace('return { generate, renderCanvas };', 'return { generate, renderCanvas, encodeData, getVersion };');
  const expr = src.replace(/^const QR =\s*/, '').replace(/;\s*$/, '');
  // eslint-disable-next-line no-eval
  return eval(expr);
}

// Independent Reed-Solomon (Nayuki shift-register) over GF(256)/0x11d.
function rsRef(data, deg) {
  const exp = new Array(512), log = new Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) { exp[i] = x; log[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  const gm = (a, b) => (a === 0 || b === 0) ? 0 : exp[log[a] + log[b]];
  const coefs = new Array(deg).fill(0); coefs[deg - 1] = 1;
  let root = 1;
  for (let i = 0; i < deg; i++) {
    for (let j = 0; j < deg; j++) { coefs[j] = gm(coefs[j], root); if (j + 1 < deg) coefs[j] ^= coefs[j + 1]; }
    root = gm(root, 2);
  }
  const res = new Array(deg).fill(0);
  for (const b of data) {
    const f = b ^ res[0]; res.shift(); res.push(0);
    for (let i = 0; i < deg; i++) res[i] ^= gm(coefs[i], f);
  }
  return res;
}

describe('Dashboard QR generator produces scannable codes', () => {
  const QR = loadQR();
  const url = 'https://calendo.dev/alex-host';
  const v = QR.getVersion(new TextEncoder().encode(url).length);
  const cw = QR.encodeData(url, v);

  it('selects version 3 / 70 codewords for a typical booking URL', () => {
    expect(v).toBe(3);
    expect(cw.length).toBe(70);
  });

  it('Reed-Solomon EC codewords match the authoritative algorithm', () => {
    const data = cw.slice(0, 44);
    const ec = cw.slice(44);
    expect(rsRef(data, 26)).toEqual(ec);
  });

  it('format info is valid BCH and declares EC level M, placed at spec positions', () => {
    const { matrix } = QR.generate(url);
    // spec copy-1 positions for format bits 0..14 (row, col)
    const pos = [[0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[7,8],[8,8],[8,7],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0]];
    let val = 0;
    pos.forEach(([r, c], i) => { val |= (matrix[r][c] & 1) << i; });
    const unmasked = val ^ 0x5412;
    const data5 = unmasked >> 10;
    let rem = data5;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) * 0x537);
    expect((data5 << 10) | rem).toBe(unmasked);  // valid BCH codeword
    expect((data5 >> 3) & 3).toBe(0);            // EC level field == M
  });
});
