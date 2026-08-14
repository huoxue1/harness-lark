import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: 'esm',
  target: 'node22',
  platform: 'node',
  clean: true,
  outDir: 'lib',
  dts: true,
  deps: {
    neverBundle: [
      /^@larksuiteoapi\//,
      /^@deepseek-ai\//,
      /^node:/,
    ],
  },
});
