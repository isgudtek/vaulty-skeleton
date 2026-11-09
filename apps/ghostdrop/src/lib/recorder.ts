import { readBlobBytes } from './files';

/**
 * Microphone capture that never touches disk.
 *
 * MediaRecorder hands us Blob chunks held in memory. `sealClip` converts them to ONE Uint8Array,
 * passes it to a sink (which encrypts it with `VaultClient.putFile`), and zero-fills every
 * intermediate buffer — including the final one — as soon as the sink settles.
 */

export interface RecordedClip {
  chunks: Blob[];
  /** MIME type without codec parameters, e.g. `audio/webm`. */
  mimeType: string;
}

export interface RecorderDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  MediaRecorderCtor?: typeof MediaRecorder;
}

export class VoiceNoteRecorder {
  readonly #deps: RecorderDeps;
  #recorder: MediaRecorder | null = null;
  #stream: MediaStream | null = null;
  #chunks: Blob[] = [];

  constructor(deps: RecorderDeps = {}) {
    this.#deps = deps;
  }

  get isRecording(): boolean {
    return this.#recorder !== null && this.#recorder.state === 'recording';
  }

  static isSupported(deps: RecorderDeps = {}): boolean {
    const gum = deps.getUserMedia ?? globalThis.navigator?.mediaDevices?.getUserMedia;
    const Rec = deps.MediaRecorderCtor ?? (globalThis as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
    return typeof gum === 'function' && typeof Rec === 'function';
  }

  async start(): Promise<void> {
    if (this.#recorder) throw new Error('Already recording');
    const gum =
      this.#deps.getUserMedia ?? globalThis.navigator.mediaDevices.getUserMedia.bind(globalThis.navigator.mediaDevices);
    const Rec = this.#deps.MediaRecorderCtor ?? MediaRecorder;
    const stream = await gum({ audio: true });
    this.#stream = stream;
    this.#chunks = [];
    const rec = new Rec(stream);
    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) this.#chunks.push(e.data);
    };
    this.#recorder = rec;
    rec.start();
  }

  /** Stop and return the in-memory clip. The microphone is released immediately. */
  stop(): Promise<RecordedClip> {
    const rec = this.#recorder;
    if (!rec) return Promise.reject(new Error('Not recording'));
    return new Promise<RecordedClip>((resolve) => {
      rec.onstop = () => {
        const mimeType = (rec.mimeType || 'audio/webm').split(';')[0]!.trim().toLowerCase();
        const chunks = this.#chunks;
        this.#chunks = [];
        this.#release();
        resolve({ chunks, mimeType });
      };
      rec.stop();
    });
  }

  /** Abort without producing a clip (vault locked, component unmounted). */
  cancel(): void {
    const rec = this.#recorder;
    if (rec) {
      rec.ondataavailable = null;
      rec.onstop = null;
      try {
        if (rec.state !== 'inactive') rec.stop();
      } catch {
        /* already stopped */
      }
    }
    this.#chunks = [];
    this.#release();
  }

  #release(): void {
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#stream = null;
    this.#recorder = null;
  }
}

/**
 * Concatenate a clip into a single Uint8Array, hand it to `sink`, then zero-fill every buffer
 * (per-chunk copies and the combined array) whether the sink succeeds or throws.
 */
export async function sealClip(
  clip: RecordedClip,
  sink: (bytes: Uint8Array, mimeType: string) => Promise<void>,
): Promise<number> {
  const parts: Uint8Array[] = [];
  let combined: Uint8Array | null = null;
  try {
    for (const chunk of clip.chunks) parts.push(await readBlobBytes(chunk));
    const total = parts.reduce((n, p) => n + p.length, 0);
    combined = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      combined.set(p, offset);
      offset += p.length;
      p.fill(0); // per-chunk copy is no longer needed
    }
    await sink(combined, clip.mimeType);
    return total;
  } finally {
    for (const p of parts) p.fill(0);
    combined?.fill(0);
    clip.chunks.length = 0;
  }
}
