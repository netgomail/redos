// Заглушка для react-devtools-core (ink импортирует его динамически в dev-режиме,
// но Bun всё равно пытается его разрешить при сборке)
/** @type {import('bun').BunPlugin} */
const devtoolsStubPlugin = {
  name: 'devtools-stub',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'devtools-stub',
      namespace: 'stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default {}; export const connectToDevTools = () => {};',
      loader: 'js',
    }));
  },
};

const TARGET  = 'bun-linux-x64';
const OUTFILE = 'dist/redos-linux';
const LABEL   = 'Linux x64';

console.log('\n  Building РедОС...\n');

const result = await Bun.build({
  entrypoints: ['./src/app.tsx'],
  compile: { outfile: OUTFILE, target: TARGET },
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.DEV':      '"false"',
  },
  plugins: [devtoolsStubPlugin],
});

if (result.success) {
  const size = (Bun.file(OUTFILE).size / 1024 / 1024).toFixed(1);
  console.log(`  v  ${LABEL}  ->  ${OUTFILE}  (${size} MB)`);
} else {
  console.error(`  X  ${LABEL} FAILED`);
  result.logs.forEach(l => console.error('    ', l));
  process.exit(1);
}

console.log('\n  Done!\n');
