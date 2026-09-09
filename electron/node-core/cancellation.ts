export class CancellationRegistry {
  private readonly operations = new Map<string, AbortController>();

  begin(operationId: string) {
    if (this.operations.has(operationId))
      throw new Error(`operation already active: ${operationId}`);
    const controller = new AbortController();
    this.operations.set(operationId, controller);
    return controller;
  }

  finish(operationId: string, controller: AbortController) {
    if (this.operations.get(operationId) === controller) this.operations.delete(operationId);
  }

  cancel(operationId: string) {
    const controller = this.operations.get(operationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  cancelAll() {
    for (const controller of this.operations.values()) controller.abort();
    this.operations.clear();
  }

  get size() {
    return this.operations.size;
  }
}

export function throwIfCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new Error('operation cancelled');
}
