## [2.0.0](https://github.com/zbigniewsobiecki/au/compare/v1.6.0...v2.0.0) (2026-01-25)

### ⚠ BREAKING CHANGES

* AU format (.au files) is no longer supported. SysML v2 is now
the only model representation.

## Removed
- AU core libraries (au-yaml.ts, au-paths.ts, validator.ts)
- AU gadgets (AURead, AUUpdate, AUList)
- AU subagent
- AU commands (old ingest, ingest2, update)
- AU templates (ingest/, ingest2/, update/)
- Progress tracker and dependency graph (AU-specific)

## Added
- SysML subagent with AskAboutCodebase gadget
- New dump command for SysML model export

## Changed
- Renamed sysml-ingest → ingest
- Moved sysml/validate → validate
- Moved sysml/stats → stats
- document command: --au-only → --model-only, uses SysML
- docs-feedback: migrated to SysML gadgets
- All templates updated to reference SysML
- file-filter: now ignores .sysml/ instead of .au files
- command-utils: selectReadGadgets uses modelOnly parameter

## Migration
Users should run `au ingest` to generate SysML model from their codebase.
The `au dump` command now outputs SysML format.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>

### Features

* complete AU to SysML migration - remove AU format entirely ([4ab5691](https://github.com/zbigniewsobiecki/au/commit/4ab569178cef7523d2bebf84c699a44f9f14d913))
* **sysml:** enhance templates with full SysML v2 language support ([b2e407f](https://github.com/zbigniewsobiecki/au/commit/b2e407f14859b9122ace137009f804ae97a07675))

### Bug Fixes

* **sysml:** correct metadata syntax rules and stdlib names ([4298bb7](https://github.com/zbigniewsobiecki/au/commit/4298bb715689faf527efcffb4a736ce3138e6752))
* **templates:** use :> for requirement specialization ([980bf10](https://github.com/zbigniewsobiecki/au/commit/980bf103ccd1e2c5ae343a9cd80275cf20573b6a))

## [1.6.0](https://github.com/zbigniewsobiecki/au/compare/v1.5.0...v1.6.0) (2026-01-23)

### Features

* **sysml:** add JSON string handling for ManifestWrite and raise coverage to 99% ([#17](https://github.com/zbigniewsobiecki/au/issues/17)) ([fcfba29](https://github.com/zbigniewsobiecki/au/commit/fcfba29db226293f6784fa1bc0fc29aaf1464925))

## [1.5.0](https://github.com/zbigniewsobiecki/au/compare/v1.4.1...v1.5.0) (2026-01-22)

### Features

* **sysml:** add agentic --fix mode to sysml validate ([b1f429b](https://github.com/zbigniewsobiecki/au/commit/b1f429b66260afbb1d03f8f0414fcf5741a249c8))

## [1.4.1](https://github.com/zbigniewsobiecki/au/compare/v1.4.0...v1.4.1) (2026-01-22)

### Bug Fixes

* **sysml:** correct connection syntax and add deduplication ([ea16be9](https://github.com/zbigniewsobiecki/au/commit/ea16be9889b3babd906f1e9e8e5bd821ac28f002))

## [1.4.0](https://github.com/zbigniewsobiecki/au/compare/v1.3.0...v1.4.0) (2026-01-22)

### Features

* **sysml:** add search/replace mode to SysMLWrite gadget ([1dbe804](https://github.com/zbigniewsobiecki/au/commit/1dbe8042344bab8a71849b52d326eef0d4c2bc4c))

### Bug Fixes

* **sysml:** add output truncation and suppress parser warnings ([70ccd16](https://github.com/zbigniewsobiecki/au/commit/70ccd164146b9e8affc63b4bc59e62ab40d8178d))

## [1.3.0](https://github.com/zbigniewsobiecki/au/compare/v1.2.0...v1.3.0) (2026-01-22)

### Features

* **docs-feedback:** add command with inline content and AU-backed fixes ([940d9b7](https://github.com/zbigniewsobiecki/au/commit/940d9b76e1e7784606f97c3019a23e9bf54186b8))
* **ingest2:** add iterative file viewer command for documentation ([#11](https://github.com/zbigniewsobiecki/au/issues/11)) ([e809557](https://github.com/zbigniewsobiecki/au/commit/e809557fe430057331546be99e8925aeda52b4ad))

## [1.2.0](https://github.com/zbigniewsobiecki/au/compare/v1.1.0...v1.2.0) (2026-01-21)

### Features

* **document:** add document-verify command with fix capability ([#9](https://github.com/zbigniewsobiecki/au/issues/9)) ([ea5ad97](https://github.com/zbigniewsobiecki/au/commit/ea5ad974ad56a8a4b29172874e5d184b708b8b83))
* **document:** enforce one WriteFile per turn for better quality ([#8](https://github.com/zbigniewsobiecki/au/issues/8)) ([da1d8d3](https://github.com/zbigniewsobiecki/au/commit/da1d8d39a4486725e90f37417111f0478e393986))
* **document:** improve documentation generation for any repository ([#7](https://github.com/zbigniewsobiecki/au/issues/7)) ([3b41871](https://github.com/zbigniewsobiecki/au/commit/3b4187169b6253e5f6b961ba0247a925fdfda420))

## [1.1.0](https://github.com/zbigniewsobiecki/au/compare/v1.0.1...v1.1.0) (2026-01-16)

### Features

* add CI/CD workflows and npm publishing ([156cc49](https://github.com/zbigniewsobiecki/au/commit/156cc498be9fb3fe8b9070117b301fd75257d5c7))
* improve update prompts and add hash-based stale mode ([#5](https://github.com/zbigniewsobiecki/au/issues/5)) ([94a0fac](https://github.com/zbigniewsobiecki/au/commit/94a0fac7f49880c08d3af6837967c8c35d1987a1))

### Bug Fixes

* add trailing newline to gitignore ([#1](https://github.com/zbigniewsobiecki/au/issues/1)) ([63ae559](https://github.com/zbigniewsobiecki/au/commit/63ae55958bb333b0104ff7156848b952788bab56))
* apply npm pkg fix corrections ([#3](https://github.com/zbigniewsobiecki/au/issues/3)) ([e4d4136](https://github.com/zbigniewsobiecki/au/commit/e4d413618b40ae61ca2081d2022e65edacb3e0f8))

## [1.0.1](https://github.com/zbigniewsobiecki/au/compare/v1.0.0...v1.0.1) (2026-01-16)

### Bug Fixes

* npm pkg fix corrections ([#4](https://github.com/zbigniewsobiecki/au/issues/4)) ([82b50c7](https://github.com/zbigniewsobiecki/au/commit/82b50c7e95c658030aca7a9c9bf7cb8b5a6288cf)), closes [#1](https://github.com/zbigniewsobiecki/au/issues/1) [#3](https://github.com/zbigniewsobiecki/au/issues/3)

## 1.0.0 (2026-01-16)

### Features

* add --au-only and --code-only flags to ask command ([c29b365](https://github.com/zbigniewsobiecki/au/commit/c29b3654bcab5365641dd7ad8db8691048649482))
* add batching reminder to ingest trailing message ([6812322](https://github.com/zbigniewsobiecki/au/commit/68123223ede351dd159a731b050be24d8458d58a))
* add benchmark test questions for AU repository ([674445a](https://github.com/zbigniewsobiecki/au/commit/674445afb8bc015320671e21c1f5a544b454b67d))
* add benchmark test questions for niu codebase ([619f270](https://github.com/zbigniewsobiecki/au/commit/619f270302b13c8a6fc3080076d0054ed8a949ce))
* add document command for generating documentation ([89aefc2](https://github.com/zbigniewsobiecki/au/commit/89aefc2b97a6308282c5d16960f21eac1229aef6))
* add dump command to output all .au contents ([82b5936](https://github.com/zbigniewsobiecki/au/commit/82b593637b9ab509dfe91596934ef20204c5e9b6))
* add maxDepth parameter to AUList gadget ([7b6f158](https://github.com/zbigniewsobiecki/au/commit/7b6f158209237923a67889e10f05f095a5ccc0fb))
* add prepare script for npm install from GitHub ([1781f16](https://github.com/zbigniewsobiecki/au/commit/1781f1680c457325da0c4dba538d21262f3c7e77))
* add progress tracking, source validation, and ask command ([45bd406](https://github.com/zbigniewsobiecki/au/commit/45bd406f2436ac3b56786ed91d70f604e3e556e9))
* add refinement phase to ask command for improved pattern discovery ([e5e62ec](https://github.com/zbigniewsobiecki/au/commit/e5e62ec59aeb397e2059ec85fe15655de6cb761a))
* add stale reference detection to validate command ([836314a](https://github.com/zbigniewsobiecki/au/commit/836314a73ff724f53215734f9896eb4efcb72b8c))
* add stats command for understanding coverage metrics ([275ab7f](https://github.com/zbigniewsobiecki/au/commit/275ab7f254b7f06320bb4041a154e91df671e511))
* add update command with git diff awareness ([47eab4d](https://github.com/zbigniewsobiecki/au/commit/47eab4d5886b62be6e5e182b8cd337e4609d5d55))
* add validate command and fix --path handling ([e124ed6](https://github.com/zbigniewsobiecki/au/commit/e124ed67723eb34f6392a7c846ded9096ce3e911))
* enhance schema with typed dependencies and strip meta from inference ([9b9cf7b](https://github.com/zbigniewsobiecki/au/commit/9b9cf7b436729e402777443d1ffb049f109e7991))
* enhance stats command with coverage metrics ([fb92c68](https://github.com/zbigniewsobiecki/au/commit/fb92c68f2e6eed3463243bde65f8eb850f70dc95))
* improve ask command to use both AU and code by default ([6bfc1fa](https://github.com/zbigniewsobiecki/au/commit/6bfc1fa469193b63a77ad47cca531a0079049d8f))
* improve document command with resumable generation and section outlines ([c6813e7](https://github.com/zbigniewsobiecki/au/commit/c6813e7e24c65a3f3a2f914ec81c79c07e4973f5))
* merge review into ingest and enable full-document updates ([d831ef1](https://github.com/zbigniewsobiecki/au/commit/d831ef12f5c29567a92114ff69dd447297b00ab8))
* optimize ingest for fewer iterations ([2e4ad28](https://github.com/zbigniewsobiecki/au/commit/2e4ad2898968d3372743976ff9facedf2d3db1cf))

### Bug Fixes

* add TypeScript type declarations to package.json ([671e876](https://github.com/zbigniewsobiecki/au/commit/671e876cbf35e57c9d221569e86eeb616c1b4f6e))
* clarify structure and enforce minimum 3 files per iteration ([ccb22ee](https://github.com/zbigniewsobiecki/au/commit/ccb22eea8203166aaa1509e1e9cf3c159a320989))
* correct regex for parsing AUUpdate result messages ([5412eba](https://github.com/zbigniewsobiecki/au/commit/5412eba6c4b3a3d81154e8246791501576e5bbd0))
* count AU entries from file discovery, not string parsing ([1b80f97](https://github.com/zbigniewsobiecki/au/commit/1b80f9762f5c961d52344b6e8cf75716d25fc595))
* exclude directories from AU/Source ratio and rename label ([0860230](https://github.com/zbigniewsobiecki/au/commit/0860230f0e47fbf09bc54def43b223fb12b1c080))
* exclude directory .au files from coverage percentage ([909a24e](https://github.com/zbigniewsobiecki/au/commit/909a24ec87fcdb8e1697d6ef87c40abb22441a2f))
* improve validation and prompting ([a4f2570](https://github.com/zbigniewsobiecki/au/commit/a4f25702196970daf8c585ff70e1742ea326aa18))
* include directories and root in coverage calculation ([8fb3def](https://github.com/zbigniewsobiecki/au/commit/8fb3defe7c32b582d052d9620f267876087c79b1))
* make prepare script conditional on src existence ([192c6ea](https://github.com/zbigniewsobiecki/au/commit/192c6eafd6f4bb425569300731d28c54912c1ec4))
* respect .gitignore in validator source file scanning ([dd5c3a5](https://github.com/zbigniewsobiecki/au/commit/dd5c3a52d3d4d52052d519038b2e95741adb9515))
* round bytes display in stats command ([9be16e8](https://github.com/zbigniewsobiecki/au/commit/9be16e83e556381c4c3d9901457c07ecdb9969ac))
* use median for compression ratio to avoid outlier skew ([c175e10](https://github.com/zbigniewsobiecki/au/commit/c175e10153869e9414fac4f071ea521ad991704f))
