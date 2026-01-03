export function decodeText(bytes: Uint8Array, fallbackEncoding: string = 'utf-8'): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }

  const asciiHead = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  const encodingMatch = asciiHead.match(/encoding\s*=\s*["']([^"']+)["']/i);
  const encoding = encodingMatch?.[1] ?? fallbackEncoding;
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder(fallbackEncoding).decode(bytes);
  }
}

