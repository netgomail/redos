import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const wasmPath   = resolve(__dirname, 'node_modules/yoga-wasm-web/dist/yoga.wasm');
const wrapAsmPath = resolve(__dirname, 'node_modules/yoga-wasm-web/dist/wrapAsm-f766f97f.js');
const wasmBase64 = readFileSync(wasmPath).toString('base64');

// Все поддерживаемые платформы
const TARGETS = {
  'bun-windows-x64': { outfile: 'dist/mycode.exe',     label: 'Windows x64' },
  'bun-linux-x64':   { outfile: 'dist/mycode-linux',   label: 'Linux x64'   },
  'bun-darwin-x64':  { outfile: 'dist/mycode-mac-x64', label: 'macOS x64'   },
  'bun-darwin-arm64':{ outfile: 'dist/mycode-mac-arm', label: 'macOS ARM64' },
};

// Плагин: встраивает yoga.wasm как base64
function makeYogaPlugin() {
  return {
    name: 'yoga-wasm-embed',
    setup(build) {
      build.onResolve({ filter: /^yoga-wasm-web/ }, () => ({
        path: 'yoga-wasm-embedded',
        namespace: 'yoga-embed',
      }));
      build.onLoad({ filter: /.*/, namespace: 'yoga-embed' }, () => ({
        contents: `
import initYoga from ${JSON.stringify(resolve(__dirname, 'node_modules/yoga-wasm-web/dist/index.js'))};
export * from ${JSON.stringify(wrapAsmPath)};
const Yoga = await initYoga(Buffer.from(${JSON.stringify(wasmBase64)}, 'base64'));
export default Yoga;
`.trim(),
        loader: 'js',
      }));
    },
  };
}

// Плагин: заглушка для react-devtools-core
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

async function buildTarget(target, outfile, label) {
  const result = await Bun.build({
    entrypoints: ['./src/app.jsx'],
    compile: { outfile, target },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [makeYogaPlugin(), devtoolsStubPlugin],
  });

  if (result.success) {
    const size = (readFileSync(outfile).length / 1024 / 1024).toFixed(1);
    console.log(`  v  ${label.padEnd(14)} -> ${outfile}  (${size} MB)`);
  } else {
    console.error(`  X  ${label} FAILED`);
    result.logs.forEach(l => console.error('    ', l));
  }
}

// Определяем цель из аргументов командной строки
const arg = process.argv[2]; // --all | --win | --linux | --mac | пусто = текущая платформа

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
  // По умолчанию — Windows
  await buildTarget('bun-windows-x64', 'dist/mycode.exe', 'Windows x64');
}

console.log('\n  Done!\n');
