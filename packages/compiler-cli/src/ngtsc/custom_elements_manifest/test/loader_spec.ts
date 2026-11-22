/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import ts from 'typescript';

import {NgCompilerHost} from '../../core';
import {ErrorCode, ngErrorCode} from '../../diagnostics';
import {absoluteFrom, getFileSystem} from '../../file_system';
import {runInEachFileSystem} from '../../file_system/testing';
import {CustomElementsManifestParseCache, loadCustomElementsManifests} from '../src/loader';

function makeManifest(tagName: string, extra?: {[key: string]: unknown}): string {
  return JSON.stringify({
    schemaVersion: '2.1.0',
    modules: [
      {
        kind: 'javascript-module',
        path: 'el.js',
        declarations: [
          {
            kind: 'class',
            name: 'MyEl',
            customElement: true,
            tagName,
            members: [{kind: 'field', name: 'label', type: {text: 'string'}}],
            ...extra,
          },
        ],
      },
    ],
  });
}

runInEachFileSystem(() => {
  describe('custom elements manifest loader', () => {
    function setupHost(files: Record<string, string>) {
      const fs = getFileSystem();
      const basePath = absoluteFrom('/project');
      fs.ensureDir(basePath);
      for (const [rel, content] of Object.entries(files)) {
        const full = fs.resolve(basePath, rel);
        fs.ensureDir(fs.dirname(full));
        fs.writeFile(full, content);
      }
      const options: ts.CompilerOptions = {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
      };
      const baseHost = ts.createCompilerHost(options);
      const adapter = NgCompilerHost.wrap(
        baseHost,
        [fs.resolve(basePath, 'app.ts')],
        options,
        null,
      );
      return {fs, basePath, options, adapter};
    }

    it('should report NG4007 for missing manifests and suggest ./ for bare .json entries', () => {
      const {basePath, options, adapter} = setupHost({
        'app.ts': 'export class App {}',
        'custom-elements.json': makeManifest('local-el'),
      });

      const result = loadCustomElementsManifests(
        ['custom-elements.json'],
        basePath,
        options,
        adapter,
        null,
      );
      expect(result.index).toBeNull();
      expect(result.diagnostics.length).toBe(1);
      expect(result.diagnostics[0].code).toBe(
        ngErrorCode(ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_NOT_FOUND),
      );
      expect(String(result.diagnostics[0].messageText)).toContain('./custom-elements.json');
    });

    it('should emit one NG4009 warning for app-owned manifests and stay silent for node_modules', () => {
      const badLocal = makeManifest('local-el', {
        members: [
          {kind: 'field', name: 'a', type: {text: 'UnknownA'}},
          {kind: 'field', name: 'b', type: {text: 'UnknownB'}},
        ],
      });
      const badPkg = makeManifest('pkg-el', {
        members: [{kind: 'field', name: 'a', type: {text: 'UnknownA'}}],
      });
      const {basePath, options, adapter} = setupHost({
        'app.ts': 'export class App {}',
        'local.json': badLocal,
        'node_modules/my-pkg/package.json': JSON.stringify({
          name: 'my-pkg',
          customElements: 'custom-elements.json',
        }),
        'node_modules/my-pkg/custom-elements.json': badPkg,
      });

      const result = loadCustomElementsManifests(
        ['./local.json', 'my-pkg'],
        basePath,
        options,
        adapter,
        null,
      );
      expect(result.index).not.toBeNull();
      expect(result.index!.getSchema('local-el')).not.toBeNull();
      expect(result.index!.getSchema('pkg-el')).not.toBeNull();
      expect(result.diagnostics.length).toBe(1);
      expect(result.diagnostics[0].category).toBe(ts.DiagnosticCategory.Warning);
      expect(result.diagnostics[0].code).toBe(
        ngErrorCode(ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_WARNING),
      );
      expect(String(result.diagnostics[0].messageText)).toContain('has 2 problems');
    });

    it('should reuse cached schemas when content is unchanged and invalidate on edit', () => {
      const {fs, basePath, options, adapter} = setupHost({
        'app.ts': 'export class App {}',
        'local.json': makeManifest('local-el'),
      });
      const cache = new CustomElementsManifestParseCache();

      const first = loadCustomElementsManifests(
        ['./local.json'],
        basePath,
        options,
        adapter,
        null,
        cache,
      );
      const second = loadCustomElementsManifests(
        ['./local.json'],
        basePath,
        options,
        adapter,
        null,
        cache,
      );
      expect(second.index!.schemas[0]).toBe(first.index!.schemas[0]);

      fs.writeFile(fs.resolve(basePath, 'local.json'), makeManifest('local-el-v2'));
      const third = loadCustomElementsManifests(
        ['./local.json'],
        basePath,
        options,
        adapter,
        null,
        cache,
      );
      expect(third.index!.getSchema('local-el-v2')).not.toBeNull();
      expect(third.index!.getSchema('local-el')).toBeNull();
    });
  });
});
