/*!
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import * as path from 'path';
import * as ts from 'typescript/lib/tsserverlibrary';
import * as lsp from 'vscode-languageserver/node';

import {ServerHost} from './server_host';
import {filePathToUri, toPathKey} from './utils';

/**
 * Watches the files that the configured Custom Elements Manifests depend on, and synchronizes open
 * manifests, without registering language features for them.
 */
export class ResourceWatchers {
  private readonly projects = new Map<ts.server.Project, Map<string, string>>();
  private resources = new Map<string, string>();
  private missingDirectories = new Map<string, string>();
  private readonly watchers = new Map<string, ts.FileWatcher>();
  private watchersUseClientSide: boolean | undefined;
  private watchRegistration: lsp.Disposable | undefined;
  private watchRegistrationKey = '';
  private readonly documentRegistrations = new Map<string, lsp.Disposable>();
  private pendingUpdate: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: ServerHost,
    private readonly connection: lsp.Connection,
    private readonly getCapabilities: () => lsp.ClientCapabilities,
    private readonly onChange: (fileName: string) => void,
  ) {}

  update(project?: ts.server.Project, fileNames: readonly string[] = []): void {
    if (project !== undefined) {
      const filesByKey = new Map<string, string>();
      for (const file of fileNames) {
        const key = this.pathKey(file);
        if (!filesByKey.has(key)) {
          filesByKey.set(key, file);
        }
      }
      this.projects.set(project, filesByKey);
    }
    const resources = new Map<string, string>();
    const documents = new Map<string, string>();
    for (const [owner, files] of this.projects) {
      if (owner.isClosed() || !owner.languageServiceEnabled) {
        this.projects.delete(owner);
        continue;
      }
      for (const [key, file] of files) {
        if (!resources.has(key)) {
          resources.set(key, file);
        }
        // readResource adds manifests as roots. TypeScript infers JSON ScriptKind even when
        // Unknown is requested, so ScriptKind alone cannot identify manifests. Resolution
        // metadata such as package.json is not added as a root.
        const scriptInfo = owner.getScriptInfo(file);
        if (scriptInfo !== undefined && owner.isRoot(scriptInfo) && !documents.has(key)) {
          documents.set(key, file);
        }
      }
    }
    this.resources = resources;

    // Only delegate file watching to the LSP client when it advertises dynamic relative-pattern
    // support; otherwise fall back to native Node file watching so disk edits are not lost.
    const useClientWatcher = this.usesClientSideResourceWatchers();
    if (
      this.watchersUseClientSide !== undefined &&
      this.watchersUseClientSide !== useClientWatcher
    ) {
      for (const watcher of this.watchers.values()) {
        watcher.close();
      }
      this.watchers.clear();
    }
    this.watchersUseClientSide = useClientWatcher;

    // A client can only watch a file whose directory exists. Until it does, watch the first
    // missing directory instead, and move the watch down as directories are created.
    const watchedPaths = new Map<string, {filePath: string; callback: () => void}>();
    const clientPaths = new Map<string, string>();
    const missingDirectories = new Map<string, string>();
    const missingFiles = new Map<string, string>();
    for (const [fileKey, file] of resources) {
      watchedPaths.set(fileKey, {filePath: file, callback: () => this.onChange(file)});
      const missingDirectory = useClientWatcher ? this.findMissingDirectory(file) : null;
      if (missingDirectory === null) {
        if (useClientWatcher) {
          clientPaths.set(fileKey, file);
          if (!this.host.fileExists(file)) {
            missingFiles.set(fileKey, file);
          }
        }
      } else {
        const missingDirKey = this.pathKey(missingDirectory);
        clientPaths.set(missingDirKey, missingDirectory);
        missingDirectories.set(missingDirKey, missingDirectory);
        if (!watchedPaths.has(missingDirKey)) {
          watchedPaths.set(missingDirKey, {
            filePath: missingDirectory,
            callback: () => this.update(),
          });
        }
      }
    }
    // Snapshot every previously watched missing directory that now exists before replacing
    // `this.missingDirectories` and closing its directory watcher, so neither an unrelated
    // `update()` nor a batched creation of sibling directories can drop notifications for
    // manifests created together with those directories.
    const appearedDirs = Array.from(this.missingDirectories.values()).filter((dir) =>
      this.host.directoryExists(dir),
    );
    this.missingDirectories = missingDirectories;
    for (const [watchedKey, watcher] of this.watchers) {
      if (!watchedPaths.has(watchedKey)) {
        watcher.close();
        this.watchers.delete(watchedKey);
      }
    }
    for (const [watchedKey, {filePath, callback}] of watchedPaths) {
      if (!this.watchers.has(watchedKey)) {
        const watcher = useClientWatcher
          ? this.host.watchFile(filePath, callback)
          : this.host.useClientSideFileWatcher
            ? this.host.watchFileNative(filePath, callback)
            : this.host.watchFile(filePath, callback);
        this.watchers.set(watchedKey, watcher);
      }
    }

    // Serialize updates so a slow registration cannot restore an obsolete set of resources.
    this.pendingUpdate = this.pendingUpdate
      .then(() =>
        this.register(
          Array.from(clientPaths.values()).sort(),
          Array.from(missingFiles.values()),
          Array.from(documents.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
      )
      .then(() => {
        if (appearedDirs.length === 0) {
          return;
        }
        // Files can be written together with a directory, before the deeper watch is registered,
        // so report existing manifests beneath every appeared directory once watches are updated.
        const notified = new Set<string>();
        for (const directory of appearedDirs) {
          const dirKey = this.pathKey(directory);
          const dirPrefix = dirKey.endsWith('/') ? dirKey : `${dirKey}/`;
          for (const [fileKey, file] of this.resources) {
            if (
              !notified.has(fileKey) &&
              fileKey.startsWith(dirPrefix) &&
              this.host.fileExists(file)
            ) {
              notified.add(fileKey);
              this.onChange(file);
            }
          }
        }
      })
      .catch((error) =>
        this.connection.console.error(`Failed to watch Angular resources: ${error}`),
      );
  }

  getProjects(fileName: string): ts.server.Project[] {
    const key = this.pathKey(fileName);
    return Array.from(this.projects)
      .filter(
        ([project, files]) =>
          !project.isClosed() && project.languageServiceEnabled && files.has(key),
      )
      .map(([project]) => project);
  }

  private pathKey(fileName: string): string {
    return toPathKey(fileName, this.host.useCaseSensitiveFileNames);
  }

  private usesClientSideResourceWatchers(): boolean {
    const capabilities = this.getCapabilities();
    return Boolean(
      this.host.useClientSideFileWatcher &&
      capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration &&
      capabilities.workspace.didChangeWatchedFiles.relativePatternSupport,
    );
  }

  /**
   * Returns the highest missing directory above `file`, whose parent exists, or `null` if the
   * directory of `file` exists.
   */
  private findMissingDirectory(file: string): string | null {
    let missingDirectory: string | null = null;
    let directory = path.dirname(file);
    while (!this.host.directoryExists(directory)) {
      missingDirectory = directory;
      const parent = path.dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
    return missingDirectory;
  }

  private async register(
    clientPaths: string[],
    missingFiles: string[],
    documents: Array<[string, string]>,
  ): Promise<void> {
    const capabilities = this.getCapabilities();
    const watchedPaths = this.usesClientSideResourceWatchers() ? clientPaths : [];
    const key = JSON.stringify(watchedPaths);
    if (key !== this.watchRegistrationKey) {
      const registrations = lsp.BulkRegistration.create();
      if (watchedPaths.length > 0) {
        registrations.add(lsp.DidChangeWatchedFilesNotification.type, {
          watchers: watchedPaths.map((watchedPath) => ({
            // Non-recursive relative watchers include dependencies excluded by workspace-wide globs
            // (notably node_modules) and resources outside the workspace.
            globPattern: {
              baseUri: filePathToUri(path.dirname(watchedPath)),
              pattern: escapeGlobPattern(path.basename(watchedPath)),
            },
          })),
        });
      }
      const registration =
        watchedPaths.length > 0 ? await this.connection.client.register(registrations) : undefined;
      this.watchRegistration?.dispose();
      this.watchRegistration = registration;
      this.watchRegistrationKey = key;

      // If any watched missing directory or exact missing file appeared while async registration
      // was in flight, its creation event may have been missed.
      const appearedFiles = missingFiles.filter(
        (file) => this.resources.has(this.pathKey(file)) && this.host.fileExists(file),
      );
      if (
        Array.from(this.missingDirectories.values()).some((dir) => this.host.directoryExists(dir))
      ) {
        this.update();
      }
      for (const file of appearedFiles) {
        this.onChange(file);
      }
    }

    const synchronizedDocuments = new Map<string, string>(
      capabilities.textDocument?.synchronization?.dynamicRegistration ? documents : [],
    );
    for (const [fileKey, registration] of this.documentRegistrations) {
      if (!synchronizedDocuments.has(fileKey)) {
        registration.dispose();
        this.documentRegistrations.delete(fileKey);
      }
    }
    // Keep each document registration stable while other resources change. Replacing overlapping
    // synchronization selectors can duplicate incremental edits or close another unsaved buffer.
    for (const [fileKey, file] of synchronizedDocuments) {
      if (this.documentRegistrations.has(fileKey)) {
        continue;
      }
      const registrations = lsp.BulkRegistration.create();
      const documentSelector = [
        {
          scheme: 'file',
          pattern: escapeGlobPattern(file.replace(/\\/g, '/')),
        },
      ];
      registrations.add(lsp.DidOpenTextDocumentNotification.type, {documentSelector});
      registrations.add(lsp.DidChangeTextDocumentNotification.type, {
        documentSelector,
        syncKind: lsp.TextDocumentSyncKind.Incremental,
      });
      registrations.add(lsp.DidCloseTextDocumentNotification.type, {documentSelector});
      this.documentRegistrations.set(fileKey, await this.connection.client.register(registrations));
    }
  }
}

/** Match a literal path, including filenames with glob metacharacters. */
function escapeGlobPattern(value: string): string {
  return value.replace(/[?*\[\]{}]/g, (character) => `[${character}]`);
}
