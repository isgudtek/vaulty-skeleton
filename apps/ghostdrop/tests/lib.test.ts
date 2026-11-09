import { describe, expect, it, vi } from 'vitest';
import { readBlobBytes } from '../src/lib/files';
import {
  extensionForMime,
  fingerprint,
  formatBytes,
  guessMime,
  previewKind,
  safeFileName,
  timestampStamp,
} from '../src/lib/format';
import { VoiceNoteRecorder, sealClip, type RecordedClip } from '../src/lib/recorder';

describe('format helpers', () => {
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  it('builds a short vault fingerprint', () => {
    expect(fingerprint('7f3a91c2aabbccdd')).toBe('7F3A·91C2');
    expect(fingerprint(null)).toBe('————·————');
  });

  it('guesses MIME types, trusting the browser when it reports one', () => {
    expect(guessMime('a.PDF', '')).toBe('application/pdf');
    expect(guessMime('a.unknown', '')).toBe('application/octet-stream');
    expect(guessMime('a.bin', 'Image/PNG; charset=x')).toBe('image/png');
  });

  it('chooses preview kinds and never previews SVG (it can carry script)', () => {
    expect(previewKind('image/png')).toBe('image');
    expect(previewKind('image/svg+xml')).toBe('none');
    expect(previewKind('application/pdf')).toBe('pdf');
    expect(previewKind('audio/webm')).toBe('audio');
    expect(previewKind('video/mp4')).toBe('video');
    expect(previewKind('application/zip')).toBe('none');
  });

  it('sanitises file names and maps audio extensions', () => {
    expect(safeFileName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeFileName('   ')).toBe('file');
    expect(safeFileName('a\u0000b:c')).toBe('a_b_c');
    expect(extensionForMime('audio/webm')).toBe('webm');
    expect(extensionForMime('audio/mp4')).toBe('m4a');
    expect(extensionForMime('x/y')).toBe('bin');
    expect(timestampStamp(new Date(2026, 10, 9, 22, 5))).toBe('20261109-2205');
  });
});

describe('readBlobBytes', () => {
  it('reads a Blob into a Uint8Array', async () => {
    const bytes = await readBlobBytes(new Blob([new Uint8Array([1, 2, 3])]));
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it('falls back to FileReader when Blob.arrayBuffer is unavailable', async () => {
    const blob = new Blob([new Uint8Array([9, 8, 7])]);
    Object.defineProperty(blob, 'arrayBuffer', { value: undefined });
    expect(Array.from(await readBlobBytes(blob))).toEqual([9, 8, 7]);
  });
});

describe('sealClip (voice-note hygiene)', () => {
  const clipOf = (...parts: number[][]): RecordedClip => ({
    chunks: parts.map((p) => new Blob([new Uint8Array(p)])),
    mimeType: 'audio/webm',
  });

  it('concatenates chunks, hands ONE array to the sink, then zero-fills it', async () => {
    let seen: Uint8Array | null = null;
    let snapshot: number[] = [];
    const size = await sealClip(clipOf([1, 2], [3], [4, 5, 6]), async (bytes, mime) => {
      seen = bytes;
      snapshot = Array.from(bytes);
      expect(mime).toBe('audio/webm');
    });
    expect(size).toBe(6);
    expect(snapshot).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen).not.toBeNull();
    expect(Array.from(seen!)).toEqual([0, 0, 0, 0, 0, 0]); // wiped after the sink returned
  });

  it('still zero-fills when the sink throws', async () => {
    let seen: Uint8Array | null = null;
    const clip = clipOf([7, 7, 7]);
    await expect(
      sealClip(clip, async (bytes) => {
        seen = bytes;
        throw new Error('vault locked');
      }),
    ).rejects.toThrow('vault locked');
    expect(Array.from(seen!)).toEqual([0, 0, 0]);
    expect(clip.chunks).toHaveLength(0);
  });
});

describe('VoiceNoteRecorder', () => {
  class FakeRecorder {
    static last: FakeRecorder | null = null;
    state: 'inactive' | 'recording' = 'inactive';
    mimeType = 'audio/webm;codecs=opus';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(readonly stream: unknown) {
      FakeRecorder.last = this;
    }
    start() {
      this.state = 'recording';
      this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
    }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob([new Uint8Array([4, 5])]) });
      this.onstop?.();
    }
  }

  const makeStream = () => {
    const stop = vi.fn();
    return { stream: { getTracks: () => [{ stop }, { stop }] } as unknown as MediaStream, stop };
  };

  it('records in memory, strips codec params and releases the microphone on stop', async () => {
    const { stream, stop } = makeStream();
    const rec = new VoiceNoteRecorder({
      getUserMedia: async () => stream,
      MediaRecorderCtor: FakeRecorder as unknown as typeof MediaRecorder,
    });
    await rec.start();
    expect(rec.isRecording).toBe(true);
    await expect(rec.start()).rejects.toThrow('Already recording');
    const clip = await rec.stop();
    expect(clip.mimeType).toBe('audio/webm');
    expect(clip.chunks).toHaveLength(2);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(rec.isRecording).toBe(false);
    await expect(rec.stop()).rejects.toThrow('Not recording');
  });

  it('cancel() discards audio and releases the microphone', async () => {
    const { stream, stop } = makeStream();
    const rec = new VoiceNoteRecorder({
      getUserMedia: async () => stream,
      MediaRecorderCtor: FakeRecorder as unknown as typeof MediaRecorder,
    });
    await rec.start();
    rec.cancel();
    expect(stop).toHaveBeenCalled();
    expect(rec.isRecording).toBe(false);
    rec.cancel(); // idempotent
  });

  it('reports support correctly', () => {
    expect(
      VoiceNoteRecorder.isSupported({
        getUserMedia: async () => ({}) as MediaStream,
        MediaRecorderCtor: FakeRecorder as unknown as typeof MediaRecorder,
      }),
    ).toBe(true);
    expect(VoiceNoteRecorder.isSupported({})).toBe(false); // jsdom: no MediaRecorder / mediaDevices
  });
});
