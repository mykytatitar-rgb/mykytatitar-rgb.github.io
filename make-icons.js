/* PNG-іконки «Справ» з логотипа icon.svg — без жодних бібліотек.

     node make-icons.js

   iPhone на головний екран бере лише apple-touch-icon у PNG, Android хоче
   PNG 192 і 512 та окрему «маскувальну» іконку, яку система сама обрізає
   колом чи квадратом. Знак — галочка з двох відрізків із круглими кінцями
   на заокругленому квадраті з градієнтом; малюємо відстанями до фігур зі
   згладжуванням і пишемо PNG власноруч (zlib є в Node). Числа ті самі, що
   в icon.svg: змінився логотип — змініть і тут. */

'use strict';

var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var OUT = __dirname;

var C1 = [0x5F, 0xB3, 0xA1], C2 = [0x2F, 0x7D, 0x6C];     // градієнт фону
var SEGS = [[150, 268, 226, 344], [226, 344, 366, 186]];
var STROKE = 23;                                            // половина товщини лінії (46)

function segDist(px, py, s) {
  var ax = s[0], ay = s[1], bx = s[2], by = s[3];
  var dx = bx - ax, dy = by - ay;
  var t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// відстань до заокругленого квадрата 0..512 з радіусом rx (мінус — усередині)
function rectDist(px, py, rx) {
  var qx = Math.abs(px - 256) - (256 - rx), qy = Math.abs(py - 256) - (256 - rx);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rx;
}

/* size — розмір у пікселях; rx — заокруглення фону (0 — до краю);
   k — масштаб знака навколо центру (маскувальна іконка — менший). */
function render(size, rx, k) {
  var px = Buffer.alloc(size * size * 4);
  var f = 512 / size;
  for (var y = 0; y < size; y++) {
    for (var x = 0; x < size; x++) {
      var X = (x + 0.5) * f, Y = (y + 0.5) * f;
      var bg = rx ? Math.max(0, Math.min(1, 0.5 - rectDist(X, Y, rx) / f)) : 1;
      var gx = 256 + (X - 256) / k, gy = 256 + (Y - 256) / k;
      var d = Infinity;
      for (var i = 0; i < SEGS.length; i++) d = Math.min(d, segDist(gx, gy, SEGS[i]) - STROKE);
      var white = Math.max(0, Math.min(1, 0.5 - (d * k) / f));
      var t = Math.max(0, Math.min(1, (X + Y) / 1024));
      var o = (y * size + x) * 4;
      for (var c = 0; c < 3; c++) {
        var base = C1[c] + (C2[c] - C1[c]) * t;
        px[o + c] = Math.round(base + (255 - base) * white);
      }
      px[o + 3] = Math.round(255 * bg);
    }
  }
  return px;
}

var CRC = (function () {
  var t = [];
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  var len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  var td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  var crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8 біт, RGBA
  var raw = Buffer.alloc(size * (size * 4 + 1));
  for (var y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

var ICONS = [
  { name: 'icon-192.png', size: 192, rx: 112, k: 1 },
  { name: 'icon-512.png', size: 512, rx: 112, k: 1 },
  // маскувальна: фон до краю, знак у безпечному колі (80% діаметра)
  { name: 'icon-maskable-512.png', size: 512, rx: 0, k: 0.72 },
  // iPhone сам заокруглює кути — фон до краю
  { name: 'apple-touch-icon.png', size: 180, rx: 0, k: 0.86 }
];

ICONS.forEach(function (ic) {
  var file = path.join(OUT, ic.name);
  fs.writeFileSync(file, png(ic.size, render(ic.size, ic.rx, ic.k)));
  console.log(ic.name + ' — ' + ic.size + '×' + ic.size + ', ' + fs.statSync(file).size + ' Б');
});
