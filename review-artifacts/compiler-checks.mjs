// Checks configuration variants without changing tsconfig or manifest files on disk.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import ts from 'typescript';
import { createCompilerHost, performCompilation, readConfiguration } from './compiler-cli.mjs';

const config = readConfiguration('tsconfig.app.json');
assert.deepEqual(config.errors, []);
const material = './src/custom-elements/material-web-button.custom-elements.json';
let failures = 0;

function compile(overrides = {}, files = {}) {
  const options = { ...config.options, noEmit: true, ...overrides };
  const host = createCompilerHost({ options });
  const readFile = host.readFile.bind(host);
  const overridesByPath = new Map(
    Object.entries(files).map(([name, text]) => [path.resolve(name), text]),
  );
  host.readFile = (name) => overridesByPath.get(path.resolve(name)) ?? readFile(name);
  return performCompilation({ rootNames: config.rootNames, options, host }).diagnostics;
}

function counts(diagnostics) {
  const result = {};
  for (const diagnostic of diagnostics) {
    const code = diagnostic.code < 0 ? `NG${-diagnostic.code - 990000}` : `TS${diagnostic.code}`;
    result[code] = (result[code] ?? 0) + 1;
  }
  return result;
}

function expectNoErrors(diagnostics) {
  const errors = diagnostics.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(
    errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    [],
  );
}

function expectCode(diagnostics, code) {
  assert(counts(diagnostics)[code], `Missing ${code}: ${JSON.stringify(counts(diagnostics))}`);
}

function test(name, action) {
  try {
    const result = action();
    console.log(`PASS ${name}: ${JSON.stringify(counts(result))}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

test('configured manifests', () => {
  const result = compile();
  expectNoErrors(result);
  return result;
});

test('verbose diagnostics', () => {
  const result = compile({ customElementsManifestsDiagnostics: 'verbose' });
  expectNoErrors(result);
  return result;
});

test('full Lion manifest', () => {
  const result = compile({
    customElementsManifests: config.options.customElementsManifests.map((entry) =>
      entry.includes('lion-button.custom-elements.json')
        ? './node_modules/@lion/ui/custom-elements.json'
        : entry,
    ),
  });
  expectNoErrors(result);
  return result;
});

test('missing manifest', () => {
  const result = compile({
    customElementsManifests: [
      ...config.options.customElementsManifests,
      './missing-review-manifest.json',
    ],
  });
  expectCode(result, 'NG4007');
  return result;
});

test('malformed manifest', () => {
  const result = compile({}, { [material]: '{' });
  expectCode(result, 'NG4008');
  return result;
});

test('invalid diagnostics option', () => {
  const result = compile({ customElementsManifestsDiagnostics: 'loud' });
  expectCode(result, 'NG4012');
  return result;
});

test('removing Material metadata rejects its tag', () => {
  const result = compile({
    customElementsManifests: config.options.customElementsManifests.filter(
      (entry) => entry !== material,
    ),
  });
  expectCode(result, 'NG8001');
  return result;
});

test('vendor Spectrum metadata omits disabled', () => {
  const result = compile({
    customElementsManifests: config.options.customElementsManifests.map((entry) =>
      entry.includes('spectrum-button.corrected') ? '@spectrum-web-components/button' : entry,
    ),
  });
  expectCode(result, 'NG4013');
  expectCode(result, 'NG8002');
  return result;
});

test('vendor Spectrum variant uses existence-only checking', () => {
  const html = 'src/app/integrations/design-systems/design-systems-page.html';
  const text = fs
    .readFileSync(html, 'utf8')
    .replace('[variant]="spectrumVariant()"', 'variant="not-real"')
    .replace('[pending]="false"\n            [disabled]="controlsDisabled()"', '[pending]="false"');
  const result = compile(
    {
      customElementsManifests: config.options.customElementsManifests.map((entry) =>
        entry.includes('spectrum-button.corrected') ? '@spectrum-web-components/button' : entry,
      ),
    },
    { [html]: text },
  );
  expectCode(result, 'NG4013');
  expectNoErrors(result);
  return result;
});

process.exitCode = failures ? 1 : 0;
