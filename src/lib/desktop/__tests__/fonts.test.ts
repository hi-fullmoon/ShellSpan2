import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareDesktopFonts } from '../fonts';

const { platform, info, warn } = vi.hoisted(() => ({
  platform: vi.fn(() => 'macos'),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@/lib/platform', () => ({ getPlatform: platform }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info, warn }) }));
const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window.shellspan;
  vi.clearAllMocks();
  platform.mockReturnValue('macos');
  if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
  else Reflect.deleteProperty(document, 'fonts');
});
describe('desktop system font preparation', () => {
  it('waits for slow regular font after italic failure, before first terminal measurement', async () => {
    window.shellspan = {} as NonNullable<Window['shellspan']>;
    const add = vi.fn();
    Object.defineProperty(document, 'fonts', { configurable: true, value: { add } });
    let complete!: () => void;
    class Face {
      style: string;
      constructor(_name: string, _url: string, options: { style: string }) {
        this.style = options.style;
      }
      load() {
        return this.style === 'italic'
          ? Promise.reject(new Error('missing italic'))
          : new Promise<this>((resolve) => {
              complete = () => resolve(this);
            });
      }
    }
    vi.stubGlobal('FontFace', Face);
    let ready = false;
    const loading = prepareDesktopFonts().then(() => {
      ready = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(add).not.toHaveBeenCalled();
    complete();
    await loading;
    expect(ready).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.any(String), [
      { style: 'regular', loaded: true },
      { style: 'italic', loaded: false },
    ]);
  });
  it('bounds startup and never adds a font that finishes after the deadline', async () => {
    vi.useFakeTimers();
    window.shellspan = {} as NonNullable<Window['shellspan']>;
    const add = vi.fn();
    Object.defineProperty(document, 'fonts', { configurable: true, value: { add } });
    const finish: Array<() => void> = [];
    class Face {
      load() {
        return new Promise<this>((resolve) => finish.push(() => resolve(this)));
      }
    }
    vi.stubGlobal('FontFace', Face);
    const loading = prepareDesktopFonts();
    await vi.advanceTimersByTimeAsync(2000);
    await loading;
    expect(add).not.toHaveBeenCalled();
    finish.forEach((f) => f());
    await Promise.resolve();
    await Promise.resolve();
    expect(add).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
  it('keeps Windows and non-desktop pages on the original fallback', async () => {
    const constructor = vi.fn();
    vi.stubGlobal('FontFace', constructor);
    await prepareDesktopFonts();
    window.shellspan = {} as NonNullable<Window['shellspan']>;
    platform.mockReturnValue('windows');
    await prepareDesktopFonts();
    expect(constructor).not.toHaveBeenCalled();
  });
});
