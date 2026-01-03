// EPUB Container Module
// Handles ZIP parsing and resource extraction
// Uses a lightweight custom ZIP parser (no external dependencies)

export interface ZipEntry {
  filename: string
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  offset: number
  isDirectory: boolean
}

export interface EpubContainer {
  entries: Map<string, ZipEntry>
  readEntry(path: string): Promise<Uint8Array>
  readText(path: string): Promise<string>
  getOPFPath(): Promise<string>
  close(): void
}

// ZIP constants
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const COMPRESSION_STORED = 0
const COMPRESSION_DEFLATE = 8

export class ZipContainer implements EpubContainer {
  private data: ArrayBuffer
  private view: DataView
  public entries: Map<string, ZipEntry> = new Map()
  private textDecoder = new TextDecoder('utf-8')

  private constructor(data: ArrayBuffer) {
    this.data = data
    this.view = new DataView(data)
  }

  static async fromBlob(blob: Blob): Promise<ZipContainer> {
    const data = await blob.arrayBuffer()
    const container = new ZipContainer(data)
    await container.parse()
    return container
  }

  static async fromArrayBuffer(data: ArrayBuffer): Promise<ZipContainer> {
    const container = new ZipContainer(data)
    await container.parse()
    return container
  }

  private async parse(): Promise<void> {
    // Find end of central directory
    const eocdOffset = this.findEOCD()
    if (eocdOffset === -1) {
      throw new Error('Invalid ZIP file: End of Central Directory not found')
    }

    // Read EOCD
    const centralDirOffset = this.view.getUint32(eocdOffset + 16, true)
    const entryCount = this.view.getUint16(eocdOffset + 10, true)

    // Parse central directory
    let offset = centralDirOffset
    for (let i = 0; i < entryCount; i++) {
      const entry = this.parseCentralDirectoryEntry(offset)
      this.entries.set(entry.filename, entry)
      offset += 46 + entry.filename.length +
        this.view.getUint16(offset + 30, true) + // extra field length
        this.view.getUint16(offset + 32, true)   // comment length
    }
  }

  private findEOCD(): number {
    // Search backwards for EOCD signature
    const minOffset = Math.max(0, this.data.byteLength - 65536 - 22)
    for (let i = this.data.byteLength - 22; i >= minOffset; i--) {
      if (this.view.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
        return i
      }
    }
    return -1
  }

  private parseCentralDirectoryEntry(offset: number): ZipEntry {
    const signature = this.view.getUint32(offset, true)
    if (signature !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('Invalid central directory entry')
    }

    const compressionMethod = this.view.getUint16(offset + 10, true)
    const compressedSize = this.view.getUint32(offset + 20, true)
    const uncompressedSize = this.view.getUint32(offset + 24, true)
    const filenameLength = this.view.getUint16(offset + 28, true)
    const localHeaderOffset = this.view.getUint32(offset + 42, true)

    const filenameBytes = new Uint8Array(this.data, offset + 46, filenameLength)
    const filename = this.textDecoder.decode(filenameBytes)

    return {
      filename,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      offset: localHeaderOffset,
      isDirectory: filename.endsWith('/'),
    }
  }

  async readEntry(path: string): Promise<Uint8Array> {
    // Normalize path
    const normalizedPath = path.replace(/^\//, '')
    const entry = this.entries.get(normalizedPath)

    if (!entry) {
      throw new Error(`Entry not found: ${path}`)
    }

    if (entry.isDirectory) {
      throw new Error(`Cannot read directory: ${path}`)
    }

    // Read local file header
    const localOffset = entry.offset
    const signature = this.view.getUint32(localOffset, true)

    if (signature !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error('Invalid local file header')
    }

    const filenameLength = this.view.getUint16(localOffset + 26, true)
    const extraLength = this.view.getUint16(localOffset + 28, true)
    const dataOffset = localOffset + 30 + filenameLength + extraLength

    const compressedData = new Uint8Array(this.data, dataOffset, entry.compressedSize)

    if (entry.compressionMethod === COMPRESSION_STORED) {
      return compressedData
    }

    if (entry.compressionMethod === COMPRESSION_DEFLATE) {
      return await this.inflate(compressedData)
    }

    throw new Error(`Unsupported compression method: ${entry.compressionMethod}`)
  }

  async readText(path: string): Promise<string> {
    const data = await this.readEntry(path)
    return this.textDecoder.decode(data)
  }

  private async inflate(data: Uint8Array): Promise<Uint8Array> {
    // Use native DecompressionStream if available
    if ('DecompressionStream' in globalThis) {
      const ds = new DecompressionStream('deflate-raw')
      const writer = ds.writable.getWriter()
      writer.write(data)
      writer.close()

      const reader = ds.readable.getReader()
      const chunks: Uint8Array[] = []

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }

      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const result = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
      }
      return result
    }

    // Fallback: use pako-style inflate (minimal implementation)
    return this.inflateRaw(data)
  }

  private inflateRaw(data: Uint8Array): Uint8Array {
    // Minimal DEFLATE decompressor
    // This is a simplified implementation - in production, consider importing pako
    const bits = new BitReader(data)
    const output: number[] = []

    while (true) {
      const bfinal = bits.readBits(1)
      const btype = bits.readBits(2)

      if (btype === 0) {
        // Stored block
        bits.alignToByte()
        const len = bits.readBits(16)
        bits.readBits(16) // nlen (complement)
        for (let i = 0; i < len; i++) {
          output.push(bits.readBits(8))
        }
      } else if (btype === 1 || btype === 2) {
        // Huffman compressed block
        const { literalTree, distanceTree } = btype === 1
          ? this.getFixedHuffmanTrees()
          : this.getDynamicHuffmanTrees(bits)

        while (true) {
          const literal = this.decodeHuffman(bits, literalTree)
          if (literal < 256) {
            output.push(literal)
          } else if (literal === 256) {
            break
          } else {
            const lengthCode = literal - 257
            const length = this.getLengthValue(lengthCode, bits)
            const distCode = this.decodeHuffman(bits, distanceTree)
            const distance = this.getDistanceValue(distCode, bits)

            const start = output.length - distance
            for (let i = 0; i < length; i++) {
              output.push(output[start + i])
            }
          }
        }
      } else {
        throw new Error('Invalid DEFLATE block type')
      }

      if (bfinal) break
    }

    return new Uint8Array(output)
  }

  private getFixedHuffmanTrees(): { literalTree: HuffmanTree; distanceTree: HuffmanTree } {
    // Fixed Huffman codes as per RFC 1951
    const literalLengths = new Uint8Array(288)
    for (let i = 0; i <= 143; i++) literalLengths[i] = 8
    for (let i = 144; i <= 255; i++) literalLengths[i] = 9
    for (let i = 256; i <= 279; i++) literalLengths[i] = 7
    for (let i = 280; i <= 287; i++) literalLengths[i] = 8

    const distanceLengths = new Uint8Array(32).fill(5)

    return {
      literalTree: HuffmanTree.fromLengths(literalLengths),
      distanceTree: HuffmanTree.fromLengths(distanceLengths),
    }
  }

  private getDynamicHuffmanTrees(bits: BitReader): { literalTree: HuffmanTree; distanceTree: HuffmanTree } {
    const hlit = bits.readBits(5) + 257
    const hdist = bits.readBits(5) + 1
    const hclen = bits.readBits(4) + 4

    const codeLengthOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]
    const codeLengths = new Uint8Array(19)

    for (let i = 0; i < hclen; i++) {
      codeLengths[codeLengthOrder[i]] = bits.readBits(3)
    }

    const codeLengthTree = HuffmanTree.fromLengths(codeLengths)

    const lengths = new Uint8Array(hlit + hdist)
    let i = 0

    while (i < lengths.length) {
      const code = this.decodeHuffman(bits, codeLengthTree)

      if (code < 16) {
        lengths[i++] = code
      } else if (code === 16) {
        const repeat = bits.readBits(2) + 3
        const value = lengths[i - 1]
        for (let j = 0; j < repeat; j++) lengths[i++] = value
      } else if (code === 17) {
        const repeat = bits.readBits(3) + 3
        for (let j = 0; j < repeat; j++) lengths[i++] = 0
      } else if (code === 18) {
        const repeat = bits.readBits(7) + 11
        for (let j = 0; j < repeat; j++) lengths[i++] = 0
      }
    }

    return {
      literalTree: HuffmanTree.fromLengths(lengths.slice(0, hlit)),
      distanceTree: HuffmanTree.fromLengths(lengths.slice(hlit)),
    }
  }

  private decodeHuffman(bits: BitReader, tree: HuffmanTree): number {
    let node = tree.root
    while (node.left || node.right) {
      const bit = bits.readBits(1)
      node = bit ? node.right! : node.left!
    }
    return node.value!
  }

  private getLengthValue(code: number, bits: BitReader): number {
    const lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
    const lengthExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
    return lengthBase[code] + bits.readBits(lengthExtra[code])
  }

  private getDistanceValue(code: number, bits: BitReader): number {
    const distBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
    const distExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
    return distBase[code] + bits.readBits(distExtra[code])
  }

  async getOPFPath(): Promise<string> {
    const containerXml = await this.readText('META-INF/container.xml')
    const parser = new DOMParser()
    const doc = parser.parseFromString(containerXml, 'application/xml')

    const rootfile = doc.querySelector('rootfile')
    if (!rootfile) {
      throw new Error('No rootfile found in container.xml')
    }

    const fullPath = rootfile.getAttribute('full-path')
    if (!fullPath) {
      throw new Error('Rootfile has no full-path attribute')
    }

    return fullPath
  }

  close(): void {
    // Clean up resources
    this.entries.clear()
  }
}

// Bit reader helper class
class BitReader {
  private data: Uint8Array
  private bytePos = 0
  private bitPos = 0

  constructor(data: Uint8Array) {
    this.data = data
  }

  readBits(count: number): number {
    let result = 0
    let bitsRead = 0

    while (bitsRead < count) {
      if (this.bytePos >= this.data.length) {
        throw new Error('Unexpected end of data')
      }

      const bitsAvailable = 8 - this.bitPos
      const bitsToRead = Math.min(count - bitsRead, bitsAvailable)

      const mask = (1 << bitsToRead) - 1
      const bits = (this.data[this.bytePos] >> this.bitPos) & mask

      result |= bits << bitsRead
      bitsRead += bitsToRead
      this.bitPos += bitsToRead

      if (this.bitPos >= 8) {
        this.bitPos = 0
        this.bytePos++
      }
    }

    return result
  }

  alignToByte(): void {
    if (this.bitPos > 0) {
      this.bitPos = 0
      this.bytePos++
    }
  }
}

// Huffman tree helper class
interface HuffmanNode {
  left?: HuffmanNode
  right?: HuffmanNode
  value?: number
}

class HuffmanTree {
  root: HuffmanNode = {}

  static fromLengths(lengths: Uint8Array): HuffmanTree {
    const tree = new HuffmanTree()

    // Count code lengths
    const maxLength = Math.max(...lengths)
    const blCount = new Uint16Array(maxLength + 1)
    for (const length of lengths) {
      if (length > 0) blCount[length]++
    }

    // Calculate starting codes
    const nextCode = new Uint16Array(maxLength + 1)
    let code = 0
    for (let bits = 1; bits <= maxLength; bits++) {
      code = (code + blCount[bits - 1]) << 1
      nextCode[bits] = code
    }

    // Build tree
    for (let n = 0; n < lengths.length; n++) {
      const len = lengths[n]
      if (len > 0) {
        tree.insert(nextCode[len]++, len, n)
      }
    }

    return tree
  }

  private insert(code: number, length: number, value: number): void {
    let node = this.root

    for (let i = length - 1; i >= 0; i--) {
      const bit = (code >> i) & 1
      if (bit) {
        if (!node.right) node.right = {}
        node = node.right
      } else {
        if (!node.left) node.left = {}
        node = node.left
      }
    }

    node.value = value
  }
}
