import { defineConfig } from 'vitest/config';

// Root test entry: delegates to each workspace's own vitest.config.ts
// (server: node env, web: jsdom env).
export default defineConfig({
  test: {
    projects: ['server', 'web'],
  },
});
