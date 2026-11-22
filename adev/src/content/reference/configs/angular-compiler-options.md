# Angular compiler options

When you use [ahead-of-time compilation (AOT)](tools/cli/aot-compiler), you can control how your application is compiled by specifying Angular compiler options in the [TypeScript configuration file](https://www.typescriptlang.org/docs/handbook/tsconfig-json.html).

The Angular options object, `angularCompilerOptions`, is a sibling to the `compilerOptions` object that supplies standard options to the TypeScript compiler.

<docs-code header="tsconfig.json" path="adev/src/content/examples/angular-compiler-options/tsconfig.json" region="angular-compiler-options"/>

## Configuration inheritance with `extends`

Like the TypeScript compiler, the Angular AOT compiler also supports `extends` in the `angularCompilerOptions` section of the TypeScript configuration file.
The `extends` property is at the top level, parallel to `compilerOptions` and `angularCompilerOptions`.

A TypeScript configuration can inherit settings from another file using the `extends` property.
The configuration options from the base file are loaded first, then overridden by those in the inheriting configuration file.

For example:

<docs-code header="tsconfig.app.json" path="adev/src/content/examples/angular-compiler-options/tsconfig.app.json" region="angular-compiler-options-app"/>

For more information, see the [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/tsconfig-json.html).

## Template options

The following options are available for configuring the Angular AOT compiler.

### `annotationsAs`

Modifies how Angular-specific annotations are emitted to improve tree-shaking.
Non-Angular annotations are not affected.
One of `static fields` or `decorators`. The default value is `static fields`.

- By default, the compiler replaces decorators with a static field in the class, which allows advanced tree-shakers like [Closure compiler](https://github.com/google/closure-compiler) to remove unused classes
- The `decorators` value leaves the decorators in place, which makes compilation faster.
  TypeScript emits calls to the `__decorate` helper.
  Use `--emitDecoratorMetadata` for runtime reflection.

  HELPFUL: That the resulting code cannot tree-shake properly.

### `annotateForClosureCompiler`

<!-- vale Angular.Angular_Spelling = NO -->

When `true`, use [Tsickle](https://github.com/angular/tsickle) to annotate the emitted JavaScript with [JSDoc](https://jsdoc.app) comments needed by the [Closure Compiler](https://github.com/google/closure-compiler).
Default is `false`.

<!-- vale Angular.Angular_Spelling = YES -->

### `compilationMode`

Specifies the compilation mode to use.
The following modes are available:

| Modes       | Details                                                                                                                                                      |
| :---------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'full'`    | Generates fully AOT-compiled code. The compiler ABI (the internal runtime APIs used by this code) is stable across patch versions of the same minor version. |
| `'partial'` | Generates code in a stable, but intermediate form suitable for independently published libraries.                                                            |

The default value is `'full'`.

For most applications, `'full'` is the correct compilation mode.

Use `'partial'` for independently published libraries, such as NPM packages.
`'partial'` compilations output a stable, intermediate format which better supports usage by applications built at different major or minor Angular versions from the library.
Libraries built at "HEAD" alongside their applications and using the same version of Angular such as in a mono-repository can use `'full'` since there is no risk of version skew across minor versions. Note that the compiler ABI is stable across patch versions of the same minor, allowing for safe sharing of the Angular runtime in microfrontend architectures where different applications might be on different patch levels.

### `customElementsManifests`

A list of [Custom Elements Manifest](https://github.com/webcomponents/custom-elements-manifest) (CEM) files, such as `custom-elements.json`, that describe the custom elements used in templates.
Angular uses them to check custom element tags, properties, attributes, events, and local references.
The Angular Language Service uses them for completions and hover information.

Use manifests to type-check the custom elements they declare, which `CUSTOM_ELEMENTS_SCHEMA` cannot do: that schema allows every tag containing a dash and any property binding on it.

```json
{
  "angularCompilerOptions": {
    "strictTemplates": true,
    "customElementsManifests": ["@my/elements", "./custom-elements.json"]
  }
}
```

#### Manifest entries

Each entry must be a non-empty string in one of the following forms:

| Entry                            | Details                                                                                |
| :------------------------------- | :------------------------------------------------------------------------------------- |
| `'./custom-elements.json'`       | A file path relative to the project's `tsconfig.json`, or an absolute file path.       |
| `'@my/lib/custom-elements.json'` | A `.json` module specifier resolved with the project's module resolution.              |
| `'@my/lib'`                      | A package whose `package.json` has a `customElements` field that points to a manifest. |

As with the `extends` field of `tsconfig.json`, only entries that start with `./`, `../`, or an absolute path are treated as file paths.
Angular resolves any other entry as a module specifier, so write `./custom-elements.json`, not `custom-elements.json`.
If a `.json` module specifier does not resolve and a file exists at that path relative to your project, the `NG4007` error suggests the `./` form.

Relative paths resolve against the directory of the `tsconfig.json` being compiled, including entries inherited through `extends`.
Angular does not rebase inherited `angularCompilerOptions` paths, and the `NG4007` error names the directory it used.

If a package's `package.json` has no `customElements` field, the `NG4007` error suggests configuring the manifest file specifier directly, such as `'@my/lib/custom-elements.json'`.

Angular supports manifest `schemaVersion` 1.x and 2.x.
It reads only the records needed for templates rather than validating the entire file against the CEM JSON schema.
For an app-owned manifest, an unrecognized `schemaVersion` produces an `NG4009` warning, and Angular still reads the records it recognizes.

#### What Angular checks

For each custom element that a configured manifest declares:

- The tag is a known element, so it does not produce `NG8001`.
- Declared writable properties and standard `HTMLElement` properties are known.
  Fields declared `readonly`, `private`, `protected`, or `static` in the manifest cannot be bound and produce `NG8002`, unless [`CUSTOM_ELEMENTS_SCHEMA`](#using-manifests-with-customelementsschema) is present.
- In strict mode—and for top-level template bindings in basic mode—property bindings not listed in the manifest are checked against the [element class](#element-class) (or `_CemUnresolvedElement<Tag>` when no class resolves), reporting TypeScript errors such as `TS2339`, `TS2551`, or `TS2540` (for example, `Property 'x' does not exist on type '_CemUnresolvedElement<"my-element">'`).
  In basic mode, bindings inside control-flow bodies (such as `@if` or `@for`) and embedded views (such as `*ngIf`) are not checked—except when `annotateForClosureCompiler` is enabled, in which case embedded views receive manifest-only schema checks (`NG8002`) without resolving class members.
  Read-only enforcement on checked bindings applies regardless of `strictInputAccessModifiers`.
  When `CUSTOM_ELEMENTS_SCHEMA` is present—or when a package manifest's class import is gated out and `HTMLElementTagNameMap` does not declare the tag—undeclared properties are allowed rather than reported as errors.
- A declared attribute does not create a property. Set it as a static attribute or with `[attr.name]`.

With [strict template type checking](tools/cli/template-typecheck#strict-mode), Angular checks types using the existing strictness flags enabled by `strictTemplates`:

| Flag                     | What Angular checks                                                                                                     |
| :----------------------- | :---------------------------------------------------------------------------------------------------------------------- |
| `strictInputTypes`       | Property binding values, such as `[count]="value"`, against the property type.                                          |
| `strictAttributeTypes`   | Static attribute values, only when the attribute type is a union of string literals such as `'primary' \| 'secondary'`. |
| `strictDomEventTypes`    | The type of `$event`, from the event's declared `type` or element event inference.                                      |
| `strictDomLocalRefTypes` | Local references, such as `#ref`, typed as the element's class. See [Local references](#local-references).              |

Angular checks a property binding value when the manifest provides a [supported type](#supported-types) or when the [element class](#element-class) declares the property.
Otherwise, the binding still checks property existence (when not gated out), `$event` falls back to native DOM event inference, and static attribute values are not checked.

Static attributes are always strings.
Because CEM does not define how attribute strings convert to numbers or booleans, Angular does not check static number or boolean attributes.
To check a number or boolean, bind the property instead, such as `[precision]="value"`.
Interpolation also produces a string, so `precision="{{ value }}"` reports an error when `precision` expects a `number`.
Values bound with `[attr.name]` are not checked against the manifest because `null` removes the attribute and other values become strings.

For events:

- If a manifest event has a supported event type (such as `CustomEvent<...>` or `MouseEvent`) and shares a name with a native event such as `click`, the manifest's type applies on that element.
- An Angular directive output with the same name takes precedence over the manifest.
- Targeted events, such as `(window:click)`, keep their native types.
- If the manifest event has no supported event type (including primitive placeholders such as `void` or `boolean`), `$event` falls back to TypeScript's `addEventListener` inference on the element (or `Event` for unknown event names, where accessing `$event.detail` produces `TS2339`).
- For `CustomEvent<Detail>`, if `Detail` requires a package module import that is not reachable in your TypeScript program—or is skipped because the build tool provides its own module resolution (such as Angular CLI projects that use `fileReplacements`)—`$event.detail` becomes `any` (standard global types and `package: "global:"` references still resolve via `globalThis`).
  If the referenced module is reachable in your program but does not export `Detail`, `$event.detail` becomes `unknown`, so accessing properties on `$event.detail` or passing it to a typed parameter reports a TypeScript error (fix or override the manifest, or cast with `$any($event).detail`).
- With [`strictUnclaimedEventNames`](tools/cli/template-typecheck#troubleshooting-template-errors), Angular does not report events that a manifest declares, matched by exact name.

A two-way binding such as `[(count)]` checks the bound value against the `count` property.
Its `$event` uses the manifest type only when the manifest declares a `countChange` event.
Angular does not map other event names, such as `count-changed`, to properties, and the Language Service does not suggest two-way bindings for manifest properties.
When an event carries the updated value, bind the property and the event separately:

```angular-html
<my-counter [count]="count" (count-changed)="count = $event.detail" />
```

#### Supported types

Angular parses manifest type text directly with a closed TypeScript type grammar (without creating an additional TypeScript program):

- **Self-contained types:** Primitive keywords (`string`, `number`, `boolean`, `bigint`, `symbol`, `void`, `undefined`, `null`, `never`, `unknown`, `any`, `object`, `true`, `false`), string and numeric literals (including negative numbers), unions (`|`), parenthesized types, object literal types with identifier, string, or numeric property keys (and optional `?` properties), and array types (`T[]`).
  For example, `boolean`, `'primary' | 'secondary'`, `{value: string; count?: number}`, and `string[]`.
- **Standard JavaScript, TypeScript utility, and DOM global types:** An allowlist of standard types such as `CustomEvent<{value: string}>`, `Date`, `Array<T>`, `Record<K, V>`, and standard `lib.dom.d.ts` element and event types (such as `HTMLElement`, `HTMLInputElement`, and `MouseEvent`).
  These names need no entry in `type.references`.
  Angular emits them as `globalThis.<Name>` so a local declaration in a component file cannot shadow them.
- **Other named types via `type.references`:**
  - A reference with `start` and `end` offsets applies to the name at exactly those offsets; if any reference for a name includes offsets and another occurrence of that name has no matching offset entry, Angular rejects the entire type (falling back, with an `NG4009` warning on app-owned manifests).
    Otherwise, an offsetless reference applies to every occurrence of its name in the type text, and if offsetless references give different sources for the same name, Angular rejects the type.
  - If both `package` and `module` are omitted, Angular resolves the symbol from the declaration's module in the manifest's owning package.
    If `package` is specified and `module` is omitted, Angular resolves from that package's entry point.
    If `package` is omitted and `module` is specified, Angular resolves that module in the manifest's owning package.
    For a module in the manifest's own package, Angular tries resolving from the package root first, then relative to the manifest's directory.
    Paths that use TypeScript source extensions (such as `.ts`) or escape the package root (`..`) are rejected.
  - A reference with `package: "global:"` names a global type declared by the project outside the standard allowlist and emits `globalThis.<Name>`.
  - `name` must be the exact exported symbol name. Angular does not treat it as a default export or alias.
  - Package module references are emitted only when the referenced declaration file is already reachable in your TypeScript program and the build uses standard TypeScript module resolution (Angular CLI projects that use `fileReplacements`, and build tools that provide their own module resolution, skip generated package imports).
    If a module is unreachable or gated out, Angular omits the import so the missing import itself produces no template diagnostic: the unreachable reference becomes `unknown` (falling back to the [element class](#element-class) when it is the entire type, while compound types such as `Detail[]` become `unknown[]` and still check assignability), and for `CustomEvent<Detail>`, `$event.detail` becomes `any`.
    If a module is reachable in your program but does not export the referenced name, the missing export itself produces no template diagnostic for property types (which fall back to the element class when available), while `CustomEvent<Detail>` types `$event.detail` as `unknown` (fix or override the manifest, or cast with `$any($event).detail`).

Other type syntax—such as intersections (`&`), tuple types, function types, qualified names like `Foo.Bar`, unreferenced non-standard names, malformed text, and very long or deeply nested type expressions—is ignored for type checking and produces an `NG4009` warning on app-owned manifests.
CEM allows type text from other type systems, so an unsupported type does not necessarily mean the manifest is invalid.
An unsupported manifest type does not itself report a template diagnostic: properties and static attributes fall back to the [element class](#element-class) when available (which can still reject incompatible values), and events fall back to `addEventListener` / `Event` (where accessing `$event.detail` can report `TS2339`).
Top-level `any` and `unknown` on a manifest property also defer to the [element class](#element-class) when available.

NOTE: When a manifest uses an unreferenced standard global name such as `Selection` or `Animation` on a property and the element class is available, Angular checks the element class's property type first so a DOM global does not shadow a library's own type.

The Language Service displays the manifest's raw type text in completions and hovers, whether or not Angular uses it for type checking.

#### Element class

Manifests often omit inherited members or list type names without `type.references`.
Angular resolves an element's class type from `HTMLElementTagNameMap` (when augmented in your project) or, for package manifest entries (`'@my/lib'` or `'@my/lib/custom-elements.json'`), from the package's exported element class when that declaration file is already reachable in your TypeScript program and the build uses standard TypeScript module resolution:

- **Program isolation:** Angular does not pull unimported packages into the compilation through generated type-check blocks, preventing a library's global type augmentations from leaking into unrelated builds such as unit-test configurations that do not import the library.
  In builds where the build tool provides its own module resolution—including Angular CLI projects that use `fileReplacements` and custom Bazel hosts—Angular skips generated package imports, so class checks and package-referenced manifest types rely only on `HTMLElementTagNameMap`, global types, and self-contained manifest types (for package manifests, undeclared properties are accepted unless `HTMLElementTagNameMap` declares the tag; local manifests have no package class import to skip and still check undeclared properties).
- **Inherited and omitted properties:** When the element class resolves, public writable properties declared on the class are accepted and checked as TypeScript property assignments, honoring distinct setter and getter types.
  Fields that the manifest marks `readonly`, `private`, `protected`, or `static` remain unbindable (`NG8002`).
  Standard `HTMLElement` properties (such as `dir`) are checked against the class only if the class narrows the property's type relative to `HTMLElement`.
- **Fallback typing:** A manifest property without a [supported type](#supported-types) (or typed as `any` or `unknown`) falls back to the class property type.
  A supported manifest type takes precedence over the class, except for unreferenced allowlisted global names where the class takes precedence first.
  When a static attribute linked to a property (via `attribute` or `fieldName`) has no manifest type, an unusable manifest type, or an unresolved external manifest type, Angular infers allowed string-literal values from the class property; an explicit non-literal type such as `string` in the manifest takes precedence and accepts any string.
- **Unimported or custom-resolver builds:** If a package manifest's class import is gated out (because the package is not imported in the TypeScript program, or because the build tool provides its own module resolution such as Angular CLI `fileReplacements`) and `HTMLElementTagNameMap` does not declare the tag, self-contained manifest types are still checked and undeclared properties are allowed so inherited base-class members omitted from the manifest do not cause false errors.
  Consequently, misspelled property names are not reported in that build.
  To enable element-class checking for a library loaded by a `<script>` tag, CDN, or excluded from a test `tsconfig`, add an empty type-only import such as `import type {} from '@my/lib/button.js';` in a file compiled by that `tsconfig`: it loads the package's declarations and `HTMLElementTagNameMap` augmentations, produces no errors under `noUnusedLocals` or `verbatimModuleSyntax`, and emits no runtime code.
  In builds that supply their own module resolution (such as Angular CLI projects using `fileReplacements`), Angular still skips generated class imports, so `import type {}` enables class checking only if the imported declarations also augment `HTMLElementTagNameMap` for the tag.

The Language Service does not suggest properties that exist only on the element class, because a class can expose public members that are not part of the element's documented API.

#### Local references

With `strictDomLocalRefTypes`, a local reference such as `#button` on a manifest custom element resolves to:

1. The element's entry in `HTMLElementTagNameMap`, if declared in your TypeScript program.
2. Otherwise, the exported element class from the manifest's package, if the manifest entry names a package (`'@my/lib'` or `'@my/lib/custom-elements.json'`), the class declaration is reachable in your TypeScript program, and the build uses standard TypeScript module resolution (not a custom resolver such as Angular CLI `fileReplacements`).
3. Otherwise, `HTMLElement`.

If a class's typings do not declare that it extends `HTMLElement`, Angular intersects the class with the non-conflicting members of `HTMLElement` so standard DOM properties and native event checks such as `(click)` continue to work.

#### Language Service

The Angular Language Service suggests manifest tags, properties, attributes (as static attributes and `[attr.name]` bindings), and events.
For attributes whose type is a union of string literals, it also suggests attribute values, even when `strictAttributeTypes` is `false`.
Completion details and hovers show the manifest's type text, default value, `description` or `summary`, and `deprecated` notice.

In VS Code, the Angular Language Service publishes manifest diagnostics (`NG4007`, `NG4008`, and `NG4009`) on the project's `tsconfig.json`, watches manifest files and their resolution dependencies (including `package.json`, `node_modules`, out-of-workspace files, and not-yet-created paths), and updates template diagnostics live on both saved and unsaved manifest edits.

#### Using manifests with `CUSTOM_ELEMENTS_SCHEMA`

You can combine manifests with `CUSTOM_ELEMENTS_SCHEMA` to adopt manifests one library at a time.
In a component or module that has `CUSTOM_ELEMENTS_SCHEMA`:

- Angular still checks binding values for properties declared by a manifest or resolved element class (so under `strictInputTypes`, assigning to a class-only `readonly` property still fails), declared static attribute values, and declared event types.
- Angular allows bindings to properties that neither a manifest nor a resolved element class declares on every tag containing a dash.
  Without the schema, binding to an unknown property on a manifest tag reports an error whenever the element class resolves (or the manifest is a local file without a gated package import).
  Keep `CUSTOM_ELEMENTS_SCHEMA` while a library's manifest omits properties you bind to, and remove it (ensuring the element's package is imported in the compiled program) to catch misspelled tags and property names.

IMPORTANT: Adding a manifest can report type errors that `CUSTOM_ELEMENTS_SCHEMA` previously hid.
Fix the errors, cast a binding with `$any()`, or override the declaration as described in [Fixing a library's manifest](#fixing-a-librarys-manifest).
Use `NO_ERRORS_SCHEMA` only when you intend to turn off all schema checks.

Manifests are used only by the AOT compiler.
Templates compiled at runtime—including Karma-based `TestBed` tests without AOT, templates set with `TestBed.overrideComponent` or `TestBed.overrideTemplate`, and JIT-bootstrapped applications—still need `CUSTOM_ELEMENTS_SCHEMA` for custom elements.
By default, the Angular Vitest unit-test builder compiles tests with AOT, so those tests use configured manifests.

#### Fixing a library's manifest

If a library's manifest is incorrect or incomplete:

- To replace it completely, add a corrected copy to your project and configure that file path instead of the package.
- To override specific tags, list a local manifest with corrected declarations before the package entry in `customElementsManifests`.
  The first declaration of a tag wins.

Because a local file entry has no owning package, its `type.references` need an explicit `package` field (and a `module` field when the type is not exported from the package's entry point), or it can use self-contained type text without named imports.
To type local references with a custom element class when using a local manifest, augment `HTMLElementTagNameMap` in your project or publish the manifest in a workspace package with a `customElements` field and configure that package name.

If a manifest contains a `custom-element-definition` export whose class declaration is not in the manifest (for example, one in another package), Angular recognizes the tag but not its custom properties.
Fix the manifest, configure a corrected copy, or add `CUSTOM_ELEMENTS_SCHEMA` to the components that use the tag.

#### Generated code

Angular sets properties declared in a configured Custom Elements Manifest using their exact names.
For example, `[readonly]` sets the element's `readonly` property instead of mapping it to the native `readOnly`.
This also applies to property interpolations translated with `i18n-*`.
One-way `[class]` remains Angular's CSS class binding, while two-way `[(class)]` uses the exact `class` property name when declared in the manifest.
Properties not declared in the manifest keep Angular's standard DOM property mapping, and type checking follows that same mapping: when an element declares only `readOnly`, `[readonly]` is checked against and sets `readOnly`.

IMPORTANT: Templates compiled at runtime do not use manifests, so they apply Angular's standard DOM mapping where AOT-compiled templates set the exact manifest property name.
Libraries compiled ahead of time with `compilationMode: 'partial'` are an exception: their partial declarations carry `customElementPropertyNames`, so they keep exact property names even when compiled at runtime.
This affects the six names that Angular maps: `class`, `for`, `formaction`, `innerHtml`, `readonly`, and `tabindex`.
An element that declares one of these names without the mapped DOM property behaves differently in tests that call `TestBed.overrideComponent` or `TestBed.overrideTemplate`, and in applications bootstrapped with the JIT compiler.

Directive `host` bindings are compiled without component manifests, so `host: {'[readonly]': 'value'}` still sets `readOnly`.
Bind the property in the component template when the exact name matters.

When a library compiled with `compilationMode: 'partial'` binds a manifest property that Angular would otherwise rename (such as `readonly`), applications that use the library require Angular 22.4.0 or later.

#### Limitations

- Angular does not follow `superclass` or `mixins` in the manifest JSON.
  Inherited members are known when the manifest lists them on each element's declaration—as tools such as the [Custom Elements Manifest analyzer](https://custom-elements-manifest.open-wc.org/) do—or when the [element class](#element-class) resolves.
- Without a supported event `type` in the manifest, `$event` falls back to TypeScript's `addEventListener` inference on the element (or `Event` for unknown event names).
- Angular's security checks reject property and attribute bindings whose names start with `on` (ignoring case), such as `[onDark]` and `[attr.ondark]`, even when the manifest declares them.
  Use a static attribute, such as `ondark`, if the element supports it.
- Manifest diagnostics do not point to a line in the manifest file.

#### Diagnostics

| Code     | Category | Cause                                                                                                                                                                                                                                    | Result                                                                                                                                                   |
| :------- | :------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NG4007` | Error    | An entry does not resolve to a file (missing file, unresolvable package/specifier, or `package.json` without a string `customElements` field), or the file cannot be read.                                                               | Angular skips the entry and loads the others.                                                                                                            |
| `NG4008` | Error    | `customElementsManifests` is not an array of non-empty strings, or a manifest file is not valid JSON or lacks a top-level string `schemaVersion` and `modules` array.                                                                    | An invalid `customElementsManifests` option loads no manifests; an invalid manifest file is skipped while other entries still load.                      |
| `NG4009` | Warning  | An app-owned manifest (a local file outside `node_modules`) contains problems such as an unsupported `schemaVersion`, invalid tag names, duplicate tags, unsupported types, missing declarations, or inconsistent attribute/field links. | Angular emits at most one summarized warning per app-owned manifest (count and up to three examples) and skips only the affected records or type checks. |

Manifests inside `node_modules` or configured by package name do not emit `NG4009` warnings, so third-party manifests do not introduce build noise.

#### Rebuilds

Manifests are inputs to template type checking and, when a manifest adds or removes one of Angular's mapped DOM property names, to template code generation.
When the build tool reports that a manifest or one of its resolution dependencies changed, Angular reloads manifests (reusing cached parse results for unchanged files) and re-checks affected templates.
Whether edits inside `node_modules` trigger a rebuild depends on the build tool's file watching.

### `disableTypeScriptVersionCheck`

When `true`, the compiler does not look at the TypeScript version and does not report an error when an unsupported version of TypeScript is used.
Not recommended, as unsupported versions of TypeScript might have undefined behavior.
Default is `false`.

### `enableI18nLegacyMessageIdFormat`

Instructs the Angular template compiler to create legacy ids for messages that are tagged in templates by the `i18n` attribute.
See [Mark text for translations][GuideI18nCommonPrepareMarkTextInComponentTemplate] for more information about marking messages for localization.

Set this option to `false` unless your project relies upon translations that were created earlier using legacy IDs.
Default is `true`.

The pre-Ivy message extraction tooling created a variety of legacy formats for extracted message IDs.
These message formats have some issues, such as whitespace handling and reliance upon information inside the original HTML of a template.

The new message format is more resilient to whitespace changes, is the same across all translation file formats, and can be created directly from calls to `$localize`.
This allows `$localize` messages in application code to use the same ID as identical `i18n` messages in component templates.

IMPORTANT: This option is only supported by the `@angular-devkit/build-angular:browser` builder.
When using the `@angular/build:application` builder (esbuild), this option has no effect and the new decimal message ID format is always used regardless of this setting.

### `enableResourceInlining`

When `true`, replaces the `templateUrl` and `styleUrls` properties in all `@Component` decorators with inline content in the `template` and `styles` properties.

When enabled, the `.js` output of `ngc` does not include any lazy-loaded template or style URLs.

### `flatModuleId`

The module ID to use for importing a flat module \(when `flatModuleOutFile` is `true`\).
References created by the template compiler use this module name when importing symbols from the flat module.
Ignored if `flatModuleOutFile` is `false`.

### `flatModuleOutFile`

When `true`, generates a flat module index of the given filename and the corresponding flat module metadata.
Use to create flat modules that are packaged similarly to `@angular/core` and `@angular/common`.
When this option is used, the `package.json` for the library should refer to the created flat module index instead of the library index file.

Produces only one `.metadata.json` file, which contains all the metadata necessary for symbols exported from the library index.
In the created `.ngfactory.js` files, the flat module index is used to import symbols. Symbols that include both the public API from the library index and shrouded internal symbols.

By default, the `.ts` file supplied in the `files` field is assumed to be the library index.
If more than one `.ts` file is specified, `libraryIndex` is used to select the file to use.
If more than one `.ts` file is supplied without a `libraryIndex`, an error is produced.

A flat module index `.d.ts` and `.js` is created with the given `flatModuleOutFile` name in the same location as the library index `.d.ts` file.

For example, if a library uses the `public_api.ts` file as the library index of the module, the `tsconfig.json` `files` field would be `["public_api.ts"]`.
The `flatModuleOutFile` option could then be set, for example, to `"index.js"`, which produces `index.d.ts` and `index.metadata.json` files.
The `module` field of the library's `package.json` would be `"index.js"` and the `typings` field would be `"index.d.ts"`.

### `generateCodeForLibraries`

When `true`, creates factory files \(`.ngfactory.js` and `.ngstyle.js`\) for `.d.ts` files with a corresponding `.metadata.json` file. The default value is `true`.

When `false`, factory files are created only for `.ts` files.
Do this when using factory summaries.

### `preserveWhitespaces`

When `false`, the default, removes blank text nodes from compiled templates, which results in smaller emitted template factory modules.
Set to `true` to preserve blank text nodes.

HELPFUL: When using hydration, it is recommended that you use `preserveWhitespaces: false`, which is the default value. If you choose to enable preserving whitespaces by adding `preserveWhitespaces: true` to your tsconfig, it is possible you may encounter issues with hydration. This is not yet a fully supported configuration. Ensure this is also consistently set between the server and client tsconfig files. See the [hydration guide](guide/hydration#preserve-whitespaces-configuration) for more details.

### `skipMetadataEmit`

When `true`, does not produce `.metadata.json` files.
Default is `false`.

The `.metadata.json` files contain information needed by the template compiler from a `.ts` file that is not included in the `.d.ts` file produced by the TypeScript compiler.
This information includes, for example, the content of annotations, such as a component's template, which TypeScript emits to the `.js` file but not to the `.d.ts` file.

You can set to `true` when using factory summaries, because the factory summaries include a copy of the information that is in the `.metadata.json` file.

Set to `true` if you are using TypeScript's `--outFile` option, because the metadata files are not valid for this style of TypeScript output.
The Angular community does not recommend using `--outFile` with Angular.
Use a bundler, such as [webpack](https://webpack.js.org), instead.

### `skipTemplateCodegen`

When `true`, does not emit `.ngfactory.js` and `.ngstyle.js` files.
This turns off most of the template compiler and disables the reporting of template diagnostics.

Can be used to instruct the template compiler to produce `.metadata.json` files for distribution with an `npm` package. This avoids the production of `.ngfactory.js` and `.ngstyle.js` files that cannot be distributed to `npm`.

### `strictMetadataEmit`

When `true`, reports an error to the `.metadata.json` file if `"skipMetadataEmit"` is `false`.
Default is `false`.
Use only when `"skipMetadataEmit"` is `false` and `"skipTemplateCodegen"` is `true`.

This option is intended to verify the `.metadata.json` files emitted for bundling with an `npm` package.
The validation is strict and can emit errors for metadata that would never produce an error when used by the template compiler.
You can choose to suppress the error emitted by this option for an exported symbol by including `@dynamic` in the comment documenting the symbol.

It is valid for `.metadata.json` files to contain errors.
The template compiler reports these errors if the metadata is used to determine the contents of an annotation.
The metadata collector cannot predict the symbols that are designed for use in an annotation. It preemptively includes error nodes in the metadata for the exported symbols.
The template compiler can then use the error nodes to report an error if these symbols are used.

If the client of a library intends to use a symbol in an annotation, the template compiler does not normally report this. It gets reported after the client actually uses the symbol.
This option allows detection of these errors during the build phase of the library and is used, for example, in producing Angular libraries themselves.

### `strictInjectionParameters`

When `true`, reports an error for a supplied parameter whose injection type cannot be determined.
When `false`, constructor parameters of classes marked with `@Injectable` whose type cannot be resolved produce a warning.
The recommended value is `true`, but the default value is `false`.

When you use the Angular CLI command `ng new --strict`, it is set to `true` in the created project's configuration.

### `strictTemplates`

When `true`, enables [strict template type checking](tools/cli/template-typecheck#strict-mode).

The strictness flags that this option enables allow you to turn on and off specific types of strict template type checking.
See [troubleshooting template errors](tools/cli/template-typecheck#troubleshooting-template-errors).
Default is `true`.

### `strictStandalone`

When `true`, reports an error if a component, directive, or pipe is not standalone.

### `trace`

When `true`, prints extra information while compiling templates.
Default is `false`.

### `typeCheckHostBindings`

When `true`, enables type checking of expressions in the `host` object literal and `@HostBinding`/`@HostListener` decorators of components and directives.
Default is `true`.

## Command line options

Most of the time, you interact with the Angular Compiler indirectly using [Angular CLI](reference/configs/angular-compiler-options). When debugging certain issues, you might find it useful to invoke the Angular Compiler directly.
You can use the `ngc` command provided by the `@angular/compiler-cli` npm package to call the compiler from the command line.

The `ngc` command is a wrapper around TypeScript's `tsc` compiler command. The Angular Compiler is primarily configured through `tsconfig.json` while Angular CLI is primarily configured through `angular.json`.

Besides the configuration file, you can also use [`tsc` command line options](https://www.typescriptlang.org/docs/handbook/compiler-options.html) to configure `ngc`.

[GuideI18nCommonPrepareMarkTextInComponentTemplate]: guide/i18n/prepare#mark-text-in-component-template 'Mark text in component template - Prepare component for translation | Angular'
