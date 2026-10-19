import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/worker/**/*.test.{js,ts}'],
    environment: 'node',
    globals: true,
  }
});
