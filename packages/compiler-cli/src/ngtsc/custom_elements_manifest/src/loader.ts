/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {CustomElementsManifestIndex, CustomElementsManifestSchema} from '@angular/compiler';
import ts from 'typescript';

import {NgCompilerAdapter} from '../../core/api';
import {ErrorCode, ngErrorCode} from '../../diagnostics';
import {AbsoluteFsPath} from '../../file_system';
import {parseCustomElementsManifest, ParsedCustomElementsManifest} from './manifest_parser';
import {ManifestResolutionKind, resolveCustomElementsManifest} from './manifest_resolver';

interface CachedManifestParse {
  readonly content: string;
  readonly packageName: string | null;
  readonly manifestRelativeDir: string;
  readonly parsed: ParsedCustomElementsManifest;
}

/**
 * Lightweight content-keyed parse cache reused across incremental compilations so large manifests
 * are not re-parsed from JSON when their file contents have not changed.
 */
export class CustomElementsManifestParseCache {
  private readonly entries = new Map<AbsoluteFsPath, CachedManifestParse>();

  getOrParse(
    path: AbsoluteFsPath,
    content: string,
    manifestLabel: string,
    packageName: string | null,
    manifestRelativeDir: string,
  ): ParsedCustomElementsManifest {
    const cached = this.entries.get(path);
    if (
      cached !== undefined &&
      cached.content === content &&
      cached.packageName === packageName &&
      cached.manifestRelativeDir === manifestRelativeDir
    ) {
      return cached.parsed;
    }
    const parsed = parseCustomElementsManifest(
      content,
      manifestLabel,
      packageName,
      manifestRelativeDir,
    );
    this.entries.set(path, {content, packageName, manifestRelativeDir, parsed});
    return parsed;
  }
}

export interface CustomElementsManifestLoadResult {
  readonly index: CustomElementsManifestIndex | null;
  readonly diagnostics: ts.Diagnostic[];
  readonly resolutionPaths: Set<AbsoluteFsPath>;
}

/**
 * Resolves, parses, and merges all configured Custom Elements Manifests without inspecting the
 * TypeScript program or creating an extra program. Reports NG4007 (not found), NG4008 (invalid
 * JSON/manifest), and at most one concise NG4009 warning per app-owned manifest (`node_modules`
 * stays silent).
 */
export function loadCustomElementsManifests(
  entries: readonly string[],
  basePath: AbsoluteFsPath,
  options: ts.CompilerOptions,
  adapter: NgCompilerAdapter,
  moduleResolutionCache: ts.ModuleResolutionCache | null,
  parseCache: CustomElementsManifestParseCache = new CustomElementsManifestParseCache(),
): CustomElementsManifestLoadResult {
  const diagnostics: ts.Diagnostic[] = [];
  const resolutionPaths = new Set<AbsoluteFsPath>();
  const schemas: CustomElementsManifestSchema[] = [];
  const seenTags = new Map<string, string>();
  const seenManifestPaths = new Set<AbsoluteFsPath>();

  for (const entry of entries) {
    const resolved = resolveCustomElementsManifest(
      entry,
      basePath,
      options,
      adapter,
      moduleResolutionCache,
    );
    for (const dep of resolved.resolutionPaths) {
      resolutionPaths.add(dep);
    }
    if (resolved.kind === ManifestResolutionKind.Failed) {
      diagnostics.push(
        makeManifestDiagnostic(
          ts.DiagnosticCategory.Error,
          ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_NOT_FOUND,
          `Could not resolve Custom Elements Manifest '${entry}': ${resolved.reason}`,
        ),
      );
      continue;
    }
    if (seenManifestPaths.has(resolved.path)) {
      continue;
    }
    seenManifestPaths.add(resolved.path);

    const content = adapter.readFile(resolved.path);
    if (content === undefined) {
      diagnostics.push(
        makeManifestDiagnostic(
          ts.DiagnosticCategory.Error,
          ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_NOT_FOUND,
          `Could not read Custom Elements Manifest '${entry}' ('${resolved.path}').`,
        ),
      );
      continue;
    }

    const label = `'${entry}' ('${resolved.path}')`;
    const parsed = parseCache.getOrParse(
      resolved.path,
      content,
      label,
      resolved.packageName,
      resolved.manifestRelativeDir,
    );

    if (parsed.errors.length > 0) {
      for (const message of parsed.errors) {
        diagnostics.push(
          makeManifestDiagnostic(
            ts.DiagnosticCategory.Error,
            ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_INVALID,
            message,
          ),
        );
      }
      continue;
    }

    const isAppOwned = resolved.packageName === null && !isInNodeModules(resolved.path);
    const warnings = isAppOwned ? [...parsed.warnings] : [];
    for (const schema of parsed.schemas) {
      const tag = schema.tagName.toLowerCase();
      const winner = seenTags.get(tag);
      if (winner !== undefined) {
        if (isAppOwned) {
          warnings.push(`tag '${schema.tagName}' was already declared by ${winner}`);
        }
        continue;
      }
      seenTags.set(tag, label);
      schemas.push(schema);
    }

    if (isAppOwned && warnings.length > 0) {
      const sample = warnings.slice(0, 3).join('; ');
      const suffix = warnings.length > 3 ? `; and ${warnings.length - 3} more` : '';
      diagnostics.push(
        makeManifestDiagnostic(
          ts.DiagnosticCategory.Warning,
          ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_WARNING,
          `Custom Elements Manifest ${label} has ${warnings.length} ` +
            `${warnings.length === 1 ? 'problem' : 'problems'}: ${sample}${suffix}.`,
        ),
      );
    }
  }

  return {
    index: schemas.length > 0 ? new CustomElementsManifestIndex(schemas) : null,
    diagnostics,
    resolutionPaths,
  };
}

function isInNodeModules(path: string): boolean {
  return /(?:^|[\\/])node_modules(?:[\\/]|$)/.test(path);
}

function makeManifestDiagnostic(
  category: ts.DiagnosticCategory,
  code: ErrorCode,
  messageText: string,
): ts.Diagnostic {
  return {
    category,
    code: ngErrorCode(code),
    file: undefined,
    start: undefined,
    length: undefined,
    messageText,
  };
}
