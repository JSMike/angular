/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import ts from 'typescript';

import {FileSystem, getFileSystem} from '../../file_system';
import {runInEachFileSystem} from '../../file_system/testing';
import {
  getCemImportReachabilityInProgram,
  getRootDirs,
  isCemImportReachableInProgram,
  isFileIncludedByNonShim,
  NG_STANDARD_MODULE_RESOLVER,
  StandardResolveModuleNames,
} from '../src/typescript';

runInEachFileSystem(() => {
  let fs: FileSystem;

  beforeEach(() => {
    fs = getFileSystem();
  });

  describe('typescript', () => {
    it('should allow relative root directories', () => {
      const mockCompilerHost = {
        getCanonicalFileName: (val: string) => val,
        getCurrentDirectory: () => '/fs-root/projects',
      };
      const result = getRootDirs(mockCompilerHost, {rootDir: './test-project-root'});
      expect(result).toEqual([fs.resolve('/fs-root/projects/test-project-root')]);
    });

    it('should detect non-shim reachability via getFileIncludeReasons, exclude LS .ngtypecheck.ts roots, and fail closed when unavailable', () => {
      const files = new Map<string, string>([
        ['/proj/user.ts', `import './used.js';`],
        ['/proj/used.d.ts', `export declare class Used {}`],
        ['/proj/app.ts', `export class App {}`],
        // Simulates a Language Service `.ngtypecheck.ts` root with NO NgExtension metadata.
        ['/proj/app.ngtypecheck.ts', `export type T = import('./cycle-a.js').A;`],
        ['/proj/cycle-a.d.ts', `import {B} from './cycle-b.js'; export declare class A { b: B; }`],
        ['/proj/cycle-b.d.ts', `import {A} from './cycle-a.js'; export declare class B { a: A; }`],
        // Simulates an ngc ShimAdapter-tagged shim.
        ['/proj/tagged.shim.ts', `export type U = import('./shim-only.js').S;`],
        ['/proj/shim-only.d.ts', `export declare class S {}`],
      ]);
      const host: ts.CompilerHost = {
        getSourceFile: (f, v) =>
          files.has(f) ? ts.createSourceFile(f, files.get(f)!, v) : undefined,
        writeFile: () => {},
        getCurrentDirectory: () => '/proj',
        getDirectories: () => [],
        fileExists: (f) => files.has(f),
        readFile: (f) => files.get(f),
        getCanonicalFileName: (f) => f,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        getDefaultLibFileName: () => '/lib.d.ts',
      };
      const program = ts.createProgram(
        ['/proj/user.ts', '/proj/app.ts', '/proj/app.ngtypecheck.ts', '/proj/tagged.shim.ts'],
        {moduleResolution: ts.ModuleResolutionKind.Bundler},
        host,
      );
      const isTaggedShim = (sf: ts.SourceFile) => sf.fileName === '/proj/tagged.shim.ts';

      // Guard: supported TypeScript versions must expose `getFileIncludeReasons()`.
      expect(
        typeof (program as unknown as {getFileIncludeReasons?: unknown}).getFileIncludeReasons,
      ).toBe('function');

      expect(
        isFileIncludedByNonShim(
          program,
          program.getSourceFile('/proj/used.d.ts')!,
          isTaggedShim,
          (f) => f,
        ),
      ).toBeTrue();
      // LS `.ngtypecheck.ts` root and mutually-importing cycle are excluded even when `isShim` is false.
      expect(
        isFileIncludedByNonShim(
          program,
          program.getSourceFile('/proj/cycle-a.d.ts')!,
          () => false,
          (f) => f,
        ),
      ).toBeFalse();
      expect(
        isFileIncludedByNonShim(
          program,
          program.getSourceFile('/proj/shim-only.d.ts')!,
          isTaggedShim,
          (f) => f,
        ),
      ).toBeFalse();

      // Fail closed if `getFileIncludeReasons` is absent.
      const programWithoutReasons = Object.assign(Object.create(program), {
        getFileIncludeReasons: undefined,
      }) as ts.Program;
      expect(
        isFileIncludedByNonShim(
          programWithoutReasons,
          program.getSourceFile('/proj/used.d.ts')!,
          isTaggedShim,
          (f) => f,
        ),
      ).toBeFalse();
    });

    it('should resolve conditional exports on standard hosts and fail closed on custom resolvers without invoking them', () => {
      for (const [pkgType, expectedTarget] of [
        ['module', 'esm'],
        ['commonjs', 'cjs'],
      ] as const) {
        const files = new Map<string, string>([
          ['/proj/package.json', JSON.stringify({type: pkgType})],
          [
            '/proj/node_modules/cond-pkg/package.json',
            JSON.stringify({
              name: 'cond-pkg',
              exports: {
                '.': {
                  import: {types: './esm.d.ts', default: './esm.mjs'},
                  require: {types: './cjs.d.ts', default: './cjs.cjs'},
                },
              },
            }),
          ],
          ['/proj/node_modules/cond-pkg/esm.d.ts', `export declare class EsmEl {}`],
          ['/proj/node_modules/cond-pkg/cjs.d.ts', `export declare class CjsEl {}`],
          ['/proj/node_modules/cond-pkg/alternate.d.ts', `export declare class AltEl {}`],
          ['/proj/main.ts', `import 'cond-pkg';`],
          ['/proj/app.ts', `export class App {}`],
        ]);
        const opts: ts.CompilerOptions = {
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
        };
        const standardHost: ts.CompilerHost = {
          getSourceFile: (f, v) =>
            files.has(f) ? ts.createSourceFile(f, files.get(f)!, v) : undefined,
          writeFile: () => {},
          getCurrentDirectory: () => '/proj',
          getDirectories: () => [],
          fileExists: (f) => files.has(f),
          readFile: (f) => files.get(f),
          getCanonicalFileName: (f) => f,
          useCaseSensitiveFileNames: () => true,
          getNewLine: () => '\n',
          getDefaultLibFileName: () => '/lib.d.ts',
        };
        const program = ts.createProgram(['/proj/main.ts', '/proj/app.ts'], opts, standardHost);
        const cache = ts.createModuleResolutionCache('/proj', (f) => f, opts);

        // Standard host (no custom resolvers): resolves NodeNext ESM & CJS conditional exports.
        expect(
          isCemImportReachableInProgram(
            program,
            standardHost,
            '/proj/app.ngtypecheck.ts',
            'cond-pkg',
            () => false,
            () => cache,
          ),
        )
          .withContext(`standard host pkgType=${pkgType} (${expectedTarget})`)
          .toBeTrue();

        // Angular's own tagged standard `resolveModuleNames` wrapper mirrors `NgCompilerHost`'s
        // cached `ts.resolveModuleName` call (which omits `resolutionMode`), so it must agree
        // with a program compiled using that same wrapper.
        const taggedResolve: StandardResolveModuleNames = (names, containingFile) =>
          names.map(
            (n) => ts.resolveModuleName(n, containingFile, opts, standardHost).resolvedModule,
          );
        taggedResolve[NG_STANDARD_MODULE_RESOLVER] = true;
        const taggedHost: ts.CompilerHost = {...standardHost, resolveModuleNames: taggedResolve};
        const taggedProgram = ts.createProgram(['/proj/main.ts', '/proj/app.ts'], opts, taggedHost);
        const taggedCache = ts.createModuleResolutionCache('/proj', (f) => f, opts);
        expect(
          isCemImportReachableInProgram(
            taggedProgram,
            taggedHost,
            '/proj/app.ngtypecheck.ts',
            'cond-pkg',
            () => false,
            () => taggedCache,
          ),
        )
          .withContext(`tagged NgCompilerHost resolver pkgType=${pkgType}`)
          .toBeTrue();
        if (pkgType === 'module') {
          // `program` only loaded `esm.d.ts`, whereas `taggedHost` resolves `cond-pkg` to
          // `cjs.d.ts` — the gate must mirror `taggedHost` and reject the mismatch.
          expect(
            isCemImportReachableInProgram(
              program,
              taggedHost,
              '/proj/app.ngtypecheck.ts',
              'cond-pkg',
              () => false,
              () => taggedCache,
            ),
          ).toBeFalse();
        }

        // Custom `resolveModuleNameLiterals` host (e.g. watch host or shim-redirecting host):
        // must fail closed without invoking the custom resolver even when filesystem resolution
        // finds an already-reachable declaration.
        let customLiteralsCalled = false;
        const redirectingLiteralsHost: ts.CompilerHost = {
          ...standardHost,
          resolveModuleNameLiterals: (literals, containingFile) => {
            customLiteralsCalled = true;
            return literals.map(() => ({
              resolvedModule: {
                resolvedFileName: '/proj/node_modules/cond-pkg/alternate.d.ts',
                extension: ts.Extension.Dts,
                isExternalLibraryImport: true,
              },
            }));
          },
        };
        expect(
          isCemImportReachableInProgram(
            program,
            redirectingLiteralsHost,
            '/proj/app.ngtypecheck.ts',
            'cond-pkg',
            () => false,
            () => cache,
          ),
        ).toBeFalse();
        expect(customLiteralsCalled).toBeFalse();

        // Custom untagged `resolveModuleNames` host: must also fail closed without invoking it.
        let customNamesCalled = false;
        const redirectingNamesHost: ts.CompilerHost = {
          ...standardHost,
          resolveModuleNames: (names) => {
            customNamesCalled = true;
            return names.map(() => ({
              resolvedFileName: '/proj/node_modules/cond-pkg/alternate.d.ts',
            }));
          },
        };
        expect(
          isCemImportReachableInProgram(
            program,
            redirectingNamesHost,
            '/proj/app.ngtypecheck.ts',
            'cond-pkg',
            () => false,
            () => cache,
          ),
        ).toBeFalse();
        expect(customNamesCalled).toBeFalse();

        // Host with no module resolution fails closed (`'gated'`).
        const minimalHost = {getCanonicalFileName: (f: string) => f};
        expect(
          getCemImportReachabilityInProgram(
            program,
            minimalHost,
            '/proj/app.ngtypecheck.ts',
            'cond-pkg',
            () => false,
            () => cache,
          ),
        ).toBe('gated');

        // Distinguish `'gated'` (unimported `.d.ts` on disk) from `'unresolved'` (no `.d.ts` on
        // disk, including JS-only packages when `!allowJs`).
        files.set(
          '/proj/node_modules/unimported-typed/package.json',
          JSON.stringify({name: 'unimported-typed', types: './index.d.ts'}),
        );
        files.set('/proj/node_modules/unimported-typed/index.d.ts', 'export declare class T {}');
        files.set(
          '/proj/node_modules/js-only/package.json',
          JSON.stringify({name: 'js-only', main: './index.js'}),
        );
        files.set('/proj/node_modules/js-only/index.js', 'export class J {}');
        expect(
          getCemImportReachabilityInProgram(
            program,
            standardHost,
            '/proj/app.ngtypecheck.ts',
            'unimported-typed',
            () => false,
            () => cache,
          ),
        ).toBe('gated');
        expect(
          getCemImportReachabilityInProgram(
            program,
            standardHost,
            '/proj/app.ngtypecheck.ts',
            'js-only',
            () => false,
            () => cache,
          ),
        ).toBe('unresolved');
        // Even with `allowJs: true`, TS does not load JS files from `node_modules` when
        // `maxNodeModuleJsDepth` is 0 (default), so a JS-only package stays `'unresolved'`.
        const allowJsProgram = ts.createProgram(
          ['/proj/main.ts', '/proj/app.ts'],
          {...opts, allowJs: true},
          standardHost,
        );
        expect(
          getCemImportReachabilityInProgram(
            allowJsProgram,
            standardHost,
            '/proj/app.ngtypecheck.ts',
            'js-only',
            () => false,
            () => ts.createModuleResolutionCache('/proj', (f) => f, {...opts, allowJs: true}),
          ),
        ).toBe('unresolved');
        expect(
          getCemImportReachabilityInProgram(
            program,
            standardHost,
            '/proj/app.ngtypecheck.ts',
            'does-not-exist',
            () => false,
            () => cache,
          ),
        ).toBe('unresolved');
      }
    });
  });
});
