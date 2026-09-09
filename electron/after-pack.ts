import type { AfterPackContext } from 'electron-builder';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export default async function afterPack(context: AfterPackContext) {
  const expected = ({ 1: 'x64', 3: 'arm64' } as Record<number, string>)[context.arch];
  const native = path.join(
    context.appOutDir,
    context.electronPlatformName === 'darwin'
      ? `${context.packager.appInfo.productFilename}.app/Contents/Resources/native/shellspan-core`
      : 'resources/native/shellspan-core.exe',
  );
  if (['darwin', 'win32'].includes(context.electronPlatformName)) {
    const bytes = await fs.readFile(native);
    let architecture;
    if (context.electronPlatformName === 'darwin') {
      if (bytes.readUInt32LE(0) !== 0xfeedfacf)
        throw new Error('Expected a thin 64-bit native Mach-O');
      architecture = ({ 16777228: 'arm64', 16777223: 'x64' } as Record<number, string>)[
        bytes.readUInt32LE(4)
      ];
      await fs.chmod(native, 0o755);
    } else {
      const offset = bytes.readUInt32LE(0x3c);
      if (bytes.toString('ascii', 0, 2) !== 'MZ' || bytes.readUInt32LE(offset) !== 0x4550)
        throw new Error('Expected a native PE executable');
      architecture = ({ 34404: 'x64', 43620: 'arm64' } as Record<number, string>)[
        bytes.readUInt16LE(offset + 4)
      ];
    }
    if (!expected || architecture !== expected)
      throw new Error(
        `Native core architecture ${architecture} does not match Electron ${expected}`,
      );
  }
  if (context.electronPlatformName !== 'darwin') return;
  // B's generated .app declares English and has no localized native resources.
  // Keep Chromium's framework locale resources (and the React locale) intact.
  const resources = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Resources',
  );
  for (const name of await fs.readdir(resources)) {
    if (name.endsWith('.lproj') && name !== 'en.lproj')
      await fs.rm(path.join(resources, name), { recursive: true, force: true });
  }
}
