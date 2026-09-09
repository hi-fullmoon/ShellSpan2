import contracts from './contract.json';
const byName = new Map(contracts.map((c) => [c.command, c]));
// JSON encoding must never turn NaN into null or drop functions inside requests.
// Rust Deserialize remains authoritative for nested structs/enums/default/flatten.
function validateJSON(value: unknown, ancestors = new Set<object>()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || ancestors.has(value))
    throw new Error('Invalid JSON argument');
  if (!Array.isArray(value) && Object.prototype.toString.call(value) !== '[object Object]')
    throw new Error('Invalid JSON object');
  ancestors.add(value);
  for (const item of Object.values(value)) if (item !== undefined) validateJSON(item, ancestors);
  ancestors.delete(value);
}
function validateCommand(command: string, args: unknown) {
  const contract = byName.get(command);
  if (!contract) throw new Error('Unknown desktop command');
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Invalid command arguments');
  validateJSON(args);
  // Tauri extracts named arguments and ignores other keys; retain that behavior.
  // Every schema (including the four Electron-owned dialog commands) is decoded
  // by the native baseline-compatible Serde boundary. This layer only admits JSON.
}
export { validateCommand, byName };
