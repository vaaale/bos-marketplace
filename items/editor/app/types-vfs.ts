// The slice of the BrowserOS VFS shape this app depends on. Mirrors
// `VfsEntry` in src/os/types.ts — restated here because an installed app is
// bundled standalone and cannot import from BOS source.

export type VfsNodeType = "file" | "dir";

export interface VfsEntry {
  name: string;
  /** POSIX-style absolute path within the VFS root, e.g. "/Documents/a.txt". */
  path: string;
  type: VfsNodeType;
  size: number;
  /** Last modified time, epoch milliseconds. */
  modified: number;
}
