import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

function trustedURL(url: string, entry: string, devURL?: string) {
  try {
    const actual = new URL(url);
    const expected = new URL(devURL || entry);
    // A document, not every page on the dev server, owns the bridge.
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname &&
      actual.search === expected.search &&
      !actual.username &&
      !actual.password
    );
  } catch {
    return false;
  }
}
function verifySender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  win: BrowserWindow | undefined,
  entry: string,
  devURL?: string,
) {
  if (
    !win ||
    win.isDestroyed() ||
    event.sender !== win.webContents ||
    !event.senderFrame ||
    event.senderFrame !== win.webContents.mainFrame ||
    !trustedURL(event.senderFrame.url, entry, devURL)
  )
    throw new Error('Untrusted IPC sender');
}
export { trustedURL, verifySender };
