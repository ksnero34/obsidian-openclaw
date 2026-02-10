import { App, normalizePath, Notice, requestUrl, TFile, TFolder } from "obsidian";
import { secureTokenStorage } from "./secureStorage";
import { OpenClawSettings, SyncConflict, SyncPathConfig } from "./types";

interface RemoteFile {
  path: string;
  content?: string;
  size: number;
  modified: string;
  hash: string;
}
interface ListResponse {
  path: string;
  files: RemoteFile[];
}

interface ReadResponse extends RemoteFile {
  content: string;
}

const ALLOWED_EXTENSIONS = new Set([
  "md",
  "writing",
  "drawing",
  "canvas",
  "json",
  "txt",
  "yml",
  "yaml",
]);

function normalizeRoot(input?: string): string {
  const v = (input ?? "").trim();
  if (!v || v === "/" || v === ".") return "";
  return normalizePath(v).replace(/^\/+|\/+$/g, "");
}

function toRelative(root: string, fullPath: string): string {
  const r = normalizeRoot(root);
  const f = normalizePath(fullPath).replace(/^\/+/, "");
  if (!r) return f;
  if (f === r) return "";
  if (f.startsWith(r + "/")) return f.slice(r.length + 1);
  return f;
}

function joinPath(root: string, rel: string): string {
  const r = normalizeRoot(root);
  const p = normalizePath(rel).replace(/^\/+/, "");
  return r ? normalizePath(`${r}/${p}`) : p;
}

export class SyncService {
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private isSyncing = false;
  private lastSyncState: Map<string, string> = new Map(); // path -> hash

  constructor(
    private app: App,
    private getSettings: () => OpenClawSettings
  ) { }

  private getToken(): string {
    const settings = this.getSettings();
    return secureTokenStorage.getToken(
      settings.gatewayTokenEncrypted,
      settings.gatewayTokenPlaintext
    );
  }
  private async request<T>(
    method: string,
    endpoint: string,
    body?: object
  ): Promise<T> {
    const settings = this.getSettings();
    const url = `${settings.syncServerUrl}${endpoint}`;

    const response = await requestUrl({
      url,
      method,
      headers: {
        Authorization: `Bearer ${this.getToken()}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status >= 400) {
      const error = response.json?.error || `HTTP ${response.status}`;
      throw new Error(error);
    }

    return response.json;
  }

  /** List remote files */
  async listRemote(remotePath: string): Promise<RemoteFile[]> {
    const response = await this.request<ListResponse>(
      "GET",
      `/sync/list?path=${encodeURIComponent(remotePath)}`
    );
    return response.files;
  }

  /** Read a remote file */
  async readRemote(remotePath: string): Promise<ReadResponse> {
    return await this.request<ReadResponse>(
      "GET",
      `/sync/read?path=${encodeURIComponent(remotePath)}`
    );
  }

  /** Write a remote file */
  async writeRemote(
    remotePath: string,
    content: string,
    expectedHash?: string
  ): Promise<RemoteFile> {
    return await this.request<RemoteFile>(
      "POST",
      `/sync/write?path=${encodeURIComponent(remotePath)}`,
      { content, expectedHash }
    );
  }

  /** Get local file hash */
  private getContentHash(content: string): string {
    // Simple hash for browser environment
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    // Convert to hex-like string and pad to look like MD5
    const hex = Math.abs(hash).toString(16).padStart(8, "0");
    return hex.repeat(4); // 32 chars like MD5
  }

  /** List local files in a vault path */
  async listLocal(localPath: string): Promise<Map<string, { file: TFile; hash: string }>> {
    const files = new Map<string, { file: TFile; hash: string }>();
    const { vault } = this.app;
    const localRoot = normalizeRoot(localPath);
    const folder = localRoot
      ? vault.getAbstractFileByPath(localRoot)
      : vault.getRoot();

    if (!folder || !(folder instanceof TFolder)) {
      return files;
    }

    const processFolder = async (f: TFolder) => {
      for (const child of f.children) {
        if (child instanceof TFile && ALLOWED_EXTENSIONS.has(child.extension)) {
          const relativePath = toRelative(localRoot, child.path);
          const content = await vault.read(child);
          const hash = this.getContentHash(content);
          files.set(relativePath, { file: child, hash });
        } else if (child instanceof TFolder) {
          await processFolder(child);
        }
      }
    };

    await processFolder(folder);
    return files;
  }

  /** Sync a single path configuration */
  async syncPath(
    config: SyncPathConfig,
    onConflict: (conflict: SyncConflict) => Promise<"local" | "remote" | "skip">
  ): Promise<{ pulled: number; pushed: number; conflicts: number; errors: number }> {
    const { vault } = this.app;
    const stats = { pulled: 0, pushed: 0, conflicts: 0, errors: 0 };

    const localRoot = normalizeRoot(config.localPath);
    const remoteRoot = normalizeRoot(config.remotePath);

    try {
      // Ensure local folder exists (skip create when local root is vault root)
      if (localRoot) {
        const localFolder = vault.getAbstractFileByPath(localRoot);
        if (!localFolder) {
          await vault.createFolder(localRoot);
        }
      }
      // Get remote and local file lists
      const remoteFiles = await this.listRemote(remoteRoot);
      const localFiles = await this.listLocal(localRoot);

      // Build maps for comparison
      const remoteMap = new Map<string, RemoteFile>();
      for (const rf of remoteFiles) {
        const relativePath = toRelative(remoteRoot, rf.path);
        remoteMap.set(relativePath, rf);
      }

      // Process remote files (pull new/updated)
      for (const [relativePath, remoteFile] of remoteMap) {
        const localInfo = localFiles.get(relativePath);
        const localPath = joinPath(localRoot, relativePath);
        const fullRemotePath = joinPath(remoteRoot, relativePath);

        try {
          if (!localInfo) {
            // File only exists remotely - pull it
            const content = await this.readRemote(fullRemotePath);
            await this.ensureParentFolder(localPath);
            await vault.create(localPath, content.content);
            this.lastSyncState.set(localPath, content.hash);
            stats.pulled++;
          } else if (localInfo.hash !== remoteFile.hash) {
            // File differs - check for conflict
            const lastKnownHash = this.lastSyncState.get(localPath);
            if (
              lastKnownHash &&
              lastKnownHash !== localInfo.hash &&
              lastKnownHash !== remoteFile.hash
            ) {
              // Both changed since last sync - conflict!
              const remoteContent = await this.readRemote(fullRemotePath);
              const localContent = await vault.read(localInfo.file);

              const resolution = await onConflict({
                localPath,
                remotePath: fullRemotePath,
                localFile: {
                  path: localPath,
                  hash: localInfo.hash,
                  modified: new Date(localInfo.file.stat.mtime).toISOString(),
                  size: localInfo.file.stat.size,
                  content: localContent,
                },
                remoteFile: {
                  path: fullRemotePath,
                  hash: remoteFile.hash,
                  modified: remoteFile.modified,
                  size: remoteFile.size,
                  content: remoteContent.content,
                },
              });

              if (resolution === "local") {
                // Push local to remote
                await this.writeRemote(fullRemotePath, localContent);
                this.lastSyncState.set(localPath, localInfo.hash);
                stats.pushed++;
              } else if (resolution === "remote") {
                // Pull remote to local
                await vault.modify(localInfo.file, remoteContent.content);
                this.lastSyncState.set(localPath, remoteFile.hash);
                stats.pulled++;
              } else {
                stats.conflicts++;
              }
            } else if (!lastKnownHash || lastKnownHash === localInfo.hash) {
              // Remote changed, local unchanged - pull
              const content = await this.readRemote(fullRemotePath);
              await vault.modify(localInfo.file, content.content);
              this.lastSyncState.set(localPath, content.hash);
              stats.pulled++;
            } else {
              // Local changed, remote unchanged - push
              const localContent = await vault.read(localInfo.file);
              await this.writeRemote(fullRemotePath, localContent, remoteFile.hash);
              this.lastSyncState.set(localPath, localInfo.hash);
              stats.pushed++;
            }
          } else {
            // Hashes match - update sync state
            this.lastSyncState.set(localPath, localInfo.hash);
          }
        } catch (err) {
          console.error(`Sync error for ${relativePath}:`, err);
          stats.errors++;
        }
      }

      // Process local-only files (push new)
      for (const [relativePath, localInfo] of localFiles) {
        if (!remoteMap.has(relativePath)) {
          const localPath = joinPath(localRoot, relativePath);
          const fullRemotePath = joinPath(remoteRoot, relativePath);

          try {
            const content = await vault.read(localInfo.file);
            await this.writeRemote(fullRemotePath, content);
            this.lastSyncState.set(localPath, localInfo.hash);
            stats.pushed++;
          } catch (err) {
            console.error(`Push error for ${relativePath}:`, err);
            stats.errors++;
          }
        }
      }
    } catch (err) {
      console.error(`Sync path error for ${config.remotePath}:`, err);
      stats.errors++;
    }

    return stats;
  }

  private async ensureParentFolder(filePath: string): Promise<void> {
    const { vault } = this.app;
    const parts = filePath.split("/");
    parts.pop(); // Remove filename

    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const folder = vault.getAbstractFileByPath(currentPath);
      if (!folder) {
        await vault.createFolder(currentPath);
      }
    }
  }

  /** Run a full sync */
  async sync(
    onConflict: (conflict: SyncConflict) => Promise<"local" | "remote" | "skip">
  ): Promise<{ pulled: number; pushed: number; conflicts: number; errors: number }> {
    if (this.isSyncing) {
      throw new Error("Sync already in progress");
    }

    this.isSyncing = true;
    const totals = { pulled: 0, pushed: 0, conflicts: 0, errors: 0 };

    try {
      const settings = this.getSettings();

      for (const pathConfig of settings.syncPaths) {
        if (!pathConfig.enabled) continue;
        const stats = await this.syncPath(pathConfig, onConflict);
        totals.pulled += stats.pulled;
        totals.pushed += stats.pushed;
        totals.conflicts += stats.conflicts;
        totals.errors += stats.errors;
      }

      if (totals.pulled > 0 || totals.pushed > 0) {
        new Notice(
          `Sync complete: ${totals.pulled} pulled, ${totals.pushed} pushed` +
          (totals.errors > 0 ? `, ${totals.errors} errors` : "")
        );
      }
    } finally {
      this.isSyncing = false;
    }

    return totals;
  }

  /** Start automatic sync */
  startAutoSync(): void {
    this.stopAutoSync();

    const settings = this.getSettings();
    if (!settings.syncEnabled || settings.syncInterval <= 0) return;

    const intervalMs = settings.syncInterval * 60 * 1000;
    this.syncInterval = setInterval(() => {
      this.sync(async () => {
        // Auto-sync uses configured behavior
        const behavior = this.getSettings().syncConflictBehavior;
        if (behavior === "preferLocal") return "local";
        if (behavior === "preferRemote") return "remote";
        return "skip"; // "ask" mode skips during auto-sync
      }).catch(console.error);
    }, intervalMs);

    console.log(`OpenClaw: Auto-sync started (every ${settings.syncInterval} min)`);
  }

  /** Stop automatic sync */
  stopAutoSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      console.log("OpenClaw: Auto-sync stopped");
    }
  }

  /** Test connection to sync server */
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const settings = this.getSettings();
      const response = await requestUrl({
        url: `${settings.syncServerUrl}/sync/status`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.getToken()}`,
        },
      });

      if (response.status === 200) {
        return { ok: true };
      }

      return { ok: false, error: `HTTP ${response.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}