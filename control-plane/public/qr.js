/*
 * Minimal QR code encoder — byte mode, ECC level M, versions 1-10.
 *
 * Dependency-free (no libraries). Adapted from the QR Code generator
 * reference algorithm (Project Nayuki, MIT license). Enough capacity for
 * URLs (v10-M holds ~180 bytes; typical LAN URLs need v3-v4).
 *
 * Browser: window.QrCode.encode(text) -> boolean matrix (row-major),
 *          window.QrCode.render(canvas, text, opts).
 * Node (tests): module.exports = { encode, render }.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.QrCode = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ECC level M (15%): format bits 0b00, codewords/block and blocks/version.
  var ECC_CODEWORDS_PER_BLOCK = [null, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  var ECC_NUM_BLOCKS = [null, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  // Alignment pattern center coordinates per version (index 1..10).
  var ALIGN_POSITIONS = [null,
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  var MAX_VERSION = 10;

  function numRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  function numDataCodewords(ver) {
    return Math.floor(numRawDataModules(ver) / 8) -
      ECC_CODEWORDS_PER_BLOCK[ver] * ECC_NUM_BLOCKS[ver];
  }

  // --- Galois field GF(2^8), primitive polynomial 0x11D ---

  function gfMul(a, b) {
    var r = 0;
    while (b > 0) {
      if (b & 1) r ^= a;
      a = (a << 1) ^ ((a & 0x80) ? 0x11D : 0);
      b >>>= 1;
    }
    return r & 0xFF;
  }

  // Generator polynomial (highest-degree coefficient first, monic).
  function rsGeneratorPoly(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i++) {
      var next = new Array(poly.length + 1);
      for (var j = 0; j <= poly.length; j++) {
        var v = 0;
        if (j < poly.length) v ^= poly[j];
        if (j > 0) v ^= gfMul(poly[j - 1], alphaPow(i));
        next[j] = v & 0xFF;
      }
      poly = next;
    }
    return poly;
  }

  var ALPHA_TABLE = (function () {
    var t = [1];
    for (var i = 1; i < 256; i++) t[i] = gfMul(t[i - 1], 2);
    return t;
  })();
  function alphaPow(i) { return ALPHA_TABLE[i % 255]; }

  // Reed-Solomon remainder (ECC codewords) for one data block.
  function rsRemainder(data, degree) {
    var gen = rsGeneratorPoly(degree);
    var buf = data.slice();
    for (var i = 0; i < degree; i++) buf.push(0);
    for (var k = 0; k < data.length; k++) {
      var factor = buf[k];
      if (factor === 0) continue;
      for (var j = 1; j < gen.length; j++) {
        buf[k + j] ^= gfMul(gen[j], factor);
      }
    }
    return buf.slice(data.length);
  }

  // --- Bit assembly ---

  function buildDataCodewords(bytes, ver) {
    var bits = [];
    function push(val, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    }
    push(4, 4); // byte-mode indicator
    push(bytes.length, ver <= 9 ? 8 : 16); // char count
    for (var i = 0; i < bytes.length; i++) push(bytes[i] & 0xFF, 8);
    var capacity = numDataCodewords(ver) * 8;
    if (bits.length > capacity) return null;
    push(0, Math.min(4, capacity - bits.length)); // terminator
    while (bits.length % 8 !== 0) bits.push(0);
    var pads = [0xEC, 0x11];
    for (var p = 0; bits.length < capacity; p++) push(pads[p % 2], 8);
    var out = [];
    for (var b = 0; b < bits.length; b += 8) {
      var v = 0;
      for (var t = 0; t < 8; t++) v = (v << 1) | bits[b + t];
      out.push(v);
    }
    return out;
  }

  function addEccAndInterleave(dataCw, ver) {
    var numBlocks = ECC_NUM_BLOCKS[ver];
    var blockEccLen = ECC_CODEWORDS_PER_BLOCK[ver];
    var rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    var numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    var shortBlockLen = Math.floor(rawCodewords / numBlocks);
    var blocks = [];
    var k = 0;
    for (var i = 0; i < numBlocks; i++) {
      var dat = dataCw.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      var ecc = rsRemainder(dat, blockEccLen);
      if (i < numShortBlocks) dat.push(0); // placeholder skipped during interleave
      blocks.push(dat.concat(ecc));
    }
    var result = [];
    for (var r = 0; r < blocks[0].length; r++) {
      for (var b = 0; b < blocks.length; b++) {
        if (r !== shortBlockLen - blockEccLen || b >= numShortBlocks) {
          result.push(blocks[b][r]);
        }
      }
    }
    return result;
  }

  // --- Matrix drawing ---

  function formatBits(mask) {
    var data = 0 << 3 | mask; // ECC level M -> 0b00
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function versionBits(ver) {
    var rem = ver;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    return (ver << 12) | rem;
  }

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  function maskFn(id) {
    return function (x, y) {
      switch (id) {
        case 0: return (x + y) % 2 === 0;
        case 1: return y % 2 === 0;
        case 2: return x % 3 === 0;
        case 3: return (x + y) % 3 === 0;
        case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
        case 5: return (x * y) % 2 + (x * y) % 3 === 0;
        case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
        case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
      }
      return false;
    };
  }

  function drawFunctionPatterns(modules, isFunction, ver, size) {
    function set(x, y, dark) {
      modules[y][x] = dark;
      isFunction[y][x] = true;
    }
    function finder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) {
        for (var dx = -4; dx <= 4; dx++) {
          var dist = Math.max(Math.abs(dx), Math.abs(dy));
          var x = cx + dx, y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) {
            set(x, y, dist !== 2 && dist !== 4);
          }
        }
      }
    }
    function alignment(cx, cy) {
      for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
    // Timing patterns.
    for (var i = 0; i < size; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }
    // Finder patterns (all corners but bottom-right).
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);
    // Alignment patterns (skip the three that overlap finders).
    var pos = ALIGN_POSITIONS[ver];
    for (var a = 0; a < pos.length; a++) {
      for (var b = 0; b < pos.length; b++) {
        if (!(a === 0 && b === 0) && !(a === 0 && b === pos.length - 1) &&
            !(a === pos.length - 1 && b === 0)) {
          alignment(pos[a], pos[b]);
        }
      }
    }
    // Format bits (two copies) + the always-dark module.
    var fmt = formatBits(0); // placeholder; rewritten per mask below
    function drawFormat(bits) {
      for (var i = 0; i < 6; i++) set(8, i, getBit(bits, i));
      set(8, 7, getBit(bits, 6));
      set(8, 8, getBit(bits, 7));
      set(7, 8, getBit(bits, 8));
      for (var j = 9; j < 15; j++) set(14 - j, 8, getBit(bits, j));
      for (var m = 0; m < 8; m++) set(size - 1 - m, 8, getBit(bits, m));
      for (var n = 8; n < 15; n++) set(8, size - 15 + n, getBit(bits, n));
      set(size - 8, 8, true);
    }
    drawFormat(fmt);
    // Version information (versions 7+).
    if (ver >= 7) {
      var vbits = versionBits(ver);
      for (var v = 0; v < 18; v++) {
        var bit = getBit(vbits, v);
        var cx = size - 11 + (v % 3);
        var cy = Math.floor(v / 3);
        set(cx, cy, bit);
        set(cy, cx, bit);
      }
    }
    return drawFormat;
  }

  function drawCodewords(modules, isFunction, codewords, size, mask) {
    var i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && i < codewords.length * 8) {
            var bit = getBit(codewords[i >>> 3], 7 - (i & 7));
            modules[y][x] = bit !== mask(x, y);
            i++;
          }
        }
      }
    }
  }

  function penaltyScore(modules, size) {
    var penalty = 0;
    var y, x;
    // N1: runs of >= 5 same-colored modules in rows and columns.
    for (y = 0; y < size; y++) {
      var runColor = modules[y][0], runLen = 1;
      for (x = 1; x < size; x++) {
        if (modules[y][x] === runColor) {
          runLen++;
          if (x === size - 1 && runLen >= 5) penalty += 3 + (runLen - 5);
        } else {
          if (runLen >= 5) penalty += 3 + (runLen - 5);
          runColor = modules[y][x];
          runLen = 1;
        }
      }
    }
    for (x = 0; x < size; x++) {
      var runColorC = modules[0][x], runLenC = 1;
      for (y = 1; y < size; y++) {
        if (modules[y][x] === runColorC) {
          runLenC++;
          if (y === size - 1 && runLenC >= 5) penalty += 3 + (runLenC - 5);
        } else {
          if (runLenC >= 5) penalty += 3 + (runLenC - 5);
          runColorC = modules[y][x];
          runLenC = 1;
        }
      }
    }
    // N2: 2x2 blocks of the same color.
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
          penalty += 3;
        }
      }
    }
    // N3: finder-like 1:1:3:1:1 core with 4 light modules on one side
    // (either orientation: 00001011101 or 10111010000).
    function finderLike(line) {
      var count = 0;
      for (var i = 0; i + 11 <= line.length; i++) {
        var light4a = !line[i] && !line[i + 1] && !line[i + 2] && !line[i + 3];
        var coreA = line[i + 4] && !line[i + 5] && line[i + 6] && line[i + 7] &&
          line[i + 8] && !line[i + 9] && line[i + 10];
        var coreB = line[i] && !line[i + 1] && line[i + 2] && line[i + 3] &&
          line[i + 4] && !line[i + 5] && line[i + 6];
        var light4b = !line[i + 7] && !line[i + 8] && !line[i + 9] && !line[i + 10];
        if ((light4a && coreA) || (coreB && light4b)) count++;
      }
      return count;
    }
    for (y = 0; y < size; y++) {
      penalty += finderLike(modules[y]) * 40;
    }
    for (x = 0; x < size; x++) {
      var col = [];
      for (y = 0; y < size; y++) col.push(modules[y][x]);
      penalty += finderLike(col) * 40;
    }
    // N4: dark-module balance.
    var dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (modules[y][x]) dark++;
    var total = size * size;
    var k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    penalty += k * 10;
    return penalty;
  }

  // Encode text (UTF-8) into a boolean matrix (row-major, modules[y][x]).
  function encode(text) {
    // UTF-8 encode.
    var bytes;
    if (typeof TextEncoder !== 'undefined') {
      bytes = Array.prototype.slice.call(new TextEncoder().encode(text));
    } else {
      bytes = [];
      for (var i = 0; i < text.length; i++) {
        var c = text.charCodeAt(i);
        if (c < 0x80) bytes.push(c);
        else if (c < 0x800) { bytes.push(0xC0 | (c >> 6), 0x80 | (c & 63)); }
        else { bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
      }
    }
    var ver = 1;
    var dataCw = null;
    for (; ver <= MAX_VERSION; ver++) {
      dataCw = buildDataCodewords(bytes, ver);
      if (dataCw) break;
    }
    if (!dataCw) throw new Error('QR: text too long (max ~180 bytes at version 10-M)');
    var codewords = addEccAndInterleave(dataCw, ver);
    var size = ver * 4 + 17;
    var best = null, bestPenalty = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var modules = [];
      for (var r = 0; r < size; r++) modules.push(new Array(size).fill(false));
      var isFunction = [];
      for (var r2 = 0; r2 < size; r2++) isFunction.push(new Array(size).fill(false));
      var redrawFormat = drawFunctionPatterns(modules, isFunction, ver, size);
      drawCodewords(modules, isFunction, codewords, size, maskFn(mask));
      redrawFormat(formatBits(mask)); // stamp the real mask into the format bits
      var penalty = penaltyScore(modules, size);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        best = modules;
      }
    }
    return best;
  }

  // Render a matrix onto a canvas element (white quiet zone, dark modules).
  function render(canvas, text, opts) {
    opts = opts || {};
    var matrix = encode(text);
    var size = matrix.length;
    var scale = opts.scale || 6;
    var quiet = opts.quietZone != null ? opts.quietZone : 4;
    var dim = (size + quiet * 2) * scale;
    canvas.width = dim;
    canvas.height = dim;
    var ctx = canvas.getContext('2d');
    if (!ctx) return matrix;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = opts.dark || '#111827';
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (matrix[y][x]) {
          ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
        }
      }
    }
    return matrix;
  }

  return { encode: encode, render: render };
});
