import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
  },
  resolve: {
    alias: {
      '@internal/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
    },
  },
});
