import { EpubReaderV2Error, type EpubReaderV2Progress } from '../types';

function describeFirstBytes(buffer: ArrayBuffer, max = 16): string {
  const bytes = new Uint8Array(buffer, 0, Math.min(max, buffer.byteLength));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

function looksLikeZip(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const b = new Uint8Array(buffer, 0, 4);
  return b[0] === 0x50 && b[1] === 0x4b; // "PK"
}

export async function fetchArrayBufferWithProgress(options: {
  url: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  onProgress?: (progress: EpubReaderV2Progress) => void;
}): Promise<ArrayBuffer> {
  const { url, headers, signal, onProgress } = options;
  let response: Response;
  try {
    response = await fetch(url, { headers, signal, redirect: 'follow' });
  } catch (err) {
    throw new EpubReaderV2Error('FETCH_FAILED', `Failed to fetch EPUB: ${url}`, err);
  }

  if (!response.ok) {
    throw new EpubReaderV2Error('FETCH_FAILED', `Failed to fetch EPUB (HTTP ${response.status}): ${url}`);
  }

  const totalBytesHeader = response.headers.get('Content-Length');
  const totalBytes = totalBytesHeader ? Number(totalBytesHeader) : undefined;
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    onProgress?.({ loadedBytes: buffer.byteLength, totalBytes });
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loadedBytes += value.byteLength;
    onProgress?.({ loadedBytes, totalBytes });
  }

  const out = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (typeof totalBytes === 'number' && Number.isFinite(totalBytes) && loadedBytes !== totalBytes) {
    throw new EpubReaderV2Error(
      'FETCH_FAILED',
      `EPUB download incomplete for ${url} (loaded ${loadedBytes} bytes, expected ${totalBytes} bytes)`,
      { loadedBytes, totalBytes },
    );
  }
  if (!looksLikeZip(out.buffer)) {
    throw new EpubReaderV2Error(
      'FETCH_FAILED',
      `Downloaded file is not a ZIP/EPUB for ${url} (first bytes: ${describeFirstBytes(out.buffer)})`,
    );
  }
  return out.buffer;
}
