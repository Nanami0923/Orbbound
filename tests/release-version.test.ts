import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import rootPackage from '../package.json';
import lock from '../package-lock.json';
import windowsPackage from '../electron/windows-package.json';

it('keeps both native packages and the web build on the same release version', () => {
  const version = rootPackage.version;
  const [major, minor, patch] = version.split('.').map(Number);
  expect(lock.version).toBe(version);
  expect(lock.packages[''].version).toBe(version);
  expect(windowsPackage.version).toBe(version);
  const gradle = readFileSync(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
  expect(gradle.match(/versionName\s+"([^"]+)"/)?.[1]).toBe(version);
  expect(Number(gradle.match(/versionCode\s+(\d+)/)?.[1])).toBe(major * 10000 + minor * 100 + patch);
  const manifest = readFileSync(new URL('../windows/app.manifest', import.meta.url), 'utf8');
  expect(manifest).toContain(`assemblyIdentity version="${version}.0"`);
});
