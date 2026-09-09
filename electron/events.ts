import eventNames from './events.json';

const rendererEvents = Object.freeze(eventNames);
// Match the baseline event-name character set; do not invent UUID-only input
// restrictions. Core-generated session IDs are UUID v4; subscription precedes IO.
function isRendererEvent(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    (rendererEvents.includes(name) || /^ssh-data:[A-Za-z0-9_/:\-]+$/.test(name))
  );
}
export { rendererEvents, isRendererEvent };
