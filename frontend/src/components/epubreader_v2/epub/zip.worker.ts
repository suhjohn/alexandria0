import { ZipArchive } from './zip';

type WorkerRequest =
  | { id: number; type: 'load'; buffer: ArrayBuffer }
  | { id: number; type: 'read'; path: string }
  | { id: number; type: 'list' }
  | { id: number; type: 'dispose' };

type WorkerResponse =
  | { id: number; ok: true; type: 'load'; files: string[] }
  | { id: number; ok: true; type: 'list'; files: string[] }
  | { id: number; ok: true; type: 'read'; path: string; bytes: ArrayBuffer }
  | {
      id: number;
      ok: false;
      error: string;
      stack?: string;
      context?: {
        reqType: WorkerRequest['type'];
        path?: string;
        archiveByteLength?: number;
        fileCount?: number;
      };
    };

let zip: ZipArchive | null = null;

function toTransferable(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  const respond = (res: WorkerResponse, transfer?: Transferable[]) => {
    (self as unknown as Worker).postMessage(res, transfer ?? []);
  };

  try {
    if (req.type === 'load') {
      zip = new ZipArchive(req.buffer);
      const files = zip.list();
      respond({ id: req.id, ok: true, type: 'load', files });
      return;
    }
    if (req.type === 'dispose') {
      zip = null;
      respond({ id: req.id, ok: true, type: 'list', files: [] });
      return;
    }
    if (!zip) throw new Error('ZIP archive not loaded');
    if (req.type === 'list') {
      respond({ id: req.id, ok: true, type: 'list', files: zip.list() });
      return;
    }
    if (req.type === 'read') {
      const bytes = zip.readEntry(req.path);
      const buffer = toTransferable(bytes);
      respond({ id: req.id, ok: true, type: 'read', path: req.path, bytes: buffer }, [buffer]);
      return;
    }
    throw new Error(`Unsupported request: ${(req as any).type}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown worker error';
    const stack = err instanceof Error ? err.stack : undefined;
    const context = {
      reqType: req.type,
      path: req.type === 'read' ? req.path : undefined,
      archiveByteLength: zip?.byteLength,
      fileCount: zip ? zip.list().length : undefined,
    };
    respond({ id: req.id, ok: false, error: message, stack, context });
  }
};
