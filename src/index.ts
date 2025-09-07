import * as path from 'path';

import { createFilter } from '@rollup/pluginutils';

import type { Plugin, SourceDescription } from 'rollup';
import type { Watch } from 'typescript';

import type { RollupTypescriptOptions } from '../types';

import createFormattingHost from './diagnostics/host';
import createModuleResolver from './moduleResolution';
import { getPluginOptions } from './options/plugin';
import { emitParsedOptionsErrors, parseTypescriptConfig } from './options/tsconfig';
import { validatePaths, validateSourceMap } from './options/validate';
import findTypescriptOutput, {
  getEmittedFile,
  normalizePath,
  emitFile,
  isDeclarationOutputFile,
  isTypeScriptMapOutputFile
} from './outputFile';
import { preflight } from './preflight';
import createWatchProgram, { WatchProgramHelper } from './watchProgram';
import TSCache from './tscache';
import fg from 'fast-glob';
import { parse, SFCDescriptor } from '@vue/compiler-sfc';
import { SourceMapConsumer, SourceMapGenerator } from "source-map";

export default function typescript(options: RollupTypescriptOptions = {}): Plugin {
  const {
    cacheDir,
    compilerOptions,
    exclude,
    filterRoot,
    include,
    outputToFilesystem,
    noForceEmit,
    transformers,
    tsconfig,
    tslib,
    typescript: ts
  } = getPluginOptions(options);
  const tsCache = new TSCache(cacheDir);
  const emittedFiles = new Map<string, string>();
  const watchProgramHelper = new WatchProgramHelper();
  const vueDescriptor = new Map<string, SFCDescriptor>() 

  const parsedOptions = parseTypescriptConfig(ts, tsconfig, compilerOptions, noForceEmit);

  parsedOptions.options.noEmit = false
  parsedOptions.options.verbatimModuleSyntax = false
  parsedOptions.options.isolatedModules = false

  const filter = createFilter(include || '{,**/}*.(cts|mts|ts|tsx)', exclude, {
    resolve: filterRoot ?? parsedOptions.options.rootDir
  });
  parsedOptions.fileNames = parsedOptions.fileNames.filter(filter);

  if (parsedOptions.tsConfigPath) {
    const baseUrl = parsedOptions.basePath!;
    const includePatterns: string[] = parsedOptions.tsConfigFile?.include || [];
    const excludePatterns: string[] = parsedOptions.tsConfigFile?.exclude || [];
    fg.sync(
      includePatterns.map(p => path.resolve(baseUrl, p)),
      {
        absolute: true,
        ignore: excludePatterns.map(p => path.resolve(baseUrl, p))
      }
    ).filter((fileName) => {
      if (/\.vue$/.test(fileName) && filter(fileName)) {
        const { descriptor } = parse(ts.sys.readFile(fileName, 'utf8')!)
        if (descriptor.script?.lang === 'ts'
          || descriptor.scriptSetup?.lang === 'ts'
        ) {
          vueDescriptor.set(fileName, descriptor)
          if (descriptor.script?.lang === 'ts') {
            parsedOptions.fileNames.push(fileName + '.ts')
          }
          if (descriptor.scriptSetup?.lang === 'ts') {
            parsedOptions.fileNames.push(fileName + '.setup.ts')
          }
          return true
        }
      }
      return false
    });
  }

  const formatHost = createFormattingHost(ts, parsedOptions.options);
  const resolveModule = createModuleResolver(ts, formatHost, filter);

  let program: Watch<unknown> | null = null;

  return {
    name: 'typescript',

    buildStart(rollupOptions) {
      emitParsedOptionsErrors(ts, this, parsedOptions);

      preflight({
        config: parsedOptions,
        context: this,
        // TODO drop rollup@3 support and remove
        inputPreserveModules: (rollupOptions as unknown as { preserveModules: boolean })
          .preserveModules,
        tslib
      });

      // Fixes a memory leak https://github.com/rollup/plugins/issues/322
      if (this.meta.watchMode !== true) {
        // eslint-disable-next-line
        program?.close();
        program = null;
      }
      if (!program) {
        program = createWatchProgram(ts, this, {
          formatHost,
          resolveModule,
          parsedOptions,
          writeFile(fileName, data) {
            if (parsedOptions.options.composite || parsedOptions.options.incremental) {
              tsCache.cacheCode(fileName, data);
            }
            emittedFiles.set(fileName, data);
          },
          readFile(origReadFile, fileName, encoding) {
            if (/\.vue(\.setup)?\.ts$/.test(fileName)) {
              const vueFileName = fileName.replace(/(\.setup)?\.ts$/, '')
              if (vueDescriptor.has(vueFileName)) {
                if (/\.setup\.ts$/.test(fileName)) {
                  return vueDescriptor.get(vueFileName)!.scriptSetup!.content
                }
                return vueDescriptor.get(vueFileName)!.script!.content
              }
            }
            return origReadFile(fileName, encoding)
          },
          updateVueFile(fileName, eventKind) {
            if (eventKind === ts.FileWatcherEventKind.Deleted) {
              vueDescriptor.delete(fileName)
            }
            else if (filter(fileName)) {
              const { descriptor } = parse(ts.sys.readFile(fileName, 'utf8')!)
              if (descriptor.script?.lang === 'ts'
                || descriptor.scriptSetup?.lang === 'ts'
              ) {
                vueDescriptor.set(fileName, descriptor)
              }
            }
          },
          isVueFileExit(fileName) {
            return vueDescriptor.has(fileName)
          },
          status(diagnostic) {
            watchProgramHelper.handleStatus(diagnostic);
          },
          transformers
        });
      }
    },

    watchChange(id) {
      if (!filter(id)) return;

      watchProgramHelper.watch();
    },

    buildEnd() {
      if (this.meta.watchMode !== true) {
        // ESLint doesn't understand optional chaining
        // eslint-disable-next-line
        program?.close();
      }
    },

    renderStart(outputOptions) {
      validateSourceMap(this, parsedOptions.options, outputOptions, parsedOptions.autoSetSourceMap);
      validatePaths(this, parsedOptions.options, outputOptions);
    },

    resolveId(importee, importer) {
      if (importee === 'tslib') {
        return tslib;
      }

      if (!importer) return null;

      // Convert path from windows separators to posix separators
      const containingFile = normalizePath(importer);

      // when using node16 or nodenext module resolution, we need to tell ts if
      // we are resolving to a commonjs or esnext module
      const mode =
        typeof ts.getImpliedNodeFormatForFile === 'function'
          ? ts.getImpliedNodeFormatForFile(
              // @ts-expect-error
              containingFile,
              undefined, // eslint-disable-line no-undefined
              { ...ts.sys, ...formatHost },
              parsedOptions.options
            )
          : undefined; // eslint-disable-line no-undefined

      // eslint-disable-next-line no-undefined
      const resolved = resolveModule(importee, containingFile, undefined, mode);

      if (resolved) {
        if (/\.d\.[cm]?ts/.test(resolved.extension)) return null;
        if (!filter(resolved.resolvedFileName)) return null;
        return path.normalize(resolved.resolvedFileName);
      }

      return null;
    },

    async load(id) {
      if (!filter(id)) return null;

      this.addWatchFile(id);
      await watchProgramHelper.wait();

      const fileName = normalizePath(id);
      if (!parsedOptions.fileNames.includes(fileName)) {
        // Discovered new file that was not known when originally parsing the TypeScript config
        parsedOptions.fileNames.push(fileName);
      }

      const isVue = vueDescriptor.has(id);

      if (isVue) {
        const descriptor = vueDescriptor.get(id)!
        let code = ''
        const generator = new SourceMapGenerator({ file: id });
        generator.setSourceContent(id, descriptor.source);

        let lineOffset = 0;
        let colOffset = 0;
        let last = 0
        let queue: {
          start: number
          end: number
          replace: string,
          line: number,
          column: number
          map: string
        }[] = []

        if (descriptor.script) {
          const script = findTypescriptOutput(ts, parsedOptions, id + '.ts', emittedFiles, tsCache);
          if (script.code != null) {
            queue.push({
              start: descriptor.script.loc.start.offset,
              end: descriptor.script.loc.end.offset,
              line: descriptor.script.loc.start.line,
              column: descriptor.script.loc.start.column,
              replace: script.code!,
              map: script.map as string
            })
          }
        }
        if (descriptor.scriptSetup) {
          const script = findTypescriptOutput(ts, parsedOptions, id + '.setup.ts', emittedFiles, tsCache);
          if (script.code != null) {
            queue.push({
              start: descriptor.scriptSetup.loc.start.offset,
              end: descriptor.scriptSetup.loc.end.offset,
              line: descriptor.scriptSetup.loc.start.line,
              column: descriptor.scriptSetup.loc.start.column,
              replace: script.code!,
              map: script.map as string
            })
          }
        }
        if (queue.length > 1) {
          queue.sort((a, b) => a.start - b.start)
        }
        for (let i = 0; i < queue.length; i++) {
          const item = queue[i]
          let prefix = descriptor.source.slice(last, item.start) + '\n'
          lineOffset += prefix.split("\n").length - 1
          colOffset = prefix.includes("\n")
            ? prefix.length - (prefix.lastIndexOf("\n") + 1)
            : (prefix.length + colOffset)

          code += prefix

          if (item.map) {
            const consumer = await new SourceMapConsumer(JSON.parse(item.map))
            consumer.eachMapping(function (m) {
              generator.addMapping({
                source: id,
                original: {
                  line: m.originalLine + (item.line - 1),
                  column: m.originalLine === 1 ? m.originalColumn + item.column : m.originalColumn
                },
                generated: {
                  line: m.generatedLine + lineOffset,
                  column: m.generatedLine === 1 ? m.generatedColumn + colOffset : m.generatedColumn,
                },
                name: m.name,
              });
            });
          }
          
          code += item.replace
          lineOffset += item.replace.split("\n").length - 1;
          colOffset = item.replace.includes("\n")
            ? item.replace.length - (item.replace.lastIndexOf("\n") + 1)
            : (item.replace.length + colOffset)

          last = item.end
        }

        code += descriptor.source.slice(last)

        return {
          code,
          // map: generator.toString()
        }
      }
      else {
        const output = findTypescriptOutput(ts, parsedOptions, id, emittedFiles, tsCache);
        return output.code != null ? (output as SourceDescription) : null;
      }
    },

    async generateBundle(outputOptions) {
      const declarationAndTypeScriptMapFiles = [...emittedFiles.keys()].filter(
        (fileName) => isDeclarationOutputFile(fileName) || isTypeScriptMapOutputFile(fileName)
      );

      declarationAndTypeScriptMapFiles.forEach((id) => {
        const code = getEmittedFile(id, emittedFiles, tsCache);
        if (!code || !parsedOptions.options.declaration) {
          return;
        }

        let baseDir: string | undefined;
        if (outputOptions.dir) {
          baseDir = outputOptions.dir;
        } else if (outputOptions.file) {
          // the bundle output directory used by rollup when outputOptions.file is used instead of outputOptions.dir
          baseDir = path.dirname(outputOptions.file);
        }
        if (!baseDir) return;

        this.emitFile({
          type: 'asset',
          fileName: normalizePath(path.relative(baseDir, id)),
          source: code
        });
      });

      const tsBuildInfoPath = ts.getTsBuildInfoEmitOutputFilePath(parsedOptions.options);
      if (tsBuildInfoPath) {
        const tsBuildInfoSource = emittedFiles.get(tsBuildInfoPath);
        // https://github.com/rollup/plugins/issues/681
        if (tsBuildInfoSource) {
          await emitFile(
            outputOptions,
            outputToFilesystem,
            this,
            tsBuildInfoPath,
            tsBuildInfoSource
          );
        }
      }
    }
  };
}
