import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/client/**/*.test.{js,ts}'],
    environment: 'happy-dom',
    globals: true,
  }
});
