import { createLogger } from '@/lib/logger';
import { getPlatform } from '@/lib/platform';

export const MAC_SYSTEM_MONO = 'ShellSpan macOS System Mono';

export async function prepareDesktopFonts(): Promise<void> {
  if (!window.shellspan || getPlatform() !== 'macos') return;
  // WebKit uses SF Mono for ui-monospace; Chromium falls back to Menlo.
  // Resolve the OS font before xterm's first measurement, without bundling it.
  const results = await Promise.allSettled(
    ['regular', 'italic'].map(async (style) => {
      const face = new FontFace(MAC_SYSTEM_MONO, `url("shellspan-font://system/mono-${style}")`, {
        weight: '100 900',
        style: style === 'italic' ? 'italic' : 'normal',
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const loaded = await Promise.race([
          face.load().then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), 2000);
          }),
        ]);
        if (!loaded) throw new Error('System font load timed out');
        document.fonts.add(face);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const status = results.map((result, index) => ({
    style: index === 0 ? 'regular' : 'italic',
    loaded: result.status === 'fulfilled',
  }));
  const logger = createLogger('desktop-fonts');
  if (status.every((font) => font.loaded)) logger.info('macOS system mono fonts loaded', status);
  else logger.warn('macOS system mono font unavailable; using existing fallback', status);
}
