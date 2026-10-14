import { defineConfig } from 'vite';
import windowsManifest from './electron/windows-package.json';
import androidManifest from './package.json';

export default defineConfig(({ mode }) => ({
  base: './',
  server: {
    watch: {
      // Native builds create locked DLLs and reports while the preview is open.
      ignored: [/(^|[\\/])\.build([\\/]|$)/, /(^|[\\/])最终交付([\\/]|$)/, /(^|[\\/])android[\\/].*[\\/](build|\.gradle)([\\/]|$)/, /(^|[\\/])android[\\/]\.gradle([\\/]|$)/],
    },
  },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(mode === 'windows' ? windowsManifest.version : androidManifest.version),
  },
  build: {
    outDir: mode === 'windows' ? '.build/windows/web' : 'dist',
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
}));
