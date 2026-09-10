import type { AfterPackContext } from 'electron-builder';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export default async function afterPack(context: AfterPackContext) {
  const resourceDirectory =
    context.electronPlatformName === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources',
        )
      : path.join(context.appOutDir, 'resources');
  const obsoleteCore = path.join(resourceDirectory, 'native');
  await fs.access(obsoleteCore).then(
    () => {
      throw new Error('Obsolete standalone Core resource was packaged');
    },
    () => {},
  );
  if (context.electronPlatformName !== 'darwin') return;
  // B's generated .app declares English and has no localized native resources.
  // Keep Chromium's framework locale resources (and the React locale) intact.
  for (const name of await fs.readdir(resourceDirectory)) {
    if (name.endsWith('.lproj') && name !== 'en.lproj')
      await fs.rm(path.join(resourceDirectory, name), { recursive: true, force: true });
  }
}
