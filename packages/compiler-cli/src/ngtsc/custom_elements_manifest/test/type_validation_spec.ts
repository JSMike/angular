/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import ts from 'typescript';
import {NgCompilerAdapter} from '../../core/api';
import {absoluteFrom as _, getFileSystem, NgtscCompilerHost} from '../../file_system';
import {runInEachFileSystem} from '../../file_system/testing';
import {ManifestResolver} from '../src/manifest_resolver';
import {parseCustomElementsManifest} from '../src/manifest_parser';
import {ManifestTypeChecker, ManifestTypeInput} from '../src/type_resolver';
import {
  createDefinitionExport,
  createManifest,
  createManifestElement,
  createManifestModule,
} from '../testing';

function resolveManifestSchemas(
  parsed: ReturnType<typeof parseCustomElementsManifest>,
  input: Omit<ManifestTypeInput, 'schemas'>,
  context: ManifestTypeChecker,
) {
  return context.resolve([{...input, schemas: parsed.schemas}], 'verbose')[0];
}

const OPTIONS: ts.CompilerOptions = {
  noLib: true,
  strict: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
};

runInEachFileSystem(() => {
  describe('manifest type validation inputs and outputs', () => {
    beforeEach(() => {
      const fs = getFileSystem();
      fs.ensureDir(_('/project/node_modules/types-library'));
      fs.writeFile(_('/project/package.json'), '{"type":"module"}');
      fs.writeFile(_('/project/main.ts'), 'export {};');
      fs.writeFile(_('/project/globals.d.ts'), 'interface GlobalValue {value: string;}');
      fs.writeFile(
        _('/project/node_modules/types-library/package.json'),
        JSON.stringify({
          type: 'module',
          exports: {'.': {import: {types: './import.d.mts'}, require: {types: './require.d.cts'}}},
        }),
      );
      fs.writeFile(
        _('/project/node_modules/types-library/import.d.mts'),
        `export type Choice = 'import'; export type Box<T extends string> = {value: T};`,
      );
      fs.writeFile(
        _('/project/node_modules/types-library/require.d.cts'),
        `export type Choice = 'require';`,
      );
    });

    function makeContext(): ManifestTypeChecker {
      const host = new NgtscCompilerHost(getFileSystem(), OPTIONS);
      const adapter: NgCompilerAdapter = {
        fileExists: host.fileExists.bind(host),
        readFile: host.readFile.bind(host),
        directoryExists: (path) => getFileSystem().exists(_(path)),
        getCurrentDirectory: () => '/project',
        getCanonicalFileName: host.getCanonicalFileName.bind(host),
        getSourceFile: host.getSourceFile.bind(host),
        entryPoint: null,
        constructionDiagnostics: [],
        ignoreForEmit: new Set(),
        unifiedModulesHost: null,
        rootDirs: [_('/project')],
        isShim: () => false,
        isResource: () => false,
      };
      const program = ts.createProgram({
        rootNames: [_('/project/main.ts'), _('/project/globals.d.ts')],
        options: OPTIONS,
        host,
      });
      return new ManifestTypeChecker(
        new ManifestResolver(_('/project'), OPTIONS, adapter),
        program,
      );
    }

    function parseType(text: string, name: string, packageName: string) {
      const type = {text, references: [{name, package: packageName, start: 0, end: name.length}]};
      return parseCustomElementsManifest(
        JSON.stringify(
          createManifest(
            [
              createManifestModule('element.js', {
                declarations: [
                  createManifestElement('Element', 'my-element', {
                    members: [{kind: 'field', name: 'value', type}],
                    attributes: [{name: 'value', type}],
                  }),
                ],
                exports: [createDefinitionExport('my-element', 'Element')],
              }),
            ],
            '2.0.0',
          ),
        ),
        'manifest',
      );
    }

    const manifest = () => ({
      path: _('/project/custom-elements.json'),
      label: 'manifest',
      packageName: null,
      diagnosticsMode: 'verbose' as const,
    });

    it('should retain every diagnostic origin when validating repeated types together', () => {
      const context = makeContext();
      const types = ['Box<number>', 'Box<"valid">', 'Box<boolean>', 'Box<number>'];
      const labels = ['first', 'valid', 'different', 'repeated'];
      const parsed = types.map((text) => parseType(text, 'Box', 'types-library'));
      const originalSchemas = parsed.map(({schemas}) => JSON.stringify(schemas));
      const results = context.resolve(
        labels.map((label, index) => ({
          ...manifest(),
          label,
          schemas: parsed[index].schemas,
        })),
        'verbose',
      );
      expect(results.length).toBe(4);
      for (const [index, result] of results.entries()) {
        expect(JSON.stringify(parsed[index].schemas)).toBe(originalSchemas[index]);
        if (index === 1) {
          expect(result.warnings).toEqual([]);
          expect(result.schemas[0].properties[0].checkType).toBe(
            'import("types-library").Box<"valid">',
          );
          continue;
        }
        expect(result.warnings.length).toBe(2);
        expect(
          result.warnings.every((warning) => warning.message.includes(labels[index])),
        ).toBeTrue();
        expect(result.warnings[0].message).toContain(`declares type text "${types[index]}"`);
        expect(result.schemas[0].properties[0].checkType).toBeUndefined();
        expect(result.schemas[0].properties[0].typeText).toBe(types[index]);
      }
    });

    it('should keep manifest-relative resolutions distinct when batching identical author types', () => {
      const fs = getFileSystem();
      fs.ensureDir(_('/project/node_modules/nested-library'));
      fs.writeFile(
        _('/project/node_modules/nested-library/package.json'),
        JSON.stringify({
          name: 'nested-library',
          exports: {'./one': './one/types.d.ts', './two': './two/types.d.ts'},
        }),
      );
      const context = makeContext();
      const inputs = ['one', 'two'].map((name) => {
        fs.ensureDir(_(`/project/node_modules/nested-library/${name}`));
        fs.writeFile(
          _(`/project/node_modules/nested-library/${name}/types.d.ts`),
          `export type Choice = '${name}';`,
        );
        return {
          ...manifest(),
          schemas: parseType('Choice', 'Choice', 'nested-library').schemas,
          path: _(`/project/node_modules/nested-library/${name}/custom-elements.json`),
          packageName: 'nested-library',
        };
      });
      const results = context.resolve(inputs, 'verbose');
      for (const [index, result] of results.entries()) {
        expect(result.diagnostics).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.schemas[0].attributes[0].stringLiteralValues).toEqual([
          index === 0 ? 'one' : 'two',
        ]);
      }
    });

    it('should reuse consumer sources across manifests on a non-caching host', () => {
      const context = makeContext();
      const {
        sources: {adapter},
        program,
      } = context;
      const reads = spyOn(adapter, 'getSourceFile').and.callThrough();
      for (let index = 0; index < 2; index++) {
        const result = resolveManifestSchemas(
          parseType('GlobalValue', 'GlobalValue', 'global:'),
          manifest(),
          context,
        );
        expect(result.warnings).toEqual([]);
        expect(result.diagnostics).toEqual([]);
        expect(result.schemas[0].properties[0].checkType).toBe('GlobalValue');
      }
      const reparsedConsumerFiles = reads.calls
        .allArgs()
        .filter(([name]) => program.getSourceFile(name) !== undefined);
      expect(reparsedConsumerFiles).toEqual([]);
    });

    for (const [moduleType, choice] of [
      ['module', 'import'],
      ['commonjs', 'require'],
    ]) {
      it(`should validate with ${choice} conditions in a ${moduleType} package`, () => {
        getFileSystem().writeFile(_('/project/package.json'), JSON.stringify({type: moduleType}));
        const result = resolveManifestSchemas(
          parseType('Choice', 'Choice', 'types-library'),
          manifest(),
          makeContext(),
        );
        expect(result.diagnostics).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.schemas[0].attributes[0].stringLiteralValues).toEqual([choice]);
      });
    }
  });
});
