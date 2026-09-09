import { desktop } from './core';
import { listen, type EventCallback, type UnlistenFn } from './event';

export type DragDropEvent =
  | { type: 'enter' | 'over'; position: { x: number; y: number }; paths: string[] }
  | { type: 'leave' }
  | { type: 'drop'; position: { x: number; y: number }; paths: string[] };
const currentWindow = {
  minimize: async (): Promise<void> => {
    await desktop().window('minimize');
  },
  maximize: async (): Promise<void> => {
    await desktop().window('maximize');
  },
  unmaximize: async (): Promise<void> => {
    await desktop().window('unmaximize');
  },
  close: async (): Promise<void> => {
    await desktop().window('close');
  },
  isMaximized: async (): Promise<boolean> => Boolean(await desktop().window('isMaximized')),
  onResized: (callback: EventCallback<unknown>): Promise<UnlistenFn> =>
    listen('desktop-resized', callback),
  onDragDropEvent: async (callback: EventCallback<DragDropEvent>): Promise<UnlistenFn> => {
    let depth = 0;
    const emit = (payload: DragDropEvent): void =>
      callback({ event: 'desktop-drag-drop', id: 0, payload });
    const fileDrag = (event: DragEvent): boolean =>
      Boolean(event.dataTransfer?.types.includes('Files'));
    const enter = (event: DragEvent): void => {
      if (!fileDrag(event)) return;
      event.preventDefault();
      depth++;
      emit({ type: 'enter', paths: [], position: { x: event.clientX, y: event.clientY } });
    };
    const over = (event: DragEvent): void => {
      if (!fileDrag(event)) return;
      event.preventDefault();
      emit({ type: 'over', paths: [], position: { x: event.clientX, y: event.clientY } });
    };
    const leave = (event: DragEvent): void => {
      if (!fileDrag(event)) return;
      if (--depth <= 0) {
        depth = 0;
        emit({ type: 'leave' });
      }
    };
    const drop = (event: DragEvent): void => {
      if (!fileDrag(event)) return;
      event.preventDefault();
      depth = 0;
      const paths = Array.from(event.dataTransfer?.files ?? [])
        .map((file) => desktop().filePath(file))
        .filter(Boolean);
      emit({ type: 'drop', paths, position: { x: event.clientX, y: event.clientY } });
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  },
};
export const getCurrentWindow = (): typeof currentWindow => currentWindow;
export const getCurrentWebviewWindow = getCurrentWindow;
