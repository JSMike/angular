/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {customElementsManifest} from '@angular/compiler-cli/src/ngtsc/custom_elements_manifest/testing';
import {absoluteFrom, getFileSystem} from '@angular/compiler-cli/src/ngtsc/file_system';
import {ErrorCode, ngErrorCode} from '@angular/compiler-cli/src/ngtsc/diagnostics';

import ts from 'typescript';

import {createModuleAndProjectWithDeclarations, LanguageServiceTestEnv} from '../testing';

describe('getSemanticDiagnostics', () => {
  let env: LanguageServiceTestEnv;
  beforeEach(() => {
    env = LanguageServiceTestEnv.setup();
  });

  it('should not produce error for a minimal component definition', () => {
    const files = {
      'app.ts': `
      import {Component, NgModule} from '@angular/core';

      @Component({
        template: '',
        standalone: false,
      })
      export class AppComponent {}
    `,
    };
    const project = createModuleAndProjectWithDeclarations(env, 'test', files);

    const diags = project.getDiagnosticsForFile('app.ts');
    expect(diags.length).toEqual(0);
  });

  it('should report member does not exist', () => {
    const files = {
      'app.ts': `
      import {Component, NgModule} from '@angular/core';

      @Component({
        template: '{{nope}}',
        standalone: false,
      })
      export class AppComponent {}
    `,
    };
    const project = createModuleAndProjectWithDeclarations(env, 'test', files);

    const diags = project.getDiagnosticsForFile('app.ts');
    expect(diags.length).toBe(1);
    const {category, file, messageText} = diags[0];
    expect(category).toBe(ts.DiagnosticCategory.Error);
    expect(file?.fileName).toBe(project.getAbsFileName('app.ts'));
    expect(messageText).toBe(`Property 'nope' does not exist on type 'AppComponent'.`);
  });

  it('produces diagnostic for duplicate docarated property rather than crashing', () => {
    const files = {
      'app.ts': `
      import {Component, Input} from '@angular/core';

      @Component({
        template: '',
      })
      export class AppComponent {
        @Input() test1?: string;
        @Input() test1?: string;
      }
    `,
    };
    const project = createModuleAndProjectWithDeclarations(env, 'test', files);

    const diags = project.getDiagnosticsForFile('app.ts');
    expect(diags.length).toBe(2);
    expect(diags[0].category).toBe(ts.DiagnosticCategory.Error);
    expect(diags[0].file?.fileName).toBe(project.getAbsFileName('app.ts'));
    expect(diags[0].messageText).toBe(`Duplicate identifier 'test1'.`);
    expect(diags[1].category).toBe(ts.DiagnosticCategory.Error);
    expect(diags[1].file?.fileName).toBe(project.getAbsFileName('app.ts'));
    expect(diags[1].messageText).toBe(`Input 'test1' is bound to both 'test1' and 'test1'.`);
  });

  it('should process external template', () => {
    const files = {
      'app.ts': `
      import {Component, NgModule} from '@angular/core';

      @Component({
        templateUrl: './app.html',
        standalone: false,
      })
      export class AppComponent {}
    `,
      'app.html': `Hello world!`,
    };

    const project = createModuleAndProjectWithDeclarations(env, 'test', files);
    const diags = project.getDiagnosticsForFile('app.html');
    expect(diags).toEqual([]);
  });

  it('should report invalid interpolated custom-element manifest properties', () => {
    const manifest = customElementsManifest({
      tagName: 'my-meter',
      members: [{kind: 'field', name: 'value', type: {text: 'number'}}],
    });
    const project = env.addProject(
      'test-cem-interpolation',
      {
        'custom-elements.json': JSON.stringify(manifest),
        'app.ts': `
          import {Component} from '@angular/core';

          @Component({templateUrl: './app.html'})
          export class AppComponent { value = 1; }
        `,
        'app.html': `<my-meter value="{{ value }}"></my-meter>`,
      },
      {strictTemplates: true, customElementsManifests: ['./custom-elements.json']},
    );

    const diags = project.getDiagnosticsForFile('app.html');
    expect(diags.length).toBe(1);
    expect(diags[0].messageText).toBe(`Type 'string' is not assignable to type 'number'.`);
  });

  it('should update custom-element manifest diagnostics after an editor resource change', () => {
    const manifest = (type: string) =>
      customElementsManifest({
        tagName: 'my-meter',
        members: [{kind: 'field', name: 'value', type: {text: type}}],
      });
    const project = env.addProject(
      'test-cem-resource-change',
      {
        'custom-elements.json': JSON.stringify(manifest('number')),
        'app.ts': `
          import {Component} from '@angular/core';

          @Component({templateUrl: './app.html'})
          export class AppComponent {}
        `,
        'app.html': `<my-meter [value]="'text'"></my-meter>`,
      },
      {strictTemplates: true, customElementsManifests: ['./custom-elements.json']},
    );

    expect(
      project.getDiagnosticsForFile('app.html').map((diagnostic) => diagnostic.messageText),
    ).toEqual([`Type 'string' is not assignable to type 'number'.`]);

    // Editing the registered manifest must invalidate Angular's checks without a TypeScript change.
    project.openFile('custom-elements.json').contents = JSON.stringify(manifest('string'));

    expect(project.getDiagnosticsForFile('app.html')).toEqual([]);
  });

  for (const [entry, manifestFile] of [
    ['./custom-elements.json', 'custom-elements.json'],
    ['@test/elements/custom-elements.json', 'node_modules/@test/elements/catalog.json'],
  ]) {
    it(`should detect deletion of an open manifest configured as ${entry}`, () => {
      const manifest = (type: string) =>
        JSON.stringify(
          customElementsManifest({
            tagName: 'my-meter',
            members: [{kind: 'field', name: 'value', type: {text: type}}],
          }),
        );
      const diskManifest = manifest('number');
      const unsavedManifest = manifest('string');
      const project = env.addProject(
        'test-cem-open-deletion',
        {
          [manifestFile]: diskManifest,
          'node_modules/@test/elements/package.json': JSON.stringify({
            name: '@test/elements',
            exports: {'./custom-elements.json': './catalog.json'},
          }),
          'app.ts': `
            import {Component} from '@angular/core';

            @Component({templateUrl: './app.html'})
            export class AppComponent {}
          `,
          'app.html': `<my-meter [value]="'text'"></my-meter>`,
        },
        {strictTemplates: true, customElementsManifests: [entry]},
      );

      expect(
        project.getDiagnosticsForFile('app.html').map((diagnostic) => diagnostic.messageText),
      ).toEqual([`Type 'string' is not assignable to type 'number'.`]);

      // Opening a node_modules resource alone does not retain the app's configured project.
      project.openFile('app.ts');
      const buffer = project.openFile(manifestFile);
      buffer.contents = unsavedManifest;
      expect(project.getDiagnosticsForFile('app.html')).toEqual([]);

      // An editor can retain an open TextDocument after its tab has closed. A disk deletion
      // must still invalidate the manifest, without a buffer edit or TypeScript watcher event.
      const fs = getFileSystem();
      const manifestPath = absoluteFrom(project.getAbsFileName(manifestFile));
      fs.removeFile(manifestPath);
      expect(
        project.ngLS
          .getCompilerOptionsDiagnostics()
          .some(
            (diagnostic) =>
              diagnostic.code === ngErrorCode(ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_NOT_FOUND),
          ),
      ).toBe(true);
      expect(
        project
          .getDiagnosticsForFile('app.html')
          .some((diagnostic) => diagnostic.code === ngErrorCode(ErrorCode.SCHEMA_INVALID_ELEMENT)),
      ).toBe(true);
      expect(buffer.contents).toBe(unsavedManifest);

      // Recreating the backing file restores availability, while the retained unsaved buffer
      // remains authoritative until it is actually closed.
      fs.writeFile(manifestPath, diskManifest);
      expect(
        project.ngLS
          .getCompilerOptionsDiagnostics()
          .some(
            (diagnostic) =>
              diagnostic.code === ngErrorCode(ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_NOT_FOUND),
          ),
      ).toBe(false);
      expect(project.getDiagnosticsForFile('app.html')).toEqual([]);
      expect(buffer.contents).toBe(unsavedManifest);
      expect(fs.readFile(manifestPath)).toBe(diskManifest);

      buffer.close();
      expect(
        project.getDiagnosticsForFile('app.html').map((diagnostic) => diagnostic.messageText),
      ).toEqual([`Type 'string' is not assignable to type 'number'.`]);
    });
  }

  it('should not loop resource invalidation after deleting a package manifest and package.json', () => {
    const project = env.addProject(
      'test-cem-package-deleted',
      {
        'node_modules/@test/elements/package.json': JSON.stringify({
          name: '@test/elements',
          customElements: './catalog.json',
        }),
        'node_modules/@test/elements/catalog.json': JSON.stringify(
          customElementsManifest({tagName: 'my-meter'}),
        ),
        'app.ts': `
          import {Component} from '@angular/core';
          @Component({templateUrl: './app.html'})
          export class AppComponent {}
        `,
        'app.html': `<my-meter></my-meter>`,
      },
      {strictTemplates: true, customElementsManifests: ['@test/elements']},
    );

    expect(project.getDiagnosticsForFile('app.html')).toEqual([]);

    const fs = getFileSystem();
    const packagePath = absoluteFrom(
      project.getAbsFileName('node_modules/@test/elements/package.json'),
    );
    const manifestPath = absoluteFrom(
      project.getAbsFileName('node_modules/@test/elements/catalog.json'),
    );
    fs.removeFile(manifestPath);
    fs.removeFile(packagePath);

    expect(
      project.ngLS
        .getCompilerOptionsDiagnostics()
        .some(
          (diagnostic) =>
            diagnostic.code === ngErrorCode(ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_NOT_FOUND),
        ),
    ).toBe(true);
    const compilerAfterDelete = project.ngLS.compilerFactory.getOrCreate();
    // Subsequent calls must not keep treating the deleted dependency/manifest as modified.
    expect(
      project
        .getDiagnosticsForFile('app.html')
        .some((diagnostic) => diagnostic.code === ngErrorCode(ErrorCode.SCHEMA_INVALID_ELEMENT)),
    ).toBe(true);
    expect(project.ngLS.compilerFactory.getOrCreate()).toBe(compilerAfterDelete);
    expect(project.ngLS.compilerFactory.getOrCreate()).toBe(compilerAfterDelete);

    // Reinstalling the package restores recognition.
    fs.writeFile(
      packagePath,
      JSON.stringify({name: '@test/elements', customElements: './catalog.json'}),
    );
    fs.writeFile(manifestPath, JSON.stringify(customElementsManifest({tagName: 'my-meter'})));
    expect(project.getDiagnosticsForFile('app.html')).toEqual([]);
  });

  it('should expose manifest resolution paths, but not other resources, for editor tracking', () => {
    const project = env.addProject(
      'test-cem-resource-dependencies',
      {
        'catalog.data': JSON.stringify(customElementsManifest({tagName: 'my-element'})),
        'node_modules/my-elements/package.json': JSON.stringify({
          name: 'my-elements',
          customElements: './catalog.json',
        }),
        'node_modules/my-elements/catalog.json': JSON.stringify(
          customElementsManifest({tagName: 'package-element'}),
        ),
        'unrelated.json': '{}',
        'app.ts': `
          import {Component} from '@angular/core';
          @Component({templateUrl: './app.html', styleUrls: ['./app.css']})
          export class AppComponent {}
        `,
        'app.html': '<my-element></my-element>',
        'app.css': ':host { display: block; }',
      },
      {customElementsManifests: ['./catalog.data', './missing.json', 'my-elements']},
    );
    // Analyze the component so that its template and stylesheet are read as resources.
    project.getDiagnosticsForFile('app.html');

    const resolutionPaths = project.ngLS.getCustomElementsManifestResolutionPaths();
    for (const file of [
      'catalog.data',
      'missing.json',
      'node_modules/my-elements/package.json',
      'node_modules/my-elements/catalog.json',
    ]) {
      expect(resolutionPaths).toContain(project.getAbsFileName(file));
    }
    // Templates and stylesheets are synchronized and watched as before, not as manifests.
    for (const file of ['unrelated.json', 'app.html', 'app.css']) {
      expect(resolutionPaths).not.toContain(project.getAbsFileName(file));
    }
    expect(new Set(resolutionPaths).size).toBe(resolutionPaths.length);
  });

  it('should load a configured relative manifest created after it was initially missing', () => {
    const manifest = customElementsManifest({
      tagName: 'late-meter',
      members: [{kind: 'field', name: 'value', type: {text: 'number'}}],
    });
    const project = env.addProject(
      'test-cem-created-after-missing',
      {
        'app.ts': `
          import {Component} from '@angular/core';

          @Component({templateUrl: './app.html'})
          export class AppComponent {}
        `,
        'app.html': `<late-meter [value]="'text'"></late-meter><late-meter ></late-meter>`,
      },
      {strictTemplates: true, customElementsManifests: ['./custom-elements.json']},
    );

    expect(
      project.ngLS
        .getCompilerOptionsDiagnostics()
        .some(
          (diagnostic) =>
            diagnostic.code === ngErrorCode(ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_NOT_FOUND),
        ),
    ).toBe(true);
    expect(
      project
        .getDiagnosticsForFile('app.html')
        .some((diagnostic) => diagnostic.code === ngErrorCode(ErrorCode.SCHEMA_INVALID_ELEMENT)),
    ).toBe(true);

    const fs = getFileSystem();
    const manifestPath = absoluteFrom(project.getAbsFileName('custom-elements.json'));
    fs.writeFile(manifestPath, JSON.stringify(manifest));
    env.notifyFileChange(manifestPath, ts.FileWatcherEventKind.Created);

    expect(project.ngLS.getCompilerOptionsDiagnostics()).toEqual([]);
    expect(
      project.getDiagnosticsForFile('app.html').map((diagnostic) => diagnostic.messageText),
    ).toEqual([`Type 'string' is not assignable to type 'number'.`]);

    const template = project.openFile('app.html');
    template.moveCursorToText('<late-meter ¦>');
    expect(
      template.getCompletionsAtPosition()?.entries.some((entry) => entry.name === '[value]'),
    ).toBe(true);
  });

  for (const useExports of [false, true]) {
    it(`should load a missing package manifest after creation with exports=${useExports}`, () => {
      const packageDirectory = 'node_modules/@test/elements';
      const manifestFile = `${packageDirectory}/${useExports ? 'exported' : 'custom-elements'}.json`;
      const project = env.addProject(
        'test-cem-package-created',
        {
          'app.ts': `
          import {Component} from '@angular/core';
          @Component({templateUrl: './app.html'}) export class AppComponent {}
        `,
          'app.html': '<late-element></late-element>',
          [`${packageDirectory}/package.json`]: JSON.stringify({
            name: '@test/elements',
            ...(useExports ? {exports: {'./custom-elements.json': './exported.json'}} : {}),
          }),
        },
        {
          strictTemplates: true,
          customElementsManifests: ['@test/elements/custom-elements.json'],
        },
      );
      expect(
        project
          .getDiagnosticsForFile('app.html')
          .some((diagnostic) => diagnostic.code === ngErrorCode(ErrorCode.SCHEMA_INVALID_ELEMENT)),
      ).toBe(true);
      const manifestPath = absoluteFrom(project.getAbsFileName(manifestFile));
      getFileSystem().writeFile(
        manifestPath,
        JSON.stringify({
          schemaVersion: '1.0.0',
          modules: [
            {
              kind: 'javascript-module',
              path: 'element.js',
              exports: [
                {
                  kind: 'custom-element-definition',
                  name: 'late-element',
                  declaration: {name: 'Element'},
                },
              ],
            },
          ],
        }),
      );
      env.notifyFileChange(manifestPath, ts.FileWatcherEventKind.Created);
      expect(
        project.ngLS
          .getCompilerOptionsDiagnostics()
          .some(
            (diagnostic) =>
              diagnostic.code === ngErrorCode(ErrorCode.CONFIG_CUSTOM_ELEMENTS_MANIFEST_NOT_FOUND),
          ),
      ).toBe(false);
      expect(project.getDiagnosticsForFile('app.html')).toEqual([]);
    });
  }

  it('should refresh definition-only manifests when a package export changes', () => {
    const manifest = (tag: string) =>
      JSON.stringify({
        schemaVersion: '1.0.0',
        modules: [
          {
            kind: 'javascript-module',
            path: 'element.js',
            exports: [
              {kind: 'custom-element-definition', name: tag, declaration: {name: 'Element'}},
            ],
          },
        ],
      });
    const packageJson = (file: string) =>
      JSON.stringify({
        name: '@test/elements',
        exports: {'./custom-elements.json': `./${file}.json`},
      });
    const project = env.addProject(
      'test-cem-package-exports',
      {
        'app.ts': `
        import {Component} from '@angular/core';
        @Component({templateUrl: './app.html'}) export class AppComponent {}
      `,
        'app.html': '<first-element></first-element><second-element></second-element>',
        'node_modules/@test/elements/package.json': packageJson('first'),
        'node_modules/@test/elements/first.json': manifest('first-element'),
        'node_modules/@test/elements/second.json': manifest('second-element'),
      },
      {
        strictTemplates: true,
        customElementsManifests: ['@test/elements/custom-elements.json'],
      },
    );
    const initial = project.getDiagnosticsForFile('app.html');
    expect(initial.length).toBe(1);
    expect(initial[0].messageText).toContain("'second-element' is not a known element");
    const packagePath = absoluteFrom(
      project.getAbsFileName('node_modules/@test/elements/package.json'),
    );
    getFileSystem().writeFile(packagePath, packageJson('second'));
    env.notifyFileChange(packagePath, ts.FileWatcherEventKind.Changed);
    const updated = project.getDiagnosticsForFile('app.html');
    expect(updated.length).toBe(1);
    expect(updated[0].messageText).toContain("'first-element' is not a known element");

    // Editing the abandoned `first.json` after package.json redirected to `second.json` must not
    // cause repeated resource-change invalidations.
    const compilerAfterRedirect = project.ngLS.compilerFactory.getOrCreate();
    const firstPath = absoluteFrom(
      project.getAbsFileName('node_modules/@test/elements/first.json'),
    );
    getFileSystem().writeFile(firstPath, manifest('third-element'));
    env.notifyFileChange(firstPath, ts.FileWatcherEventKind.Changed);
    expect(project.getDiagnosticsForFile('app.html').length).toBe(1);
    expect(project.ngLS.compilerFactory.getOrCreate()).toBe(compilerAfterRedirect);
    expect(project.getDiagnosticsForFile('app.html').length).toBe(1);
    expect(project.ngLS.compilerFactory.getOrCreate()).toBe(compilerAfterRedirect);
  });

  it('should recheck closed manifest and package.json hashes after project updates even when mtime and size are unchanged', () => {
    const manifest = (tag: string, type: string) =>
      JSON.stringify(
        customElementsManifest({
          tagName: tag,
          members: [{kind: 'field', name: 'value', type: {text: type}}],
        }),
      );
    const packageJson = (file: string) =>
      JSON.stringify({
        name: '@test/stat-elements',
        exports: {'./custom-elements.json': `./${file}.json`},
      });
    const host = (env as unknown as {host: ts.server.ServerHost}).host;
    const origGetModifiedTime = host.getModifiedTime;
    const origGetFileSize = host.getFileSize;
    const fixedTime = new Date(1_700_000_000_000);
    host.getModifiedTime = () => fixedTime;
    host.getFileSize = (fileName) =>
      host.fileExists(fileName) ? (host.readFile(fileName)?.length ?? 0) : 0;

    try {
      const project = env.addProject(
        'test-cem-stat-fastpath',
        {
          'app.ts': `
            import {Component} from '@angular/core';
            @Component({templateUrl: './app.html'})
            export class AppComponent { value = 1; }
          `,
          'app.html': '<a-elem [value]="value"></a-elem><b-elem [value]="value"></b-elem>',
        },
        {
          strictTemplates: true,
          customElementsManifests: ['@test/stat-elements/custom-elements.json'],
        },
      );
      const fs = getFileSystem();
      fs.ensureDir(absoluteFrom(project.getAbsFileName('node_modules/@test/stat-elements')));
      const pkgPath = absoluteFrom(
        project.getAbsFileName('node_modules/@test/stat-elements/package.json'),
      );
      const aPath = absoluteFrom(project.getAbsFileName('node_modules/@test/stat-elements/a.json'));
      const bPath = absoluteFrom(project.getAbsFileName('node_modules/@test/stat-elements/b.json'));
      fs.writeFile(pkgPath, packageJson('a'));
      fs.writeFile(aPath, manifest('a-elem', 'number'));
      fs.writeFile(bPath, manifest('b-elem', 'number'));

      const initial = project.getDiagnosticsForFile('app.html');
      expect(
        initial.some(
          (diagnostic) =>
            typeof diagnostic.messageText === 'string' &&
            diagnostic.messageText.includes("'b-elem' is not a known element"),
        ),
      ).toBe(true);
      expect(
        initial.some(
          (diagnostic) =>
            typeof diagnostic.messageText === 'string' &&
            diagnostic.messageText.includes("'a-elem' is not a known element"),
        ),
      ).toBe(false);

      // Same-length, preserved-mtime redirect in package.json (`./a.json` -> `./b.json`) is picked
      // up once the TypeScript project version advances.
      fs.writeFile(pkgPath, packageJson('b'));
      const appFile = project.openFile('app.ts');
      appFile.contents = appFile.contents + '\n// bump project version 1';
      const afterRedirect = project.getDiagnosticsForFile('app.html');
      expect(
        afterRedirect.some(
          (diagnostic) =>
            typeof diagnostic.messageText === 'string' &&
            diagnostic.messageText.includes("'a-elem' is not a known element"),
        ),
      ).toBe(true);
      expect(
        afterRedirect.some(
          (diagnostic) =>
            typeof diagnostic.messageText === 'string' &&
            diagnostic.messageText.includes("'b-elem' is not a known element"),
        ),
      ).toBe(false);

      // Same-length, preserved-mtime edit in the active closed manifest (`number` -> `string`) is
      // also picked up once the project version advances.
      fs.writeFile(bPath, manifest('b-elem', 'string'));
      appFile.contents = appFile.contents + '\n// bump project version 2';
      const afterManifestEdit = project.getDiagnosticsForFile('app.html');
      expect(
        afterManifestEdit.some(
          (diagnostic) =>
            diagnostic.messageText === `Type 'number' is not assignable to type 'string'.`,
        ),
      ).toBe(true);
    } finally {
      host.getModifiedTime = origGetModifiedTime;
      host.getFileSize = origGetFileSize;
    }
  });

  it('should load a custom-element manifest larger than the TypeScript server file limit', () => {
    const manifest = (type: string) => ({
      ...customElementsManifest({
        tagName: 'large-meter',
        members: [
          {
            kind: 'field',
            name: 'value',
            description: 'The current meter value.',
            type: {text: type},
          },
        ],
      }),
      // TypeScript uses an empty ScriptInfo snapshot for non-TypeScript files over 4 MB.
      ignoredPadding: 'x'.repeat(4 * 1024 * 1024),
    });
    const project = env.addProject(
      'test-large-cem',
      {
        'app.ts': `
          import {Component} from '@angular/core';

          @Component({templateUrl: './app.html'})
          export class AppComponent { value = 1; }
        `,
        'app.html': `<large-meter [value]="value"></large-meter><large-meter ></large-meter>`,
      },
      {strictTemplates: true, customElementsManifests: ['./custom-elements.json']},
    );

    // Add the manifest after initialization to test loading a closed resource from a dependency.
    const fs = getFileSystem();
    const manifestPath = absoluteFrom(project.getAbsFileName('custom-elements.json'));
    fs.writeFile(manifestPath, JSON.stringify(manifest('number')));

    expect(project.getDiagnosticsForFile('app.html')).toEqual([]);

    const template = project.openFile('app.html');
    template.moveCursorToText('<large-meter ¦>');
    expect(
      template.getCompletionsAtPosition()?.entries.some((entry) => entry.name === '[value]'),
    ).toBe(true);
    template.moveCursorToText('[val¦ue]');
    const quickInfo = template.getQuickInfoAtPosition();
    expect(ts.displayPartsToString(quickInfo?.displayParts)).toBe('(property) value: number');
    expect(ts.displayPartsToString(quickInfo?.documentation)).toBe('The current meter value.');

    // number and string have equal length. The edit must invalidate the manifest despite its
    // unchanged size and empty TypeScript snapshot.
    fs.writeFile(manifestPath, JSON.stringify(manifest('string')));

    expect(
      project.getDiagnosticsForFile('app.html').map((diagnostic) => diagnostic.messageText),
    ).toEqual([`Type 'number' is not assignable to type 'string'.`]);

    fs.removeFile(manifestPath);
    env.notifyFileChange(manifestPath, ts.FileWatcherEventKind.Deleted);
    expect(
      project
        .getDiagnosticsForFile('app.html')
        .some((diagnostic) => diagnostic.code === ngErrorCode(ErrorCode.SCHEMA_INVALID_ELEMENT)),
    ).toBe(true);

    fs.writeFile(manifestPath, JSON.stringify(manifest('number')));
    env.notifyFileChange(manifestPath, ts.FileWatcherEventKind.Created);
    expect(project.getDiagnosticsForFile('app.html')).toEqual([]);
  });

  it('should resolve manifest type references through re-exported declarations when package is imported', () => {
    const manifest = customElementsManifest({
      tagName: 'button-box',
      name: 'Button',
      path: 'button.js',
      members: [
        {
          kind: 'field',
          name: 'variant',
          attribute: 'variant',
          type: {
            text: 'ButtonVariant',
            references: [{name: 'ButtonVariant', module: 'button.js', start: 0, end: 13}],
          },
        },
      ],
      attributes: [{name: 'variant', fieldName: 'variant'}],
      exports: [
        {kind: 'js', name: 'Button', declaration: {name: 'Button'}},
        {kind: 'custom-element-definition', name: 'button-box', declaration: {name: 'Button'}},
      ],
    });
    const project = env.addProject(
      'test-cem-transitive-types',
      {
        'node_modules/@test/elements/package.json': JSON.stringify({
          name: '@test/elements',
          customElements: './custom-elements.json',
          exports: {
            './package.json': './package.json',
            './button.js': {
              types: './button/index.d.ts',
              default: './button.js',
            },
          },
        }),
        'node_modules/@test/elements/custom-elements.json': JSON.stringify(manifest),
        'node_modules/@test/elements/button/index.d.ts': `export * from './button';`,
        'node_modules/@test/elements/button/button.d.ts': `
          export type ButtonVariant = 'primary' | 'secondary';
          export declare class Button extends HTMLElement {
            variant?: ButtonVariant;
          }
        `,
        'app.ts': `
          import {Component} from '@angular/core';
          import '@test/elements/button.js';

          @Component({templateUrl: './app.html'})
          export class AppComponent {}
        `,
        'app.html': `<button-box variant="invalid"></button-box>`,
      },
      {strictTemplates: true, customElementsManifests: ['@test/elements']},
    );

    expect(project.ngLS.getCompilerOptionsDiagnostics()).toEqual([]);
    expect(
      project.getDiagnosticsForFile('app.html').map((diagnostic) => diagnostic.messageText),
    ).toEqual([`Type '"invalid"' is not assignable to type 'ButtonVariant'.`]);
  });

  it('should not report external template diagnostics on the TS file', () => {
    const files = {
      'app.ts': `
        import {Component, NgModule} from '@angular/core';

        @Component({
          templateUrl: './app.html',
          standalone: false,
        })
        export class AppComponent {}
      `,
      'app.html': '{{nope}}',
    };

    const project = createModuleAndProjectWithDeclarations(env, 'test', files);
    const diags = project.getDiagnosticsForFile('app.ts');
    expect(diags).toEqual([]);
  });

  it('should report diagnostics in inline templates', () => {
    const files = {
      'app.ts': `
        import {Component, NgModule} from '@angular/core';

        @Component({
          template: '{{nope}}',
          standalone: false,
        })
        export class AppComponent {}
      `,
    };
    const project = createModuleAndProjectWithDeclarations(env, 'test', files);
    const diags = project.getDiagnosticsForFile('app.ts');
    expect(diags.length).toBe(1);
    const {category, file, messageText} = diags[0];
    expect(category).toBe(ts.DiagnosticCategory.Error);
    expect(file?.fileName).toBe(project.getAbsFileName('app.ts'));
    expect(messageText).toBe(`Property 'nope' does not exist on type 'AppComponent'.`);
  });

  it('should report member does not exist in external template', () => {
    const files = {
      'app.ts': `
      import {Component, NgModule} from '@angular/core';

      @Component({
        templateUrl: './app.html',
        standalone: false,
      })
      export class AppComponent {}
    `,
      'app.html': '{{nope}}',
    };

    const project = createModuleAndProjectWithDeclarations(env, 'test', files);
    const diags = project.getDiagnosticsForFile('app.html');
    expect(diags.length).toBe(1);
    const {category, file, messageText} = diags[0];
    expect(category).toBe(ts.DiagnosticCategory.Error);
    expect(file?.fileName).toBe(project.getAbsFileName('app.html'));
    expect(messageText).toBe(`Property 'nope' does not exist on type 'AppComponent'.`);
  });

  it('should report a parse error in external template', () => {
    const files = {
      'app.ts': `
      import {Component, NgModule} from '@angular/core';

      @Component({
        templateUrl: './app.html',
        standalone: false,
      })
      export class AppComponent {
        nope = false;
      }
    `,
      'app.html': '{{nope = true}}',
    };

    const project = createModuleAndProjectWithDeclarations(env, 'test', files);
    const diags = project.getDiagnosticsForFile('app.html');
    expect(diags.length).toBe(1);

    const {category, file, messageText} = diags[0];
    expect(category).toBe(ts.DiagnosticCategory.Error);
    expect(file?.fileName).toBe(project.getAbsFileName('app.html'));
    expect(messageText).toContain(
      `Parser Error: Bindings cannot contain assignments at column 8 in [nope = true]`,
    );
  });

  it('should report a parse error for an empty template literal interpolation', () => {
    const files = {
      'app.ts': `
      import {Component} from '@angular/core';

      @Component({
        template: '<p>{{ \`Hello, $\{\}!\` }}</p>',
      })
      export class AppComponent {}
    `,
    };

    const project = createModuleAndProjectWithDeclarations(env, 'test', files);
    const diags = project.getDiagnosticsForFile('app.ts');

    expect(
      diags.some((diag) =>
        ts
          .flattenDiagnosticMessageText(diag.messageText, '')
          .includes('Parser Error: Template literal interpolation cannot be empty'),
      ),
    ).toBe(true);
  });

  it('reports html parse errors along with typecheck errors as diagnostics', () => {
    const files = {
      'app.ts': `
      import {Component, NgModule} from '@angular/core';

      @Component({
        templateUrl: './app.html',
        standalone: false,
      })
      export class AppComponent {
        nope = false;
      }
    `,
      'app.html': '<dne',
    };

    const project = createModuleAndProjectWithDeclarations(env, 'test', files);
    const diags = project.getDiagnosticsForFile('app.html');
    expect(diags.length).toBe(2);

    expect(diags[0].category).toBe(ts.DiagnosticCategory.Error);
    expect(diags[0].file?.fileName).toBe(project.getAbsFileName('app.html'));
    expect(diags[0].messageText).toContain(`'dne' is not a known element`);

    expect(diags[1].category).toBe(ts.DiagnosticCategory.Error);
    expect(diags[1].file?.fileName).toBe(project.getAbsFileName('app.html'));
    expect(diags[1].messageText).toContain(`Opening tag "dne" not terminated.`);
  });

  it('should report parse errors of components defined in the same ts file', () => {
    const files = {
      'app.ts': `
      import {Component, NgModule} from '@angular/core';

      @Component({
        templateUrl: './app1.html',
        standalone: false,
      })
      export class AppComponent1 { nope = false; }

      @Component({
        templateUrl: './app2.html',
        standalone: false,
      })
      export class AppComponent2 { nope = false; }
    `,
      'app1.html': '{{nope = false}}',
      'app2.html': '{{nope = true}}',
      'app-module.ts': `
        import {NgModule} from '@angular/core';
        import {CommonModule} from '@angular/common';
        import {AppComponent, AppComponent2} from './app';

        @NgModule({
          declarations: [AppComponent, AppComponent2],
          imports: [CommonModule],
        })
        export class AppModule {}
    `,
    };

    const project = env.addProject('test', files);
    const diags1 = project.getDiagnosticsForFile('app1.html');
    expect(diags1.length).toBe(1);
    expect(diags1[0].messageText).toBe(
      `Parser Error: Bindings cannot contain assignments at column 8 in [nope = false] in ${project.getAbsFileName(
        'app1.html',
      )}@0:0`,
    );

    const diags2 = project.getDiagnosticsForFile('app2.html');
    expect(diags2.length).toBe(1);
    expect(diags2[0].messageText).toBe(
      `Parser Error: Bindings cannot contain assignments at column 8 in [nope = true] in ${project.getAbsFileName(
        'app2.html',
      )}@0:0`,
    );
  });

  it('reports a diagnostic for a component without a template', () => {
    const files = {
      'app.ts': `
      import {Component} from '@angular/core';
      @Component({
        standalone: false,
      })
      export class MyComponent {}
    `,
    };

    const project = createModuleAndProjectWithDeclarations(env, 'test', files);
    const diags = project.getDiagnosticsForFile('app.ts');
    expect(diags.map((x) => x.messageText)).toEqual([
      '@Component is missing a template. Add either a `template` or `templateUrl`',
    ]);
  });

  it('should process a component that would otherwise require an inline TCB', () => {
    const files = {
      'app.ts': `
        import {Component, NgModule} from '@angular/core';
        import {CommonModule} from '@angular/common';

        interface PrivateInterface {}

        @Component({
          template: 'Simple template',
          standalone: false,
        })
        export class MyComponent<T extends PrivateInterface> {}
      `,
    };

    const project = createModuleAndProjectWithDeclarations(env, 'test', files);
    const diags = project.getDiagnosticsForFile('app.ts');
    expect(diags.length).toBe(0);
  });

  it('should exclude unused pipes that would otherwise require an inline TCB', () => {
    const files = {
      // Declare an external package that exports `MyPipeModule` without also exporting `MyPipe`
      // from its public API. This means that `MyPipe` cannot be imported using the package name
      // as module specifier.
      'node_modules/pipe/pipe.d.ts': `
        import {ɵɵDirectiveDeclaration} from '@angular/core';

        export declare class MyPipe {
          static ɵpipe: ɵɵPipeDeclaration<MyPipe, "myPipe", false>;
        }
      `,
      'node_modules/pipe/index.d.ts': `
        import {ɵɵNgModuleDeclaration} from '@angular/core';
        import {MyPipe} from './pipe';

        export declare class MyPipeModule {
          static ɵmod: ɵɵNgModuleDeclaration<MyPipeModule, [typeof MyPipe], never, [typeof MyPipe]>;
        }
      `,
      'app.ts': `
        import {Component, NgModule} from '@angular/core';
        import {MyPipeModule} from 'pipe';

        @Component({
          template: 'Simple template that does not use "myPipe"',
          standalone: false,
        })
        export class MyComponent {}

        @NgModule({
          declarations: [MyComponent],
          imports: [MyPipeModule],
        })
        export class MyModule {}
      `,
    };

    const project = env.addProject('test', files);
    const diags = project.getDiagnosticsForFile('app.ts');
    expect(diags.length).toBe(0);
  });

  it('logs perf tracing', () => {
    const files = {
      'app.ts': `
        import {Component} from '@angular/core';
        @Component({
          template: '',
          standalone: false,
        })
        export class MyComponent {}
      `,
    };

    const project = createModuleAndProjectWithDeclarations(env, 'test', files);

    const logger = project.getLogger();
    spyOn(logger, 'hasLevel').and.returnValue(true);
    spyOn(logger, 'perftrc').and.callFake(() => {});

    const diags = project.getDiagnosticsForFile('app.ts');
    expect(diags.length).toEqual(0);
    expect(logger.perftrc).toHaveBeenCalledWith(
      jasmine.stringMatching(/LanguageService\#LsDiagnostics\:.*\"LsDiagnostics\":\s*\d+.*/g),
    );
  });

  it('does not produce diagnostics when pre-compiled file is found', () => {
    const files = {
      'app.ts': `
        import {Component} from '@angular/core';

        @Component({
          template: '',
          styleUrls: ['./one.css', './two/two.css', './three.css', './four.css'],
          standalone: false,
        })
        export class MyComponent {}
      `,
      'one.scss': '',
      'two/two.sass': '',
      'three.less': '',
      'four.styl': '',
    };

    const project = createModuleAndProjectWithDeclarations(env, 'test', files);
    const diags = project.getDiagnosticsForFile('app.ts');
    expect(diags.length).toBe(0);
  });

  it('produces missing resource diagnostic for missing css', () => {
    const files = {
      'app.ts': `
        import {Component} from '@angular/core';

        @Component({
          template: '',
          styleUrls: ['./missing.css'],
          standalone: false,
        })
        export class MyComponent {}
      `,
    };

    const project = createModuleAndProjectWithDeclarations(env, 'test', files);
    const diags = project.getDiagnosticsForFile('app.ts');
    expect(diags.length).toBe(1);
    const diag = diags[0];
    expect(diag.code).toBe(ngErrorCode(ErrorCode.COMPONENT_RESOURCE_NOT_FOUND));
    expect(diag.category).toBe(ts.DiagnosticCategory.Error);
    expect(getTextOfDiagnostic(diag)).toBe(`'./missing.css'`);
  });

  it('should produce invalid banana in box warning', () => {
    const files = {
      'app.ts': `
        import {Component} from '@angular/core';
        @Component({
          selector: 'test',
          template: '<div ([notARealThing])="bar"></div>',
          standalone: false,
        })
        export class TestCmp {
          bar: string = "text";
        }
    `,
    };
    const project = createModuleAndProjectWithDeclarations(env, 'test', files, {
      strictTemplates: true,
    });

    const diags = project.getDiagnosticsForFile('app.ts');
    expect(diags.length).toEqual(1);
    expect(diags[0].code).toEqual(ngErrorCode(ErrorCode.INVALID_BANANA_IN_BOX));
    expect(diags[0].category).toEqual(ts.DiagnosticCategory.Warning);
  });

  it('should not produce invalid banana in box warning without `strictTemplates`', () => {
    const files = {
      'app.ts': `
        import {Component} from '@angular/core';
        @Component({
          selector: 'test',
          template: '<div ([notARealThing])="bar"></div>',
          standalone: false,
        })
        export class TestCmp {
          bar: string = "text";
        }
    `,
    };
    const project = createModuleAndProjectWithDeclarations(env, 'test', files, {
      strictTemplates: false,
    });

    const diags = project.getDiagnosticsForFile('app.ts');
    expect(diags.length).toEqual(0);
  });

  it('should produce invalid banana in box warning in external html file', () => {
    const files = {
      'app.ts': `
        import {Component} from '@angular/core';
        @Component({
          selector: 'test',
          templateUrl: './app.html',
          standalone: false,
        })
        export class TestCmp {
          bar: string = "text";
        }
    `,
      'app.html': `<div ([foo])="bar"></div>`,
    };
    const project = createModuleAndProjectWithDeclarations(env, 'test', files, {
      strictTemplates: true,
    });

    const diags = project.getDiagnosticsForFile('app.html');
    expect(diags.length).toEqual(1);
    expect(diags[0].code).toEqual(ngErrorCode(ErrorCode.INVALID_BANANA_IN_BOX));
    expect(diags[0].category).toEqual(ts.DiagnosticCategory.Warning);
  });

  it('should not produce invalid banana in box warning in external html file without `strictTemplates`', () => {
    const files = {
      'app.ts': `
        import {Component} from '@angular/core';
        @Component({
          selector: 'test',
          templateUrl: './app.html',
          standalone: false,
        })
        export class TestCmp {
          bar: string = "text";
        }
    `,
      'app.html': `<div ([foo])="bar"></div>`,
    };
    const project = createModuleAndProjectWithDeclarations(env, 'test', files, {
      strictTemplates: false,
    });

    const diags = project.getDiagnosticsForFile('app.html');
    expect(diags.length).toEqual(0);
  });

  it('generates diagnostic when the library does not export the host directive', () => {
    const files = {
      // export post module and component but not the host directive. This is not valid. We won't
      // be able to import the host directive for template type checking.
      'dist/post/index.d.ts': `
      export { PostComponent, PostModule } from './lib/post.component';
    `,
      'dist/post/lib/post.component.d.ts': `
      import * as i0 from "@angular/core";
      export declare class HostBindDirective {
          static ɵdir: i0.ɵɵDirectiveDeclaration<HostBindDirective, never, never, {}, {}, never, never, true, never>;
      }
      export declare class PostComponent {
          static ɵcmp: i0.ɵɵComponentDeclaration<PostComponent, "lib-post", never, {}, {}, never, never, false, [{ directive: typeof HostBindDirective; inputs: {}; outputs: {}; }]>;
      }
      export declare class PostModule {
          static ɵmod: i0.ɵɵNgModuleDeclaration<PostModule, [typeof PostComponent], never, [typeof PostComponent]>;
          static ɵinj: i0.ɵɵInjectorDeclaration<PostModule>;
      }
      `,
      'test.ts': `
      import {Component} from '@angular/core';
      import {PostModule} from 'post';

      @Component({
        templateUrl: './test.ng.html',
        imports: [PostModule],
      })
      export class Main { }
       `,
      'test.ng.html': '<lib-post />',
    };

    const tsCompilerOptions = {paths: {'post': ['dist/post']}};
    const project = env.addProject('test', files, {}, tsCompilerOptions);

    const diags = project.getDiagnosticsForFile('test.ng.html');
    expect(diags.length).toBe(1);
    expect(ts.flattenDiagnosticMessageText(diags[0].messageText, '')).toContain(
      'HostBindDirective',
    );
  });

  it('should type check templates using a non-exported directive from the same file', () => {
    const files = {
      'app.ts': `
        import {Component, Directive, input, signal} from '@angular/core';

        @Directive({selector: 'img[appHelper]'})
        class HelperDirective {
          readonly appHelper = input.required<string>();
        }

        @Component({
          selector: 'app-some',
          imports: [HelperDirective],
          templateUrl: './app.html',
        })
        export class SomeComponent {
          protected readonly open = signal(true);
          protected readonly items = signal([{id: 1, src: '/photo.jpg'}]);
        }
      `,
      'app.html': `
        @if (open()) {
          @for (item of items(); track item.id) {
            <img [appHelper]="item.src" alt="" />
          }
        }
      `,
    };

    const project = env.addProject('test', files, {strictTemplates: true});
    expect(project.getDiagnosticsForFile('app.html')).toEqual([]);
    expect(project.getDiagnosticsForFile('app.ts')).toEqual([]);
  });

  it('should report template errors involving a non-exported directive from the same file', () => {
    const files = {
      'app.ts': `
        import {Component, Directive, input} from '@angular/core';

        @Directive({selector: '[appHelper]'})
        class HelperDirective {
          readonly appHelper = input.required<string>();
        }

        @Component({
          imports: [HelperDirective],
          templateUrl: './app.html',
        })
        export class SomeComponent {}
      `,
      'app.html': `<div [appHelper]="1"></div>`,
    };

    const project = env.addProject('test', files, {strictTemplates: true});
    const diags = project.getDiagnosticsForFile('app.html');
    expect(diags.length).toBe(1);
    expect(ts.flattenDiagnosticMessageText(diags[0].messageText, '')).toContain(
      `Type 'number' is not assignable to type 'string'`,
    );
  });
});

describe('getSuggestedDiagnostics', () => {
  let env: LanguageServiceTestEnv;
  beforeEach(() => {
    env = LanguageServiceTestEnv.setup();
  });

  it('should report deprecated for primitive type variable', () => {
    const files = {
      'app.ts': `
      import {Component} from '@angular/core';

      @Component({
        template: '<div>{{name}}</div>',
        standalone: false,
      })
      export class AppComponent {
        /**
         * @deprecated
         *
         * Used to test to get the symbol of the type "string", using the
         * "type.getSymbol()" to check if the symbol is "undefined".
         */
        name = 'test';
      }
    `,
    };
    const project = createModuleAndProjectWithDeclarations(env, 'test', files);

    const diags = project.getSuggestionDiagnosticsForFile('app.ts');
    expect(diags.length).toBe(1);
    const {category, file, messageText} = diags[0];
    expect(category).toBe(ts.DiagnosticCategory.Suggestion);
    expect(file?.fileName).toBe(project.getAbsFileName('app.ts'));
    expect(messageText).toBe(`'name' is deprecated.`);
  });

  it('should report deprecated for component variable', () => {
    const files = {
      'app.ts': `
      import {Component} from '@angular/core';

      @Component({
        template: '<app-bar name=""></app-bar>',
        standalone: false,
      })
      export class AppComponent {}
    `,
      'bar.ts': `
      import {Component, input} from '@angular/core';
      @Component({
        selector: 'app-bar',
        template: '',
        standalone: false,
      })
      export class BarComponent {
        /**
         * @deprecated
         */
        name = input<string>();
      }
    `,
    };
    const project = createModuleAndProjectWithDeclarations(env, 'test', files);

    const diags = project.getSuggestionDiagnosticsForFile('app.ts');
    expect(diags.length).toBe(1);
    const {category, file, messageText} = diags[0];
    expect(category).toBe(ts.DiagnosticCategory.Suggestion);
    expect(file?.fileName).toBe(project.getAbsFileName('app.ts'));
    expect(messageText).toBe(`'name' is deprecated.`);
  });

  it('should report deprecated for component tag without generics', () => {
    const files = {
      'app.ts': `
      import {Component} from '@angular/core';

      @Component({
        template: '<app-bar name=""></app-bar>',
        standalone: false,
      })
      export class AppComponent {}
    `,
      'bar.ts': `
      import {Component, input} from '@angular/core';
      /**
       * @deprecated
      */
      @Component({
        selector: 'app-bar',
        template: '',
        standalone: false,
      })
      export class BarComponent {
        name = input<string>();
      }
    `,
    };
    const project = createModuleAndProjectWithDeclarations(env, 'test', files);

    const diags = project.getSuggestionDiagnosticsForFile('app.ts');
    expect(diags.length).toBe(1);
    const {category, file, messageText, start} = diags[0];
    expect(category).toBe(ts.DiagnosticCategory.Suggestion);
    expect(file?.fileName).toBe(project.getAbsFileName('app.ts'));
    expect(start).toBe(87);
    expect(messageText).toBe(`'BarComponent' is deprecated.`);
  });

  it('should report deprecated for component tag with generics', () => {
    const files = {
      'app.ts': `
      import {Component} from '@angular/core';

      @Component({
        template: '<app-bar name=""></app-bar>',
        standalone: false,
      })
      export class AppComponent {}
    `,
      'bar.ts': `
      import {Component, input} from '@angular/core';
      /**
       * @deprecated
      */
      @Component({
        selector: 'app-bar',
        template: '',
        standalone: false,
      })
      export class BarComponent<T> {
        name = input<string>();
      }
    `,
    };
    const project = createModuleAndProjectWithDeclarations(env, 'test', files);

    const diags = project.getSuggestionDiagnosticsForFile('app.ts');
    expect(diags.length).toBe(1);
    const {category, file, messageText, start} = diags[0];
    expect(category).toBe(ts.DiagnosticCategory.Suggestion);
    expect(file?.fileName).toBe(project.getAbsFileName('app.ts'));
    expect(start).toBe(87);
    expect(messageText).toBe(`'BarComponent' is deprecated.`);
  });

  it('should not report deprecated for directive attribute', () => {
    const files = {
      'app.ts': `
      import {Component} from '@angular/core';

      @Component({
        template: '<div my-directive></div>',
        standalone: false,
      })
      export class AppComponent {}
    `,
      'bar.ts': `
      import {Directive, input} from '@angular/core';
      /**
       * @deprecated deprecated
       */
      @Directive({
        selector: '[my-directive]',
        standalone: false,
      })
      export class MyDirective {}
    `,
    };
    const project = createModuleAndProjectWithDeclarations(env, 'test', files);

    const diags = project.getSuggestionDiagnosticsForFile('app.ts');
    expect(diags.length).toBe(0);
  });

  it('should not report deprecated for directive context guard', () => {
    const files = {
      'app.ts': `
      import {Component} from '@angular/core';

      @Component({
        template: \`
        <div *my-directive>
          <span>Test</span>
          <span>Test</span>
          <span>Test</span>
        </div>
        \`,
        standalone: false,
      })
      export class AppComponent {}
    `,
      'bar.ts': `
      import {Directive, input} from '@angular/core';
      /**
       * @deprecated deprecated
       */
      @Directive({
        selector: '[my-directive]',
        standalone: false,
      })
      export class MyDirective {
        static ngTemplateContextGuard(dir: MyDirective, ctx: any): true {
          return true;
        }
      }
    `,
    };
    const project = createModuleAndProjectWithDeclarations(env, 'test', files);

    const diags = project.getSuggestionDiagnosticsForFile('app.ts');
    expect(diags.length).toBe(0);
  });

  it('should refresh template diagnostics when a local Custom Elements Manifest changes on disk', () => {
    const manifestJson = (propType: string) =>
      JSON.stringify({
        schemaVersion: '2.1.0',
        modules: [
          {
            kind: 'javascript-module',
            path: 'ls-el.js',
            declarations: [
              {
                kind: 'class',
                name: 'LsEl',
                customElement: true,
                tagName: 'ls-el',
                members: [{kind: 'field', name: 'value', type: {text: propType}}],
              },
            ],
          },
        ],
      });
    const project = env.addProject(
      'cem-ls',
      {
        'app.ts': `
          import {Component} from '@angular/core';

          @Component({
            template: '<ls-el [value]="val"></ls-el>',
          })
          export class AppComponent {
            val = 'ok';
          }
        `,
      },
      {customElementsManifests: ['./custom-elements.json']},
    );

    // Write the manifest on disk after project init so it is closed (not an open editor buffer).
    const manifestPath = absoluteFrom(project.getAbsFileName('custom-elements.json'));
    getFileSystem().writeFile(manifestPath, manifestJson('string'));

    expect(project.getDiagnosticsForFile('app.ts')).toEqual([]);

    // Edit the closed manifest on disk without touching `app.ts` and verify LS picks up the change.
    getFileSystem().writeFile(manifestPath, manifestJson('number'));
    const updatedDiags = project.getDiagnosticsForFile('app.ts');
    expect(updatedDiags.length).toBe(1);
    expect(ts.flattenDiagnosticMessageText(updatedDiags[0].messageText, ' ')).toContain(
      "Type 'string' is not assignable to type 'number'",
    );
  });

  it('should drop CEM shim imports in Language Service after the last user TS import is removed', () => {
    const project = env.addProject(
      'cem-ls-gate',
      {
        'node_modules/@pkg/lsleak/package.json': JSON.stringify({
          name: '@pkg/lsleak',
          customElements: 'custom-elements.json',
        }),
        'node_modules/@pkg/lsleak/custom-elements.json': JSON.stringify({
          schemaVersion: '2.1.0',
          modules: [
            {
              kind: 'javascript-module',
              path: 'el.js',
              declarations: [
                {
                  kind: 'class',
                  name: 'LsLeakEl',
                  customElement: true,
                  tagName: 'ls-leak-el',
                  members: [{kind: 'field', name: 'count', type: {text: 'number'}}],
                },
              ],
              exports: [
                {
                  kind: 'custom-element-definition',
                  name: 'ls-leak-el',
                  declaration: {name: 'LsLeakEl'},
                },
                {kind: 'js', name: 'LsLeakEl', declaration: {name: 'LsLeakEl'}},
              ],
            },
          ],
        }),
        'node_modules/@pkg/lsleak/el.d.ts': `
          declare global {
            interface Window {
              __lsCemLeak: number;
            }
          }
          export declare class LsLeakEl extends HTMLElement {
            count: number;
            extra: boolean;
          }
        `,
        'main.ts': `export const ready = true;`,
        'app.ts': `
          import {Component} from '@angular/core';
          @Component({
            template: '<ls-leak-el [count]="1" [extra]="\\'wrong\\'"></ls-leak-el>',
          })
          export class AppComponent {}
        `,
        'unrelated.ts': `
          import {Component} from '@angular/core';
          export const tsLeak: number = window.__lsCemLeak;
          @Component({template: '{{ win.__lsCemLeak }}'})
          export class UnrelatedComponent {
            win = window;
          }
        `,
      },
      {customElementsManifests: ['@pkg/lsleak']},
    );

    // Step 1: Absent -> `el.d.ts` is not loaded; gated `[extra]` stays lenient without false
    // errors and `unrelated.ts` reports TS2339 on `window.__lsCemLeak` in both TS and template.
    expect(project.getDiagnosticsForFile('app.ts')).toEqual([]);
    const unrelatedStep1 = project.getDiagnosticsForFile('unrelated.ts');
    expect(unrelatedStep1.length).toBe(2);
    expect(unrelatedStep1.every((d) => d.code === 2339)).toBeTrue();

    // Step 2: Add import in `main.ts` without editing `app.ts` -> `app.ts` upgrades to class-backed
    // TS2322 on `[extra]="'wrong'"` and `unrelated.ts` clears.
    const mainBuf = project.openFile('main.ts');
    mainBuf.contents = `import '@pkg/lsleak/el.js';\nexport const ready = true;`;
    expect(project.getDiagnosticsForFile('app.ts').map((d) => d.code)).toEqual([2322]);
    expect(project.getDiagnosticsForFile('unrelated.ts')).toEqual([]);

    // Step 3: Remove import from `main.ts` without editing `app.ts` -> LS `.ngtypecheck.ts` root
    // must NOT keep `el.d.ts` alive; `app.ts` drops back to gated manifest-only and
    // `window.__lsCemLeak` reports TS2339 again in both TS and template.
    mainBuf.contents = `export const ready = true;`;
    expect(project.getDiagnosticsForFile('app.ts')).toEqual([]);
    const unrelatedStep3 = project.getDiagnosticsForFile('unrelated.ts');
    expect(unrelatedStep3.length).toBe(2);
    expect(unrelatedStep3.every((d) => d.code === 2339)).toBeTrue();
  });
});

function getTextOfDiagnostic(diag: ts.Diagnostic): string {
  expect(diag.file).not.toBeUndefined();
  expect(diag.start).not.toBeUndefined();
  expect(diag.length).not.toBeUndefined();
  return diag.file!.text.substring(diag.start!, diag.start! + diag.length!);
}
