import type { UseVaultResult } from '@vaulty/core/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_FILE_BYTES, readBlobBytes } from '../lib/files';
import { extensionForMime, formatBytes, guessMime, timestampStamp } from '../lib/format';
import { VoiceNoteRecorder, sealClip } from '../lib/recorder';
import { errorMessage } from '../lib/skin';
import { Button, Panel, StatusDot } from './ui';

/** Drag-and-drop / picker binary intake. Plaintext is zero-filled right after `putFile` returns. */
export function DropZone({ vault }: { vault: UseVaultResult }) {
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const putFileRef = useRef(vault.putFile);
  putFileRef.current = vault.putFile;

  const ingest = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setBusy(true);
    setError('');
    let done = 0;
    try {
      for (const file of files) {
        if (file.size > MAX_FILE_BYTES) {
          setError(`${file.name} is larger than ${formatBytes(MAX_FILE_BYTES)} and was skipped.`);
          continue;
        }
        setStatus(`Encrypting ${file.name} (${done + 1}/${files.length})…`);
        const bytes = await readBlobBytes(file);
        try {
          await putFileRef.current(bytes, {
            name: file.name,
            mimeType: guessMime(file.name, file.type),
            tags: ['evidence'],
          });
          done++;
        } finally {
          bytes.fill(0); // plaintext never lingers after encryption
        }
      }
      setStatus(done > 0 ? `${done} file${done === 1 ? '' : 's'} sealed.` : '');
    } catch (e) {
      setError(errorMessage(e));
      setStatus('');
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <Panel title="Drop zone" hint="photos · pdf · any file">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void ingest(Array.from(e.dataTransfer.files));
        }}
        className={`flex flex-col items-center gap-3 rounded-md border-2 border-dashed px-4 py-8 text-center transition-colors ${
          dragging ? 'border-emerald-signal bg-emerald-signal/10' : 'border-line bg-obsidian/60'
        }`}
      >
        <p className="font-mono text-xs uppercase tracking-wider text-slate-400">
          {busy ? 'sealing…' : 'Drag files here to encrypt them'}
        </p>
        <Button tone="primary" disabled={busy} onClick={() => inputRef.current?.click()}>
          Choose files
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          aria-label="Choose files to encrypt"
          data-testid="file-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            void ingest(files);
          }}
        />
      </div>
      <p role="status" aria-live="polite" className="mt-2 min-h-4 font-mono text-[11px] text-emerald-300">
        {status}
      </p>
      <p role="alert" className="min-h-4 font-mono text-[11px] text-rose-400">
        {error}
      </p>
    </Panel>
  );
}

type RecState = 'idle' | 'recording' | 'sealing';

/** Encrypted voice notes: mic → memory → AES-GCM → vault. The raw audio is zero-filled and never written to disk. */
export function VoiceRecorderPanel({ vault }: { vault: UseVaultResult }) {
  const recorderRef = useRef<VoiceNoteRecorder | null>(null);
  const [state, setState] = useState<RecState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const putFileRef = useRef(vault.putFile);
  putFileRef.current = vault.putFile;
  const supported = VoiceNoteRecorder.isSupported();

  useEffect(() => {
    if (state !== 'recording') return;
    const t = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [state]);

  // Locking or leaving the screen aborts any recording; nothing is kept.
  useEffect(() => () => recorderRef.current?.cancel(), []);

  const start = async () => {
    setError('');
    setMessage('');
    try {
      const rec = new VoiceNoteRecorder();
      await rec.start();
      recorderRef.current = rec;
      setSeconds(0);
      setState('recording');
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Microphone permission denied.'
          : `Cannot start recording: ${errorMessage(e)}`,
      );
    }
  };

  const stop = async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    setState('sealing');
    try {
      const clip = await rec.stop();
      recorderRef.current = null;
      const size = await sealClip(clip, (bytes, mimeType) =>
        putFileRef.current(bytes, {
          name: `voice-note-${timestampStamp()}.${extensionForMime(mimeType)}`,
          mimeType,
          tags: ['voice'],
        }).then(() => undefined),
      );
      setMessage(`Voice note sealed (${formatBytes(size)}). Raw audio wiped from memory.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setState('idle');
    }
  };

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');

  return (
    <Panel title="Voice note" hint="mic → memory → AES-256-GCM">
      <div className="flex items-center gap-4">
        {state === 'recording' ? (
          <Button tone="danger" onClick={() => void stop()}>
            ■ Stop &amp; seal
          </Button>
        ) : (
          <Button tone="primary" disabled={!supported || state === 'sealing'} onClick={() => void start()}>
            ● Record
          </Button>
        )}
        <span className="flex items-center gap-2 font-mono text-sm text-slate-300" aria-live="off">
          <StatusDot on={state === 'recording'} />
          {mm}:{ss}
        </span>
      </div>
      {!supported ? (
        <p className="mt-2 font-mono text-[11px] text-amber-300">This browser has no microphone recording support.</p>
      ) : null}
      <p role="status" aria-live="polite" className="mt-2 min-h-4 font-mono text-[11px] text-emerald-300">
        {state === 'sealing' ? 'Encrypting…' : message}
      </p>
      <p role="alert" className="min-h-4 font-mono text-[11px] text-rose-400">
        {error}
      </p>
    </Panel>
  );
}
