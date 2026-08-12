import {
  analyzeBrowserBatchExperiment,
  formatBrowserBatchAnalysis,
} from './browserBatch.js';

function parseArgs(argv: string[]): { atomic: string[]; 'batch-enabled': string[] } {
  const result = { atomic: [] as string[], 'batch-enabled': [] as string[] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    if (flag !== '--atomic' && flag !== '--batch-enabled') {
      throw new Error(
        'usage: browserBatchCli.ts --atomic <result[,result...]> ' +
          '--batch-enabled <result[,result...]>',
      );
    }
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    result[flag === '--atomic' ? 'atomic' : 'batch-enabled'].push(
      ...value.split(',').filter((path) => path !== ''),
    );
  }
  return result;
}

try {
  const paths = parseArgs(process.argv.slice(2));
  console.log(formatBrowserBatchAnalysis(analyzeBrowserBatchExperiment(paths)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
