// Build script for the extension. Bundles src/extension.ts -> dist/extension.js
// using esbuild. ssh2 has optional native deps (cpu-features, *.node) that are
// loaded inside try/catch — we mark them external so esbuild doesn't try to
// bundle them; ssh2 falls back to its pure-JS implementations at runtime.
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
    // `vscode` is provided by the runtime. The rest are ssh2's optional
    // native accelerators that are safe to omit.
    external: ['vscode', 'cpu-features', '*.node'],
  });

  if (watch) {
    await ctx.watch();
    console.log('[esbuild] watching for changes...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
