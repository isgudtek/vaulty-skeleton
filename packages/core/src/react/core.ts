/**
 * @vaulty/core/react — headless hooks + an unstyled-by-default pattern grid.
 * `react` is an OPTIONAL peer dependency; importing the main entry never loads it.
 */
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  createElement as h,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { normalizePattern } from '../crypto';
import type { LockReason } from '../memory';
import {
  type ImportOptions,
  type ImportResult,
  type ListFilter,
  type PutFileMeta,
  type PutRecordMeta,
  type UnlockResult,
  VaultClient,
  type VaultClientOptions,
} from '../vault';
import type { PatternNode, VaultMetadataEntry, VaultRecord } from '../types';

/* ------------------------------------------------------------------------------------------ */
/* useVault                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface UseVaultOptions extends VaultClientOptions {
  /** Bring your own client (it will NOT be locked on unmount). */
  client?: VaultClient;
}

export type VaultStatus = 'locked' | 'unlocking' | 'unlocked';

export interface VaultProgress {
  stage: string;
  percent: number;
}

export interface UseVaultResult {
  client: VaultClient;
  status: VaultStatus;
  isUnlocked: boolean;
  namespaceId: string | null;
  lastLockReason: LockReason | null;
  /** Decrypted metadata of the open vault. Cleared (emptied) the moment the vault locks. */
  entries: VaultMetadataEntry[];
  progress: VaultProgress | null;
  error: Error | null;
  unlock(pattern: readonly number[]): Promise<UnlockResult>;
  lock(): void;
  touch(): void;
  refresh(filter?: ListFilter): void;
  putFile(data: Uint8Array, meta: PutFileMeta): Promise<VaultMetadataEntry>;
  getFile(id: string): Promise<{ entry: VaultMetadataEntry; data: Uint8Array }>;
  deleteFile(id: string): Promise<boolean>;
  putRecord<T>(data: T, meta?: PutRecordMeta): Promise<VaultRecord<T>>;
  getRecord<T>(id: string): Promise<VaultRecord<T>>;
  exportArchive(): Promise<Uint8Array>;
  importArchive(
    bundle: Uint8Array | ArrayBuffer | Blob,
    patternOrPhrase: readonly number[] | string,
    options?: ImportOptions,
  ): Promise<ImportResult>;
}

const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

export function useVault(options: UseVaultOptions = {}): UseVaultResult {
  const clientRef = useRef<VaultClient | null>(null);
  const owned = options.client === undefined;
  if (clientRef.current === null) {
    const { client, ...rest } = options;
    clientRef.current = client ?? new VaultClient(rest);
  }
  const client = clientRef.current;

  const [unlocking, setUnlocking] = useState(false);
  const [vaultState, setVaultState] = useState(client.state);
  const [entries, setEntries] = useState<VaultMetadataEntry[]>([]);
  const [progress, setProgress] = useState<VaultProgress | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const filterRef = useRef<ListFilter | undefined>(undefined);

  const refresh = useCallback(
    (filter?: ListFilter) => {
      if (filter !== undefined) filterRef.current = filter;
      setEntries(client.isUnlocked ? client.listEntries(filterRef.current) : []);
    },
    [client],
  );

  useEffect(() => {
    const unsubscribe = client.subscribe((s) => {
      setVaultState(s);
      // Drop decrypted metadata from React state as soon as the vault locks.
      setEntries(s.unlocked ? client.listEntries(filterRef.current) : []);
      if (!s.unlocked) setProgress(null);
    });
    setVaultState(client.state);
    return () => {
      unsubscribe();
      if (owned) client.lock();
    };
  }, [client, owned]);

  const guarded = useCallback(async <T>(fn: () => Promise<T>): Promise<T> => {
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(toError(e));
      throw e;
    } finally {
      setProgress(null);
    }
  }, []);

  const onProgress = useCallback((stage: string, percent: number) => setProgress({ stage, percent }), []);

  const unlock = useCallback(
    async (pattern: readonly number[]) => {
      setUnlocking(true);
      try {
        const result = await guarded(() => client.unlock(pattern));
        refresh();
        return result;
      } finally {
        setUnlocking(false);
      }
    },
    [client, guarded, refresh],
  );

  const status: VaultStatus = unlocking ? 'unlocking' : vaultState.unlocked ? 'unlocked' : 'locked';

  return {
    client,
    status,
    isUnlocked: vaultState.unlocked,
    namespaceId: vaultState.namespaceId,
    lastLockReason: vaultState.lastLockReason,
    entries,
    progress,
    error,
    unlock,
    lock: () => client.lock(),
    touch: () => client.touch(),
    refresh,
    putFile: (data, meta) =>
      guarded(async () => {
        const r = await client.putFile(data, meta);
        refresh();
        return r;
      }),
    getFile: (id) => guarded(() => client.getFile(id)),
    deleteFile: (id) =>
      guarded(async () => {
        const r = await client.deleteFile(id);
        refresh();
        return r;
      }),
    putRecord: <T,>(data: T, meta?: PutRecordMeta) =>
      guarded(async () => {
        const r = await client.putRecord<T>(data, meta);
        refresh();
        return r;
      }),
    getRecord: <T,>(id: string) => guarded(() => client.getRecord<T>(id)),
    exportArchive: () => guarded(() => client.exportArchive(onProgress)),
    importArchive: (bundle, patternOrPhrase, importOptions) =>
      guarded(async () => {
        const r = await client.importArchive(bundle, patternOrPhrase, onProgress, importOptions);
        refresh();
        return r;
      }),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* PatternGrid                                                                                */
/* ------------------------------------------------------------------------------------------ */

const VIEW = 100;
const COLS = 5;
const NODE_COUNT = 25;

/** Centre of grid node `i` in the 0–100 SVG viewBox. */
export function nodeCenter(i: number): { x: number; y: number } {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const step = VIEW / COLS;
  return { x: step / 2 + col * step, y: step / 2 + row * step };
}

/** Index of the node whose centre is within `hitRadius` of (x, y), or null. */
export function nearestNode(x: number, y: number, hitRadius = 9): PatternNode | null {
  let best: number | null = null;
  let bestDist = hitRadius * hitRadius;
  for (let i = 0; i < NODE_COUNT; i++) {
    const c = nodeCenter(i);
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d <= bestDist) {
      best = i;
      bestDist = d;
    }
  }
  return best as PatternNode | null;
}

export type PatternGridError = 'too_short';

export interface PatternGridProps {
  /** Max rendered width in px (the grid scales down responsively). Default 280. */
  size?: number;
  nodeColor?: string;
  activeColor?: string;
  lineColor?: string;
  className?: string;
  style?: CSSProperties;
  /** Visual node radius in viewBox units (0–100). Default 3. */
  nodeRadius?: number;
  /** Connecting-line thickness in viewBox units. Default 1.6. */
  lineWidth?: number;
  /** Minimum nodes before `onComplete` fires. Default 6. */
  minNodes?: number;
  disabled?: boolean;
  ariaLabel?: string;
  /** Fires on release (or Enter) with a valid-length pattern. */
  onComplete?: (pattern: PatternNode[]) => void;
  /** Fires on every change while drawing (never log or persist this). */
  onChange?: (pattern: PatternNode[]) => void;
  onError?: (error: PatternGridError, pattern: PatternNode[]) => void;
}

const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

export function PatternGrid(props: PatternGridProps): ReactElement {
  const {
    size = 280,
    nodeColor = '#94a3b8',
    activeColor = '#38bdf8',
    lineColor = '#38bdf8',
    className,
    style,
    nodeRadius = 3,
    lineWidth = 1.6,
    minNodes = 6,
    disabled = false,
    ariaLabel = 'Pattern grid. Drag across the dots, or use arrow keys to move, Space to select, Enter to confirm.',
    onComplete,
    onChange,
    onError,
  } = props;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const pathRef = useRef<number[]>([]);
  const drawingRef = useRef(false);
  const [path, setPath] = useState<number[]>([]);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [focusNode, setFocusNode] = useState<number | null>(null);
  const liveId = useId();

  const commit = useCallback(
    (next: number[]) => {
      pathRef.current = next;
      setPath(next);
      onChange?.(next.slice() as PatternNode[]);
    },
    [onChange],
  );

  const finish = useCallback(() => {
    drawingRef.current = false;
    setPointer(null);
    const finished = pathRef.current.slice() as PatternNode[];
    if (finished.length === 0) return;
    // Clear our own copy first so the pattern never lingers in component state.
    pathRef.current = [];
    setPath([]);
    if (finished.length < minNodes) {
      onError?.('too_short', finished);
      return;
    }
    // Validate defensively; the grid can only produce distinct in-range nodes.
    onComplete?.(normalizePattern(finished, 1));
  }, [minNodes, onComplete, onError]);

  const toLocal = (e: ReactPointerEvent<SVGSVGElement>): { x: number; y: number } | null => {
    const el = svgRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((e.clientX - rect.left) / rect.width) * VIEW,
      y: ((e.clientY - rect.top) / rect.height) * VIEW,
    };
  };

  const extend = (p: { x: number; y: number }): void => {
    const n = nearestNode(p.x, p.y);
    if (n !== null && !pathRef.current.includes(n)) commit([...pathRef.current, n]);
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (disabled) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drawingRef.current = true;
    commit([]);
    const p = toLocal(e);
    if (p) {
      setPointer(p);
      extend(p);
    }
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!drawingRef.current) return;
    const p = toLocal(e);
    if (p) {
      setPointer(p);
      extend(p);
    }
  };
  const onPointerEnd = (): void => {
    if (drawingRef.current) finish();
  };

  const onKeyDown = (e: ReactKeyboardEvent<SVGSVGElement>): void => {
    if (disabled) return;
    const cur = focusNode ?? 12;
    const move = (delta: number, ok: boolean): void => {
      e.preventDefault();
      if (ok) setFocusNode(cur + delta);
    };
    switch (e.key) {
      case 'ArrowRight': return move(1, cur % COLS < COLS - 1);
      case 'ArrowLeft': return move(-1, cur % COLS > 0);
      case 'ArrowDown': return move(COLS, cur + COLS < NODE_COUNT);
      case 'ArrowUp': return move(-COLS, cur - COLS >= 0);
      case ' ':
        e.preventDefault();
        if (!pathRef.current.includes(cur)) commit([...pathRef.current, cur]);
        return;
      case 'Backspace':
        e.preventDefault();
        commit(pathRef.current.slice(0, -1));
        return;
      case 'Escape':
        e.preventDefault();
        commit([]);
        return;
      case 'Enter':
        e.preventDefault();
        finish();
        return;
      default:
    }
  };

  const points = path.map(nodeCenter);
  const lineChildren: ReactElement[] = [];
  if (points.length > 0) {
    const pts = points.map((p) => `${p.x},${p.y}`);
    if (pointer && drawingRef.current) pts.push(`${pointer.x},${pointer.y}`);
    lineChildren.push(
      h('polyline', {
        key: 'line',
        points: pts.join(' '),
        fill: 'none',
        stroke: lineColor,
        strokeWidth: lineWidth,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }),
    );
  }

  const nodes: ReactElement[] = [];
  for (let i = 0; i < NODE_COUNT; i++) {
    const c = nodeCenter(i);
    const active = path.includes(i);
    const focused = focusNode === i;
    nodes.push(
      h(
        'g',
        { key: i, 'data-node': i, 'data-active': active ? 'true' : 'false', 'aria-hidden': true },
        focused
          ? h('circle', { cx: c.x, cy: c.y, r: nodeRadius + 3.2, fill: 'none', stroke: activeColor, strokeDasharray: '1.6 1.6', strokeWidth: 0.6 })
          : null,
        active ? h('circle', { cx: c.x, cy: c.y, r: nodeRadius + 2.2, fill: activeColor, opacity: 0.25 }) : null,
        h('circle', { cx: c.x, cy: c.y, r: active ? nodeRadius + 0.6 : nodeRadius, fill: active ? activeColor : nodeColor }),
      ),
    );
  }

  const svg = h(
    'svg',
    {
      ref: svgRef,
      viewBox: `0 0 ${VIEW} ${VIEW}`,
      role: 'application',
      'aria-label': ariaLabel,
      'aria-describedby': liveId,
      'aria-disabled': disabled || undefined,
      tabIndex: disabled ? -1 : 0,
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onKeyDown,
      onFocus: () => setFocusNode((n) => n ?? 12),
      onBlur: () => setFocusNode(null),
      style: {
        display: 'block',
        width: '100%',
        maxWidth: size,
        aspectRatio: '1 / 1',
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        outline: 'none',
      } satisfies CSSProperties,
    },
    ...lineChildren,
    ...nodes,
  );

  // The live region only announces a count, never which nodes were chosen.
  const live = h(
    'span',
    { id: liveId, role: 'status', 'aria-live': 'polite', style: VISUALLY_HIDDEN },
    `${path.length} ${path.length === 1 ? 'node' : 'nodes'} selected`,
  );

  const wrapperProps: { className?: string; style: CSSProperties } = {
    style: { position: 'relative', display: 'inline-block', width: '100%', maxWidth: size, ...style },
  };
  if (className !== undefined) wrapperProps.className = className;
  return h('div', wrapperProps, svg, live);
}
