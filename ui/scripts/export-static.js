#!/usr/bin/env node
const path = require('path');
const { trace, flushAllTraces } = require('next/dist/trace/trace');
const exportApp = require('next/dist/export').default;

async function main() {
  const projectDir = path.resolve(__dirname, '..');
  const outDir = path.join(projectDir, 'out');
  const span = trace('supplysense-export');

  console.log('Starting static export to', outDir);
  try {
    const result = await exportApp(projectDir, {
      outdir: outDir,
      hasAppDir: false,
      silent: true,
      buildExport: false,
    }, span);
    console.log('Export completed', {
      outDir,
      result: result ? {
        byPathSize: result.byPath ? result.byPath.size : 0,
        notFoundCount: result.ssgNotFoundPaths ? result.ssgNotFoundPaths.size : 0,
      } : null,
    });
  } finally {
    span.stop();
    await flushAllTraces();
  }
}

main().catch((err) => {
  console.error('Static export failed:', err);
  process.exitCode = 1;
});

