import { defineConfig } from 'vite';
import windowsManifest from './electron/windows-package.json';
import androidManifest from './package.json';

export default defineConfig(({ mode }) => ({
  base: './',
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
