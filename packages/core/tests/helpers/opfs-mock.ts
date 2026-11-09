import type { FsDirectoryHandleLike, FsFileHandleLike } from '../../src/storage';

/** Faithful-enough in-memory model of the Origin Private File System for Node tests. */
export class MockFile implements FsFileHandleLike {
  data = new Uint8Array(0);

  async getFile() {
    const copy = this.data.slice();
    return { arrayBuffer: async () => copy.buffer as ArrayBuffer };
  }

  async createWritable() {
    let pending = new Uint8Array(0);
    return {
      write: async (d: BufferSource) => {
        pending = new Uint8Array(d as ArrayBuffer).slice();
      },
      close: async () => {
        this.data = pending;
      },
    };
  }
}

/** A file whose only write API is the worker-only sync access handle (Safari-style). */
export class MockSyncOnlyFile extends MockFile {
  override createWritable = undefined as never;
  createSyncAccessHandle = async () => {
    let buf = new Uint8Array(0);
    return {
      truncate: (n: number) => {
        buf = buf.slice(0, n);
      },
      write: (d: BufferSource, o?: { at?: number }) => {
        const src = new Uint8Array(d as ArrayBuffer);
        const at = o?.at ?? 0;
        const next = new Uint8Array(Math.max(buf.length, at + src.length));
        next.set(buf);
        next.set(src, at);
        buf = next;
        return src.length;
      },
      flush: () => {},
      close: () => {
        this.data = buf;
      },
    };
  };
}

const notFound = (name: string): DOMException => new DOMException(`${name} not found`, 'NotFoundError');

export class MockDir implements FsDirectoryHandleLike {
  readonly children = new Map<string, MockDir | MockFile>();

  constructor(private readonly fileFactory: () => MockFile = () => new MockFile()) {}

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MockDir> {
    const existing = this.children.get(name);
    if (existing instanceof MockDir) return existing;
    if (existing) throw new DOMException('Type mismatch', 'TypeMismatchError');
    if (!options?.create) throw notFound(name);
    const dir = new MockDir(this.fileFactory);
    this.children.set(name, dir);
    return dir;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MockFile> {
    const existing = this.children.get(name);
    if (existing instanceof MockFile) return existing;
    if (existing) throw new DOMException('Type mismatch', 'TypeMismatchError');
    if (!options?.create) throw notFound(name);
    const file = this.fileFactory();
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const existing = this.children.get(name);
    if (!existing) throw notFound(name);
    if (existing instanceof MockDir && existing.children.size > 0 && !options?.recursive) {
      throw new DOMException('Not empty', 'InvalidModificationError');
    }
    this.children.delete(name);
  }

  async *keys(): AsyncIterable<string> {
    for (const k of [...this.children.keys()]) yield k;
  }

  /** Flatten to `ns/name` paths for assertions. */
  paths(prefix = ''): string[] {
    const out: string[] = [];
    for (const [k, v] of this.children) {
      if (v instanceof MockDir) out.push(...v.paths(`${prefix}${k}/`));
      else out.push(`${prefix}${k}`);
    }
    return out;
  }
}
