import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readRepoFile = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('release version sources', () => {
  it('keeps Windows, Android, manifest, and package metadata on the same release', () => {
    const appVersion = JSON.parse(readRepoFile('package.json')).version as string;
    const windowsVersion = JSON.parse(readRepoFile('electron/windows-package.json')).version as string;
    const android = readRepoFile('android/app/build.gradle');
    const manifest = readRepoFile('windows/app.manifest');
    const [major, minor, patch] = appVersion.split('.').map(Number);

    expect(windowsVersion).toBe(appVersion);
    expect(android).toContain(`versionName "${appVersion}"`);
    expect(android).toContain(`versionCode ${major * 10000 + minor * 100 + patch}`);
    expect(manifest).toContain(`assemblyIdentity version="${appVersion}.0"`);
  });
});
