import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import commandArgsSchema from './contracts/v1/command-args.schema.json';

type CommandSchema = {
  properties?: Record<string, unknown>;
  [key: string]: unknown;
};

const schemas = commandArgsSchema.definitions.CommandArgs.properties as Record<
  string,
  CommandSchema
>;
const byName = new Map(Object.entries(schemas));
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
const validators = new Map<string, ValidateFunction>();

// Reject values that cannot cross the framed JSON Core boundary before schema
// validation. In particular, JSON.stringify must not silently turn NaN into
// null, omit functions, or recurse through a cycle.
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

function validatorFor(command: string, schema: CommandSchema) {
  let validator = validators.get(command);
  if (!validator) {
    validator = ajv.compile({
      ...schema,
      $id: `https://shellspan.local/contracts/v1/commands/${command}/args`,
      definitions: commandArgsSchema.definitions,
    });
    validators.set(command, validator);
  }
  return validator;
}

function describe(error: ErrorObject) {
  const location = error.instancePath || '/';
  if (error.keyword === 'required')
    return `${location} missing required property ${String(error.params.missingProperty)}`;
  if (error.keyword === 'additionalProperties')
    return `${location} contains unknown property ${String(error.params.additionalProperty)}`;
  return `${location} ${error.message || 'is invalid'}`;
}

function validateCommand(command: string, args: unknown) {
  const schema = byName.get(command);
  if (!schema) throw new Error('Unknown desktop command');
  validateJSON(args);
  const validate = validatorFor(command, schema);
  if (!validate(args))
    throw new Error(
      `Invalid arguments for ${command}: ${(validate.errors || []).map(describe).join('; ')}`,
    );
}

export { validateCommand, byName };
