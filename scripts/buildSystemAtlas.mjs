import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entryPoint = resolve(repositoryRoot, 'docs/sherlock-system-atlas/app.tsx');
const targetFile = resolve(repositoryRoot, 'docs/sherlock-system-atlas.html');

const result = await build({
  entryPoints: [entryPoint],
  bundle: true,
  write: false,
  outdir: 'atlas-build',
  format: 'iife',
  platform: 'browser',
  target: ['chrome120', 'edge120', 'firefox121', 'safari17'],
  jsx: 'automatic',
  minify: true,
  legalComments: 'inline',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

const javascript = result.outputFiles.find((file) => file.path.endsWith('.js'));
const stylesheet = result.outputFiles.find((file) => file.path.endsWith('.css'));
if (javascript === undefined || stylesheet === undefined) {
  throw new Error('Atlas build did not produce both JavaScript and CSS.');
}

const sourceDescription = await readFile(resolve(repositoryRoot, 'package.json'), 'utf8');
const packageVersion = JSON.parse(sourceDescription).version;
const safeJavascript = javascript.text.replaceAll('</script', '<\\/script');
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      name="description"
      content="A progressive, data-driven atlas of the Sherlock evidence collection architecture."
    />
    <meta name="generator" content="Sherlock ${packageVersion} · scripts/buildSystemAtlas.mjs" />
    <title>Sherlock — System Atlas</title>
    <style>${stylesheet.text}</style>
  </head>
  <body>
    <div id="root"></div>
    <noscript>This architecture atlas requires JavaScript for graph layout and guided walkthroughs.</noscript>
    <script>${safeJavascript}</script>
  </body>
</html>
`.replace(/[ \t]+$/gm, '');

await writeFile(targetFile, html, 'utf8');
console.log(`Built ${targetFile} (${Buffer.byteLength(html).toLocaleString()} bytes).`);
