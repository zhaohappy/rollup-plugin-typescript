import type { PluginContext, RollupLog } from 'rollup';
import typescript from 'typescript';
import type {
  CustomTransformers,
  Diagnostic,
  EmitAndSemanticDiagnosticsBuilderProgram,
  ParsedCommandLine,
  Program,
  WatchCompilerHostOfFilesAndCompilerOptions,
  WatchStatusReporter,
  WriteFileCallback
} from 'typescript';

import type { CustomTransformerFactories } from '../types';

import { buildDiagnosticReporter } from './diagnostics/emit';
import type { DiagnosticsHost } from './diagnostics/host';
import type { Resolver } from './moduleResolution';
import { mergeTransformers } from './customTransformers';
import * as cheapTransformer from '@libmedia/cheap/build/transformer'
import path from 'path'

const { DiagnosticCategory } = typescript;
type BuilderProgram = EmitAndSemanticDiagnosticsBuilderProgram;

// @see https://github.com/microsoft/TypeScript/blob/master/src/compiler/diagnosticMessages.json
// eslint-disable-next-line no-shadow
enum DiagnosticCode {
  FILE_CHANGE_DETECTED = 6032,
  FOUND_1_ERROR_WATCHING_FOR_FILE_CHANGES = 6193,
  FOUND_N_ERRORS_WATCHING_FOR_FILE_CHANGES = 6194
}

interface CreateProgramOptions {
  /** Formatting host used to get some system functions and emit type errors. */
  formatHost: DiagnosticsHost;
  /** Parsed Typescript compiler options. */
  parsedOptions: ParsedCommandLine;
  /** Callback to save compiled files in memory. */
  writeFile: WriteFileCallback;
  readFile: (origReadFile: (path: string, encoding?: string) => string | undefined, path: string, encoding?: string) => string | undefined
  /** Callback for the Typescript status reporter. */
  status: WatchStatusReporter;
  /** Function to resolve a module location */
  resolveModule: Resolver;
  /** Custom TypeScript transformers */
  transformers?: CustomTransformerFactories | ((program: Program, getProgram?: () => Program) => CustomTransformers);

  updateVueFile: (fileName: string, eventKind: typescript.FileWatcherEventKind) => void
  isVueFileExit: (fileName: string) => boolean
}

type DeferredResolve = ((value: boolean | PromiseLike<boolean>) => void) | (() => void);

interface Deferred {
  promise: Promise<boolean | void>;
  resolve: DeferredResolve;
}

function createDeferred(timeout?: number): Deferred {
  let promise: Promise<boolean | void>;
  let resolve: DeferredResolve = () => {};

  if (timeout) {
    promise = Promise.race<boolean | void>([
      new Promise((r) => setTimeout(r, timeout, true)),
      new Promise((r) => (resolve = r))
    ]);
  } else {
    promise = new Promise((r) => (resolve = r));
  }

  return { promise, resolve };
}

/**
 * Typescript watch program helper to sync Typescript watch status with Rollup hooks.
 */
export class WatchProgramHelper {
  private _startDeferred: Deferred | null = null;
  private _finishDeferred: Deferred | null = null;

  watch(timeout = 1000) {
    // Race watcher start promise against a timeout in case Typescript and Rollup change detection is not in sync.
    this._startDeferred = createDeferred(timeout);
    this._finishDeferred = createDeferred();
  }

  handleStatus(diagnostic: Diagnostic) {
    // Fullfil deferred promises by Typescript diagnostic message codes.
    if (diagnostic.category === DiagnosticCategory.Message) {
      switch (diagnostic.code) {
        case DiagnosticCode.FILE_CHANGE_DETECTED:
          this.resolveStart();
          break;

        case DiagnosticCode.FOUND_1_ERROR_WATCHING_FOR_FILE_CHANGES:
        case DiagnosticCode.FOUND_N_ERRORS_WATCHING_FOR_FILE_CHANGES:
          this.resolveFinish();
          break;

        default:
      }
    }
  }

  resolveStart() {
    if (this._startDeferred) {
      this._startDeferred.resolve(false);
      this._startDeferred = null;
    }
  }

  resolveFinish() {
    if (this._finishDeferred) {
      this._finishDeferred.resolve(false);
      this._finishDeferred = null;
    }
  }

  async wait() {
    if (this._startDeferred) {
      const timeout = await this._startDeferred.promise;

      // If there is no file change detected by Typescript skip deferred promises.
      if (timeout) {
        this._startDeferred = null;
        this._finishDeferred = null;
      }

      await this._finishDeferred?.promise;
    }
  }
}

/**
 * Create a language service host to use with the Typescript compiler & type checking APIs.
 * Typescript hosts are used to represent the user's system,
 * with an API for reading files, checking directories and case sensitivity etc.
 * @see https://github.com/Microsoft/TypeScript/wiki/Using-the-Compiler-API
 */
function createWatchHost(
  ts: typeof typescript,
  context: PluginContext,
  {
    formatHost,
    parsedOptions,
    writeFile,
    readFile,
    status,
    resolveModule,
    updateVueFile,
    isVueFileExit,
    transformers
  }: CreateProgramOptions
): WatchCompilerHostOfFilesAndCompilerOptions<BuilderProgram> {
  const createProgram = ts.createEmitAndSemanticDiagnosticsBuilderProgram;

  const baseHost = ts.createWatchCompilerHost(
    parsedOptions.fileNames,
    parsedOptions.options,
    ts.sys,
    createProgram,
    buildDiagnosticReporter(ts, context, formatHost),
    status,
    parsedOptions.projectReferences
  );
  const origFileExists = baseHost.fileExists
  baseHost.fileExists = (filePath) => {
    if (/\.vue(\.setup)?\.ts$/.test(filePath)) {
      return isVueFileExit(filePath)
    }
    return origFileExists(filePath)
  }
  const origReadFile = baseHost.readFile
  baseHost.readFile = function (path, encoding) {
    return readFile(origReadFile, path, encoding)
  }
  const origWatchDir = baseHost.watchDirectory
  baseHost.watchDirectory = (dirPath, callback, recursive) => {
    return origWatchDir(dirPath, (fileName) => {
      if (/\.vue$/.test(fileName)) {
        if (origFileExists(fileName)) {
          updateVueFile(fileName, typescript.FileWatcherEventKind.Changed)
        }
        else {
          updateVueFile(fileName, typescript.FileWatcherEventKind.Deleted)
        }
        if (isVueFileExit(fileName + '.ts')) {
          callback(fileName + '.ts')
        }
        if (isVueFileExit(fileName + '.setup.ts')) {
          callback(fileName + '.setup.ts')
        }
      }
      else {
        callback(fileName)
      }
    }, recursive)
  }
  const origWatchFile = baseHost.watchFile
  const vueFileHasWatcher = new Map<string, boolean>()
  const fileHasWatcher = new Map<string, boolean>()
  baseHost.watchFile = (filePath, callback, pollingInterval, options) => {
    if (/\.vue(\.setup)?\.ts$/.test(filePath)) {
      const vueFileName = filePath.replace(/(\.setup)?\.ts$/, '')
      const needUpdate = !vueFileHasWatcher.has(vueFileName)
      vueFileHasWatcher.set(vueFileName, true)
      fileHasWatcher.set(filePath, true)
      return origWatchFile(vueFileName, (fileName, eventKind, modifiedTime) => {
        if (needUpdate) {
          updateVueFile(fileName, eventKind)
          if (eventKind === typescript.FileWatcherEventKind.Deleted) {
            vueFileHasWatcher.delete(fileName)
          }
        }
        if (isVueFileExit(filePath)) {
          callback(filePath, eventKind, modifiedTime)
        }
        else {
          callback(filePath, typescript.FileWatcherEventKind.Deleted, modifiedTime)
          fileHasWatcher.delete(filePath)
        }
      }, pollingInterval, options)
    }
    return origWatchFile(filePath, callback, pollingInterval, options)
  }

  let createdTransformers: CustomTransformers | undefined;
  let currentProgram: typescript.EmitAndSemanticDiagnosticsBuilderProgram;
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  // @ts-ignore
  const writer = ts.createTextWriter ? ts.createTextWriter('\n') : null
  return {
    ...baseHost,
    /** Override the created program so an in-memory emit is used */
    afterProgramCreate(program) {
      currentProgram = program
      const origEmit = program.emit;
      // eslint-disable-next-line no-param-reassign
      program.emit = (
        targetSourceFile,
        _,
        cancellationToken,
        emitOnlyDtsFiles,
        customTransformers
      ) => {
        if (!createdTransformers) {
          // @ts-ignore
          let beforeFactory = cheapTransformer.default ?
          // @ts-ignore
            cheapTransformer.default.before
            : cheapTransformer.before
          const before = beforeFactory(program.getProgram(), {
            reportError(error: any) {
              const warning: RollupLog = {
                pluginCode: `TS${error.code}`,
                message: `@libmedia/rollup-plugin-typescript ${error.code}: ${error.message}`,
                loc: {
                  column: error.loc.start.column,
                  line: error.loc.start.line,
                  file: error.file
                }
              }
              console.error('\x1b[31m%s\x1b[0m', warning.message)
              // context.error(warning)
            },
          }, () => {
            return currentProgram.getProgram()
          })
          const cheapTransformers: CustomTransformerFactories = {
            before: [
              (context) => {
                const f = before(context)
                return (sourceFile) => {
                  let transformedFile = f(sourceFile)
                  if (/\.vue(\.setup)?\.ts$/.test(sourceFile.fileName)) {
                    const typeCheaker = currentProgram.getProgram().getTypeChecker()
                    const used = new Set<string>()
                    const constEnumVisitor = (node: typescript.Node): typescript.Node => {
                      if (ts.isImportDeclaration(node)) {
                        return node
                      }
                      if (ts.isPropertyAccessExpression(node)) {
                        const type = typeCheaker.getTypeAtLocation(node.expression)
                        const value = typeCheaker.getTypeAtLocation(node.name)
                        if (type.symbol?.valueDeclaration
                          && ts.isEnumDeclaration(type.symbol.valueDeclaration)
                          && type.symbol.valueDeclaration.modifiers?.some((m) => {
                            return m.kind === ts.SyntaxKind.ConstKeyword
                          })
                          && value.isNumberLiteral()
                        ) {
                          return context.factory.createNumericLiteral(value.value)
                        }
                      }
                      if (ts.isIdentifier(node)) {
                        const sym = typeCheaker.getSymbolAtLocation(node)
                        if (sym && sym.valueDeclaration) {
                          if (sym.valueDeclaration.getSourceFile() !== sourceFile) {
                            used.add(node.text)
                          }
                        }
                        else {
                          used.add(node.text)
                        }
                      }
                      return ts.visitEachChild(node, constEnumVisitor, context)
                    }
                    const importVisitor = (node: typescript.Node): typescript.Node | undefined => {
                      if (ts.isImportDeclaration(node) && node.importClause) {
                        const clause = node.importClause;

                        // 默认导入
                        if (clause.name && !used.has(clause.name.text)) {
                          return undefined
                        }

                        // 解构导入 { a, b }
                        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                          const newElements = clause.namedBindings.elements.filter(
                            (el) => used.has(el.name.text)
                          );
                          if (newElements.length === 0) {
                            return undefined
                          }
                        }
                        else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
                          // import * as ns from "xx"
                          if (!used.has(clause.namedBindings.name.text)) {
                            return undefined
                          }
                        }
                      }
                      return node
                    }
                    transformedFile = ts.visitEachChild(transformedFile, constEnumVisitor, context)
                    transformedFile = ts.visitEachChild(transformedFile, importVisitor, context)
                    // @ts-ignore
                    if (writer && ts.createSourceMapGenerator && printer.writeFile && parsedOptions.options.sourceMap) {
                      // @ts-ignore
                      const mapGenerator = ts.createSourceMapGenerator(
                        currentProgram.getProgram(),
                        path.basename(sourceFile.fileName),
                        '',
                        '',
                        currentProgram.getProgram().getCompilerOptions()
                      )
                      // @ts-ignore
                      printer.writeFile(transformedFile, writer, mapGenerator)
                      writeFile(sourceFile.fileName.replace(/\.ts$/, '.js'), writer.getText(), false)
                      writeFile(sourceFile.fileName.replace(/\.ts$/, '.js.map'), mapGenerator.toString(), false)
                      writer.clear()
                    }
                    else {
                      writeFile(sourceFile.fileName.replace(/\.ts$/, '.js'), printer.printFile(transformedFile), false)
                    }
                  }
                  return transformedFile
                }
              }
            ]
          }
          createdTransformers = typeof transformers === 'function'
            ? transformers(program.getProgram(), () => {
              return currentProgram.getProgram()
            })
            : mergeTransformers(
                program,
                () => {
                  return currentProgram.getProgram()
                },
                cheapTransformers,
                transformers,
                customTransformers as CustomTransformerFactories
              );
        }
        return origEmit(
          targetSourceFile,
          (filename, data, writeByteOrderMark) => {
            if (!/\.vue(\.setup)?\.js$/.test(filename)) {
              writeFile(filename, data, writeByteOrderMark)
            }
          },
          cancellationToken,
          emitOnlyDtsFiles,
          createdTransformers
        );
      };

      return baseHost.afterProgramCreate!(program);
    },
    /** Add helper to deal with module resolution */
    resolveModuleNames(
      moduleNames,
      containingFile,
      _reusedNames,
      redirectedReference,
      _optionsOnlyWithNewerTsVersions,
      containingSourceFile
    ) {
      return moduleNames.map((moduleName, i) => {
        const mode = containingSourceFile
          ? ts.getModeForResolutionAtIndex?.(containingSourceFile, i)
          : undefined; // eslint-disable-line no-undefined

        return resolveModule(moduleName, containingFile, redirectedReference, mode);
      });
    }
  };
}

export default function createWatchProgram(
  ts: typeof typescript,
  context: PluginContext,
  options: CreateProgramOptions
) {
  return ts.createWatchProgram(createWatchHost(ts, context, options));
}
