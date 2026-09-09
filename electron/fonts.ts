import * as fs from 'node:fs/promises';

const files: Record<string, string> = {
  '/mono-regular': '/System/Library/Fonts/SFNSMono.ttf',
  '/mono-italic': '/System/Library/Fonts/SFNSMonoItalic.ttf',
};
async function fontResponse(
  request: Pick<Request, 'url' | 'method'>,
  platform: NodeJS.Platform = process.platform,
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>> = fs.readFile,
) {
  const url = new URL(request.url);
  if (
    platform !== 'darwin' ||
    request.method !== 'GET' ||
    url.hostname !== 'system' ||
    url.search ||
    !Object.hasOwn(files, url.pathname)
  )
    return new Response(null, { status: 404 });
  try {
    return new Response(await readFile(files[url.pathname]), {
      headers: { 'Content-Type': 'font/ttf', 'Access-Control-Allow-Origin': '*' },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
export { fontResponse };
