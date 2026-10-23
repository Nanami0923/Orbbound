import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import rootPackage from '../package.json';
import lock from '../package-lock.json';
import windowsPackage from '../electron/windows-package.json';
import androidManifest from '../android/version.json';
import viteConfig from '../vite.config';
import type { UserConfig } from 'vite';

function injectedVersion(mode: string) {
  const config = viteConfig({ mode, command: 'build' }) as UserConfig;
  return config.define?.['import.meta.env.VITE_APP_VERSION'];
}

it('keeps Android on its independent version while Windows and default web stay on the root release', () => {
  const androidVersion = androidManifest.version;
  expect(lock.version).toBe(rootPackage.version);
  expect(lock.packages[''].version).toBe(rootPackage.version);
  expect(windowsPackage.version).toBe(rootPackage.version);

  expect(injectedVersion('android')).toBe(JSON.stringify(androidVersion));
  expect(injectedVersion('windows')).toBe(JSON.stringify(windowsPackage.version));
  expect(injectedVersion('production')).toBe(JSON.stringify(rootPackage.version));

  const manifest = readFileSync(new URL('../windows/app.manifest', import.meta.url), 'utf8');
  expect(manifest).toContain(`assemblyIdentity version="${rootPackage.version}.0"`);
});
