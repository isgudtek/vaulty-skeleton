export interface Violation {
  file: string;
  line: number;
  rule: string;
  message: string;
}
export function stripComments(src: string): string;
export function checkSource(source: string, file?: string): Violation[];
export function checkFiles(files: string[], cwd?: string): Violation[];
