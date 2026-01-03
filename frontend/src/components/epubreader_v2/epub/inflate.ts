type HuffmanTable = {
  tableBits: number;
  table: Int32Array;
};

class BitReader {
  private readonly data: Uint8Array;
  private pos = 0;
  private bitBuf = 0;
  private bitLen = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  private ensureBits(count: number) {
    while (this.bitLen < count) {
      if (this.pos >= this.data.length) {
        throw new Error(
          `Unexpected end of data (pos=${this.pos} len=${this.data.length} bitLen=${this.bitLen} need=${count})`,
        );
      }
      this.bitBuf |= this.data[this.pos++] << this.bitLen;
      this.bitLen += 8;
    }
  }

  readBits(count: number): number {
    if (count === 0) return 0;
    if (count < 0 || count > 24) throw new Error(`Invalid bit count: ${count}`);
    this.ensureBits(count);
    const mask = (1 << count) - 1;
    const out = this.bitBuf & mask;
    this.bitBuf >>>= count;
    this.bitLen -= count;
    return out;
  }

  peekBits(count: number): number {
    if (count === 0) return 0;
    if (count < 0 || count > 24) throw new Error(`Invalid bit count: ${count}`);
    this.ensureBits(count);
    const mask = (1 << count) - 1;
    return this.bitBuf & mask;
  }

  dropBits(count: number) {
    if (count === 0) return;
    this.ensureBits(count);
    this.bitBuf >>>= count;
    this.bitLen -= count;
  }

  alignToByte() {
    const drop = this.bitLen & 7;
    if (drop) this.dropBits(drop);
  }

  readAlignedBytes(count: number): Uint8Array {
    this.alignToByte();
    if (this.pos + count > this.data.length) {
      throw new Error(
        `Unexpected end of data (pos=${this.pos} len=${this.data.length} needBytes=${count})`,
      );
    }
    const out = this.data.subarray(this.pos, this.pos + count);
    this.pos += count;
    return out;
  }
}

function reverseBits(value: number, bitCount: number): number {
  let out = 0;
  for (let i = 0; i < bitCount; i++) {
    out = (out << 1) | (value & 1);
    value >>>= 1;
  }
  return out;
}

function buildHuffman(codeLengths: ArrayLike<number>, tableBits: number): HuffmanTable {
  const maxLen = Math.min(15, Math.max(0, ...Array.from(codeLengths)));
  const useTableBits = Math.max(1, Math.min(15, Math.max(maxLen, tableBits)));
  const tableSize = 1 << useTableBits;
  const table = new Int32Array(tableSize);

  const blCount = new Int32Array(useTableBits + 1);
  for (let i = 0; i < codeLengths.length; i++) {
    const len = codeLengths[i] | 0;
    if (len > 0) blCount[len]++;
  }

  const nextCode = new Int32Array(useTableBits + 1);
  let code = 0;
  for (let bits = 1; bits <= useTableBits; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  for (let symbol = 0; symbol < codeLengths.length; symbol++) {
    const len = codeLengths[symbol] | 0;
    if (len === 0) continue;
    if (len > useTableBits) throw new Error('Huffman code length exceeds table bits');
    const currentCode = nextCode[len]++;
    const rev = reverseBits(currentCode, len);
    const packed = (len << 16) | symbol;
    const step = 1 << len;
    for (let i = rev; i < tableSize; i += step) {
      table[i] = packed;
    }
  }

  return { tableBits: useTableBits, table };
}

function decodeSymbol(reader: BitReader, huffman: HuffmanTable): number {
  const bits = reader.peekBits(huffman.tableBits);
  const packed = huffman.table[bits];
  const len = packed >>> 16;
  if (len === 0) throw new Error('Invalid Huffman code');
  reader.dropBits(len);
  return packed & 0xffff;
}

const LEN_BASE = new Int32Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163,
  195, 227, 258,
]);
const LEN_EXTRA = new Int8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]);
const DIST_BASE = new Int32Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577,
]);
const DIST_EXTRA = new Int8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);

function buildFixedTables(): { litLen: HuffmanTable; dist: HuffmanTable } {
  const litLenLengths = new Uint8Array(288);
  for (let i = 0; i <= 143; i++) litLenLengths[i] = 8;
  for (let i = 144; i <= 255; i++) litLenLengths[i] = 9;
  for (let i = 256; i <= 279; i++) litLenLengths[i] = 7;
  for (let i = 280; i <= 287; i++) litLenLengths[i] = 8;

  const distLengths = new Uint8Array(32);
  distLengths.fill(5);

  return {
    litLen: buildHuffman(litLenLengths, 9),
    dist: buildHuffman(distLengths, 5),
  };
}

function ensureCapacity(buffer: Uint8Array, needed: number): Uint8Array {
  if (buffer.length >= needed) return buffer;
  let nextLen = buffer.length || 1024;
  while (nextLen < needed) nextLen *= 2;
  const next = new Uint8Array(nextLen);
  next.set(buffer);
  return next;
}

export function inflateRaw(compressed: Uint8Array, expectedSize?: number): Uint8Array {
  const reader = new BitReader(compressed);
  let out: Uint8Array = new Uint8Array(expectedSize ?? 0);
  let outPos = 0;

  const fixed = buildFixedTables();

  while (true) {
    const bfinal = reader.readBits(1);
    const btype = reader.readBits(2);

    if (btype === 0) {
      reader.alignToByte();
      const len = reader.readBits(16);
      const nlen = reader.readBits(16);
      if (((len ^ 0xffff) & 0xffff) !== nlen) {
        throw new Error('Invalid uncompressed block length');
      }
      out = ensureCapacity(out, outPos + len);
      const bytes = reader.readAlignedBytes(len);
      out.set(bytes, outPos);
      outPos += len;
    } else if (btype === 1 || btype === 2) {
      let litLenTable: HuffmanTable;
      let distTable: HuffmanTable;

      if (btype === 1) {
        litLenTable = fixed.litLen;
        distTable = fixed.dist;
      } else {
        const hlit = reader.readBits(5) + 257;
        const hdist = reader.readBits(5) + 1;
        const hclen = reader.readBits(4) + 4;

        const codeLenOrder = [
          16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
        ];
        const codeLenLengths = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) {
          codeLenLengths[codeLenOrder[i]] = reader.readBits(3);
        }
        const codeLenTable = buildHuffman(codeLenLengths, 7);

        const totalCodes = hlit + hdist;
        const lengths = new Uint8Array(totalCodes);
        let i = 0;
        while (i < totalCodes) {
          const sym = decodeSymbol(reader, codeLenTable);
          if (sym <= 15) {
            lengths[i++] = sym;
            continue;
          }
          if (sym === 16) {
            if (i === 0) throw new Error('Repeat previous length with no previous');
            const repeat = reader.readBits(2) + 3;
            const prev = lengths[i - 1];
            lengths.fill(prev, i, i + repeat);
            i += repeat;
            continue;
          }
          if (sym === 17) {
            const repeat = reader.readBits(3) + 3;
            lengths.fill(0, i, i + repeat);
            i += repeat;
            continue;
          }
          if (sym === 18) {
            const repeat = reader.readBits(7) + 11;
            lengths.fill(0, i, i + repeat);
            i += repeat;
            continue;
          }
          throw new Error('Invalid code length symbol');
        }

        const litLenLengths = lengths.subarray(0, hlit);
        const distLengths = lengths.subarray(hlit);

        litLenTable = buildHuffman(litLenLengths, 9);
        const allZero = Array.from(distLengths).every((n) => n === 0);
        if (allZero) {
          const single = new Uint8Array(1);
          single[0] = 1;
          distTable = buildHuffman(single, 1);
        } else {
          distTable = buildHuffman(distLengths, 5);
        }
      }

      while (true) {
        const sym = decodeSymbol(reader, litLenTable);
        if (sym < 256) {
          out = ensureCapacity(out, outPos + 1);
          out[outPos++] = sym;
          continue;
        }
        if (sym === 256) break;

        const lenIndex = sym - 257;
        if (lenIndex < 0 || lenIndex >= LEN_BASE.length) {
          throw new Error('Invalid length code');
        }
        const extraLenBits = LEN_EXTRA[lenIndex];
        const length = LEN_BASE[lenIndex] + (extraLenBits ? reader.readBits(extraLenBits) : 0);

        const distSym = decodeSymbol(reader, distTable);
        if (distSym < 0 || distSym >= DIST_BASE.length) throw new Error('Invalid distance code');
        const extraDistBits = DIST_EXTRA[distSym];
        const distance = DIST_BASE[distSym] + (extraDistBits ? reader.readBits(extraDistBits) : 0);

        if (distance <= 0 || distance > outPos) throw new Error('Invalid distance');

        out = ensureCapacity(out, outPos + length);
        for (let i = 0; i < length; i++) {
          out[outPos] = out[outPos - distance];
          outPos++;
        }
      }
    } else {
      throw new Error('Invalid block type');
    }

    if (bfinal) break;
  }

  return out.subarray(0, outPos);
}
