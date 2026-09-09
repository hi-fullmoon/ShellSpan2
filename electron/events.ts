const rendererEvents = Object.freeze([
  'ssh-status',
  'ssh-closed',
  'ssh-session-error',
  'upload-progress',
  'download-progress',
  'delete-progress',
  'remote-copy-progress',
  'agent-runtime-session-event',
  'port-forward-event',
  'petdex-status',
  'system-open-settings',
  'system-about',
  'system-check-update',
  'system-request-app-exit',
  'desktop-resized',
  'desktop-drag-drop',
  'desktop-update-progress',
]);
// Match the baseline event-name character set; do not invent UUID-only input
// restrictions. Core-generated session IDs are UUID v4; subscription precedes IO.
function isRendererEvent(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    (rendererEvents.includes(name) || /^ssh-data:[A-Za-z0-9_/:\-]+$/.test(name))
  );
}
export { rendererEvents, isRendererEvent };
