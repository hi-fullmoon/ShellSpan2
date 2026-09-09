import type { DesktopEvent } from './contract';
import type {
  StatusEvent,
  ClosedEvent,
  SessionErrorEvent,
  UploadProgressEvent,
  DownloadProgressEvent,
  DeleteProgressEvent,
  RemoteCopyProgressEvent,
  PortForwardRuntime,
  PetdexConnectionStatus,
} from '@/types';
import type { AgentSessionEvent } from '@/types/agent-session';
import type { DragDropEvent } from './window';
import type { DownloadEvent } from './updater';

interface Payloads {
  'ssh-status': StatusEvent;
  'ssh-closed': ClosedEvent;
  'ssh-session-error': SessionErrorEvent;
  'upload-progress': UploadProgressEvent;
  'download-progress': DownloadProgressEvent;
  'delete-progress': DeleteProgressEvent;
  'remote-copy-progress': RemoteCopyProgressEvent;
  'agent-runtime-session-event': AgentSessionEvent;
  'port-forward-event': PortForwardRuntime;
  'petdex-status': PetdexConnectionStatus;
  'system-open-settings': null;
  'system-about': null;
  'system-check-update': null;
  'system-request-app-exit': null;
  'desktop-resized': null;
  'desktop-drag-drop': DragDropEvent;
  'desktop-update-progress': DownloadEvent;
}
export type DesktopPayload<E extends DesktopEvent> = E extends `ssh-data:${string}`
  ? string
  : E extends keyof Payloads
    ? Payloads[E]
    : never;
