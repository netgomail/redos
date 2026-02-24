// Заглушка для react-devtools-core (ink импортирует его динамически в dev-режиме,
// но Bun всё равно пытается его разрешить при сборке)
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

// Все поддерживаемые платформы
const TARGETS = {
  'bun-windows-x64':  { outfile: 'dist/mycode.exe',     label: 'Windows x64' },
  'bun-linux-x64':    { outfile: 'dist/mycode-linux',   label: 'Linux x64'   },
  'bun-darwin-x64':   { outfile: 'dist/mycode-mac-x64', label: 'macOS x64'   },
  'bun-darwin-arm64': { outfile: 'dist/mycode-mac-arm', label: 'macOS ARM64' },
};

async function buildTarget(target, outfile, label) {
  const result = await Bun.build({
    entrypoints: ['./src/app.jsx'],
    compile: { outfile, target },
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.DEV':      '"false"',
    },
    plugins: [devtoolsStubPlugin],
  });

  if (result.success) {
    const { readFileSync } = await import('fs');
    const size = (readFileSync(outfile).length / 1024 / 1024).toFixed(1);
    console.log(`  v  ${label.padEnd(14)} -> ${outfile}  (${size} MB)`);
  } else {
    console.error(`  X  ${label} FAILED`);
    result.logs.forEach(l => console.error('    ', l));
  }
}

const arg = process.argv[2]; // --all | --linux | --mac | (пусто = Windows)

console.log('\n  Building MyCode...\n');

if (arg === '--all') {
  for (const [target, { outfile, label }] of Object.entries(TARGETS)) {
    await buildTarget(target, outfile, label);
  }
} else if (arg === '--linux') {
  await buildTarget('bun-linux-x64', 'dist/mycode-linux', 'Linux x64');
} else if (arg === '--mac') {
  await buildTarget('bun-darwin-x64',   'dist/mycode-mac-x64', 'macOS x64');
  await buildTarget('bun-darwin-arm64', 'dist/mycode-mac-arm', 'macOS ARM64');
} else {
  await buildTarget('bun-windows-x64', 'dist/mycode.exe', 'Windows x64');
}

console.log('\n  Done!\n');
