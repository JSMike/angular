Yes: there is room for a smaller implementation that preserves the feature demonstrated by the example app. I recommend simplifying the manifest ingestion/type-validation subsystem and test setup, while retaining the compiler, editor, and runtime behavior. I would not treat the number of touched files as the primary measure of success.

Reviewed `custom-elements-manifest-support` at `183a4bdab7277e407d2ba829f9bc103c884feb64`, compared with its merge base with local `main`. Review date: September 6, 2026. Source review and experiments use `/home/mcebrian/dev/angular-cem-review`, an isolated detached worktree. The original checkout remains on `custom-element-manifest-support-v2`, unchanged.

**What the size actually represents**

The branch adds 14,090 lines and deletes 266 across 95 files. Classification is by file path; test support and fixtures are counted with tests, including build files under test directories.

| Category | Files | Added lines | Deleted lines |
| --- | ---: | ---: | ---: |
| Production implementation and interfaces | 58 | 5,014 | 243 |
| Tests, test support, and fixtures | 31 | 8,920 | 23 |
| Other documentation, API goldens, build/configuration | 6 | 156 | 0 |
| Total | 95 | 14,090 | 266 |

About 63% of added lines are tests and fixtures. Within production additions:

| Area | Added lines |
| --- | ---: |
| New compiler-cli CEM subsystem | 3,253 |
| Other compiler-cli integration | 530 |
| Compiler schema/type-check/code-generation integration | 617 |
| Language service | 586 |
| Core runtime | 28 |

The CEM subsystem accounts for roughly 65% of the production additions. That is the main simplification target. The new subsystem's four spec files alone contain 4,535 lines.

**The feature boundary matters**

The original [Angular issue #36893](https://github.com/angular/angular/issues/36893) asks for custom-element property/event autocompletion and descriptions in the language service. The branch and the local example app have a broader contract: compiler diagnostics, binding-value checks, event payloads, typed local references, editor support, and correct runtime property names.

An editor-only implementation would be materially smaller and could address that original request. It would not preserve the feature demonstrated by this harness. For this review, “feature complete” means retaining the broader observable behavior recorded in the [example app's implementation summary](/home/mcebrian/dev/angular-cem-example-app/angular-cem-implementation-summary.md:15).

**Recommended changes, in order**

1. **Deduplicate semantic type validation and consider one auxiliary program per load.**

   [The loader](/home/mcebrian/dev/angular-cem-review/packages/compiler-cli/src/ngtsc/custom_elements_manifest/src/loader.ts:106) resolves schemas inside its per-manifest loop. [The resolver](/home/mcebrian/dev/angular-cem-review/packages/compiler-cli/src/ngtsc/custom_elements_manifest/src/type_resolver.ts:127) calls `inspectTypes`, and [the type program](/home/mcebrian/dev/angular-cem-review/packages/compiler-cli/src/ngtsc/custom_elements_manifest/src/type_program.ts:36) emits one alias per `ManifestCheckType` object. Distinct members with identical types are separate objects.

   A temporary instrumentation bundle built from the reviewed source measured **17 auxiliary programs and 8,770 generated aliases**, with **1,284 distinct check-type texts when counted separately within each manifest**, for the harness's normal configuration. Compilation had zero errors. This is evidence of duplicate work, not a measured speedup or proof that all validation contexts can be merged without care.

   First group equivalent types after module-specifier rewriting, validate once, and retain all original member origins for diagnostics. Then evaluate batching all manifests into one auxiliary program. Preserve module resolution mode, manifest-relative fallback decisions, and diagnostic ownership. Cross-manifest deduplication must key on the effective resolved type/environment, not raw author text alone.

   Keep semantic validation: syntax-valid expressions can still have missing exports, wrong generic arity, or invalid constraints. Dropping it would cause generated-code errors to leak into templates and change the current narrow fallback behavior.

   Also examine whether the auxiliary program's resolution and semantic diagnostics can replace the separate export/global preflight checks. Keep explicit policy checks where TypeScript's accepted behavior differs from Angular's contract; avoid independently reproducing decisions the same program has already made.

2. **Replace the bespoke type scanner with one explicit TypeScript AST validation path.**

   [check_type.ts](/home/mcebrian/dev/angular-cem-review/packages/compiler-cli/src/ngtsc/custom_elements_manifest/src/check_type.ts:72) manually scans characters, identifiers, strings, and bracket balance; parses an AST to distinguish object-property names; substitutes reference text; and parses the result again. The file is 449 lines, plus a 56-line parsing/cache helper.

   Parse a bounded type alias once, require the expected complete AST shape, walk an explicit allowlist of supported type nodes, and identify referenced names from AST positions. Build substituted import-type nodes from validated package/export metadata and serialize only the accepted type. This removes duplicated syntax analysis and makes the accepted language easier to audit.

   Retain size limits, precise reference spans, exact export resolution, and failure isolation. Do not simply paste arbitrary CEM text into a TCB or accept every node TypeScript can parse. Preserve the current supported subset initially; changing rejection rules for function types, comments, escapes, or object-type semicolons is a separate behavior decision.

3. **Use one diagnostic representation and one summary formatter.**

   Warning aggregation currently lives in three places: [declaration warnings](/home/mcebrian/dev/angular-cem-review/packages/compiler-cli/src/ngtsc/custom_elements_manifest/src/manifest_diagnostics.ts:40), [type-reference warnings](/home/mcebrian/dev/angular-cem-review/packages/compiler-cli/src/ngtsc/custom_elements_manifest/src/type_resolver.ts:238), and [cross-manifest duplicates](/home/mcebrian/dev/angular-cem-review/packages/compiler-cli/src/ngtsc/custom_elements_manifest/src/loader.ts:190). Parser/member code also assembles long final diagnostic strings.

   Return structured problems with code, manifest, subject, reason, and recovery information. Format and aggregate them once. Preserve error severity, narrow recovery, bounded default output, and lossless verbose output. Exact prose need not be frozen by every test, but meaningful diagnostic content should remain covered.

   This is a feature-preserving simplification. Removing the verbose option or producer-conformance warnings is a separate scope reduction. In particular, checking malformed visibility/readonly flags protects binding eligibility and should remain, even if notices about a missing redundant definition export or `reflects` relationship are later reconsidered.

4. **Make the tests concise before deleting coverage.**

   There are near-duplicate fixture-repair helpers in [manifest_parser_spec.ts](/home/mcebrian/dev/angular-cem-review/packages/compiler-cli/src/ngtsc/custom_elements_manifest/test/manifest_parser_spec.ts:25) and [loader_spec.ts](/home/mcebrian/dev/angular-cem-review/packages/compiler-cli/src/ngtsc/custom_elements_manifest/test/loader_spec.ts:118), plus repeated manifest/module/declaration wrappers throughout integration tests.

   Use a small fixture builder that creates a valid manifest by construction. Keep malformed cases explicit. Parameterize genuinely parallel cases such as unsupported type forms, invalid reference spans, and summary/verbose rendering. Keep detailed parsing/resolution matrices at their owning layer and representative compiler/editor tests that prove wiring and user-visible behavior.

   Do not delete the same scenario from every layer merely because its name repeats: a parser test cannot prove TCB source mapping, an editor test cannot prove runtime assignment, and a loader cache test cannot prove watcher-driven invalidation. Generated compliance goldens should remain generated.

5. **Consolidate lifecycle ownership, rather than merely concatenating files.**

   A reasonable organization is a manifest parser/projection, resolver, type validator with its host, loader/cache, diagnostics formatter, and the shared compiler index. Keep abstractions where they isolate distinct responsibilities. Renaming or merging the current 13 implementation files alone would not meaningfully simplify maintenance.

   Preserve the current resource invalidation and dependency tracking while changing the type pipeline. The [content cache](/home/mcebrian/dev/angular-cem-review/packages/compiler-cli/src/ngtsc/custom_elements_manifest/src/loader.ts:262) and [language-service resource tracking](/home/mcebrian/dev/angular-cem-review/packages/language-service/src/adapters.ts:164) handle package metadata, missing files, unsaved changes, and oversized snapshots. Removing those mechanisms without a replacement could make a short patch feel worse in daily use. Reassess cache complexity after measuring the deduplicated/batched validator.

**What I would preserve**

| Behavior | Why it belongs in a feature-equivalent version |
| --- | --- |
| Relative paths, JSON package exports, and bare-package discovery | All are demonstrated by the harness. |
| Known tags and writable properties without blanket suppression | Central compiler benefit. Attribute declarations must not silently authorize JS properties. |
| Primitive, literal, and explicitly referenced types | Removing named types loses the Box Model and workspace examples. |
| Static string-union checks and value completions | A visible part of the feature; attribute conversion must remain distinct from property assignment. |
| Typed events and local references, with narrow fallbacks | Part of the documented feature and existing acceptance tests. |
| Documentation, defaults, and deprecation in editor results | Central editor benefit and relatively small integration code. |
| Directive/input/output precedence and native security handling | Prevents regressions when custom elements coexist with Angular directives and native DOM APIs. |
| Manifest edits, deletion/recreation, and large-file support | Required for editor/build correctness. |
| Exact property names through full/partial compilation, linking, and HMR | Prevents compile-time approval of bindings that write the wrong runtime property. |

The exact-property pipeline looks expensive in the file list, but the core runtime addition is only 28 lines across three files. For example, Shoelace exposes `readonly`; Angular normally remaps that spelling to `readOnly`. Keeping the compiler check while removing the runtime distinction would reintroduce incorrect behavior. Existing pipeline/compiler boundaries explain many of the small edits. A compiler-only workaround must also preserve directive input dispatch, sanitizers, interpolation, two-way input assignment, and partial-linker compatibility.

I would also avoid replacing manifest types wholesale with element-class `.d.ts` types or fabricating Angular directive wrappers as a shortcut. Both change the authority and semantics of the current feature, including its deliberate handling of unusable manifest type text and serialized attributes.

**A practical scope for v2**

Keep the current user-facing feature contract and the existing branch as an oracle. Refactor one boundary at a time: fixture setup and diagnostic formatting first, AST validation next, then deduplicated/batched semantic validation and its cache. Keep the original tests during the implementation changes; reduce repetitive test setup afterward.

An initial planning target of approximately **9,000–11,000 total added lines, including tests**, seems plausible for the broader feature. This is an engineering estimate, not the measured size of an implemented replacement. A much smaller editor-only patch is possible, but requires explicitly dropping compiler/runtime behavior. I would not promise a 2,000-line feature-equivalent implementation or optimize to an arbitrary file count.

The branch's existing documentation is evidence of current behavior, not a requirement that every policy remain forever. If the goal is consumer functionality rather than identical diagnostic output, producer-conformance auditing is the clearest optional scope cut. Keep warnings that explain a lost template check; reconsider notices that merely coach a manifest producer while leaving all consumer behavior unchanged. Evaluate that as an explicit product decision rather than disguising it as a refactor.

A smaller version is acceptable only if it retains the focused manifest tests, compiler/type-check integration, language-service behavior, and exact-property compliance coverage. Use the example app's compiler and editor checks, normal and full Lion manifests, runtime examples, and warm/editor-edit latency measurements as the acceptance gate. A build that succeeds by silently degrading everything to existence-only checking is not equivalent.

**Verification performed**

- The reviewed branch's manifest target passed: 320 specs, zero failures.
- Compiler core passed: 56 specs, zero failures.
- Compiler-cli type-check target passed: 1,757 specs, zero failures.
- All nine example-app compiler checks passed against a fresh source bundle of the reviewed compiler and compiler-cli. Normal configuration: 28 warnings and zero errors. Verbose configuration: 1,936 warnings. Full Lion configuration: 32 warnings and zero errors.
- The source bundle avoids relying on the app's installed Angular packages, whose version identifies a different earlier build. The harness's installed runtime/declaration dependencies were retained. This was compiler validation, not a fresh application distribution/browser build.
- The initial broader test run encountered confirmed OS OOM kills in language-service shards despite `--jobs=2 --local_test_jobs=2`. That invocation was stopped, its Bazel server/workers were shut down, and a serial test retry was started with `--jobs=2 --local_test_jobs=1 --worker_max_instances=1 --test_arg=--node_options=--max-old-space-size=2048`.
- The serial retry passed both complete targets: compiler integration (`//packages/compiler-cli/test/ngtsc:ngtsc`) and language service (`//packages/language-service/test:test`), including all four shards of each. Together with the three earlier passing targets, all five selected Bazel test targets passed. Existing disabled/pending tests were not enabled.
- `git diff --check main...custom-elements-manifest-support` reports a trailing blank line in `GOLDEN_PARTIAL.js:161`; this is a generated-golden formatting observation, not a feature defect.

No production source files or example-app files were modified. Review notes and temporary bundles are confined to the isolated worktree. This review proposes a smaller implementation; it does not claim that a feature-equivalent v2 has already been implemented or proved.
