import { defineConfig } from 'vite';

export default defineConfig({
  // Use relative base path so assets load properly on GitHub Pages under repository subpaths
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['@supabase/supabase-js', 'chart.js', 'xlsx'],
        },
      },
    },
  },
  server: {
    port: 3000,
    open: true,
  },
});
