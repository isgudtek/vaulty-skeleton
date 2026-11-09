/** Tactical emerald / slate skin for @vaulty/core/react's <PatternGrid />. */
export const GRID_SKIN = {
  nodeColor: '#334155',
  activeColor: '#10B981',
  lineColor: '#10B981',
} as const;

export function samePattern(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
