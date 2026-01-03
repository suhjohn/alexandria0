import { EpubReaderV2Error } from '../types';

type WorkerRequest =
  | { id: number; type: 'load'; buffer: ArrayBuffer }
  | { id: number; type: 'read'; path: string }
  | { id: number; type: 'list' }
  | { id: number; type: 'dispose' };

type WorkerRequestPayload =
  | { type: 'load'; buffer: ArrayBuffer }
  | { type: 'read'; path: string }
  | { type: 'list' }
  | { type: 'dispose' };

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

export class ZipWorkerClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly inflight = new Map<number, { resolve: (value: WorkerResponse) => void; reject: (reason: any) => void }>();

  constructor() {
    this.worker = new Worker(new URL('./zip.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const res = event.data;
      const pending = this.inflight.get(res.id);
      if (!pending) return;
      this.inflight.delete(res.id);
      if (!res.ok) {
        const context = res.context ? `\ncontext=${JSON.stringify(res.context)}` : '';
        const e = new Error(`${res.error}${context}`);
        if (res.stack) e.stack = res.stack;
        pending.reject(e);
        return;
      }
      pending.resolve(res);
    };
  }

  async load(buffer: ArrayBuffer): Promise<string[]> {
    const res = await this.request({ type: 'load', buffer }, [buffer]);
    if (!res.ok || res.type !== 'load') throw new Error('Unexpected ZIP worker response');
    return res.files;
  }

  async list(): Promise<string[]> {
    const res = await this.request({ type: 'list' });
    if (!res.ok || res.type !== 'list') throw new Error('Unexpected ZIP worker response');
    return res.files;
  }

  async read(path: string): Promise<Uint8Array> {
    const res = await this.request({ type: 'read', path });
    if (!res.ok || res.type !== 'read') throw new Error('Unexpected ZIP worker response');
    return new Uint8Array(res.bytes);
  }

  dispose() {
    try {
      const req: WorkerRequest = { id: this.nextId++, type: 'dispose' };
      this.worker.postMessage(req);
    } finally {
      this.worker.terminate();
      for (const [, pending] of this.inflight) {
        pending.reject(new EpubReaderV2Error('ZIP_INVALID', 'ZIP worker terminated'));
      }
      this.inflight.clear();
    }
  }

  private request(payload: WorkerRequestPayload, transfer?: Transferable[]): Promise<WorkerResponse> {
    const id = this.nextId++;
    const req: WorkerRequest = { id, ...(payload as WorkerRequestPayload) } as WorkerRequest;
    return new Promise((resolve, reject) => {
      this.inflight.set(id, { resolve, reject });
      this.worker.postMessage(req, transfer ?? []);
    });
  }
}
