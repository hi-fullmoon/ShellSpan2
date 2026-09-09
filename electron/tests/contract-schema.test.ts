import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import Ajv from 'ajv';
import argsSchema from '../contracts/v1/command-args.schema.json';
import valuesSchema from '../contracts/v1/command-values.schema.json';
import eventSchema from '../contracts/v1/event-payloads.schema.json';
import manifest from '../contracts/v1/manifest.json';
import serdeCases from '../../native/tests/fixtures/tauri-argument-cases.json';

const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });

function compileProperty(
  schema: { definitions: Record<string, unknown> },
  rootName: string,
  property: string,
) {
  const root = schema.definitions[rootName] as {
    properties: Record<string, unknown>;
    patternProperties?: Record<string, unknown>;
  };
  const propertySchema = root.properties[property];
  assert.ok(propertySchema, `Missing ${rootName}.${property}`);
  return ajv.compile({ ...propertySchema, definitions: schema.definitions });
}

test('contract v1 covers every command and renderer event', () => {
  const args = Object.keys(argsSchema.definitions.CommandArgs.properties);
  const values = Object.keys(valuesSchema.definitions.CommandValues.properties);
  const events = Object.keys(eventSchema.definitions.DesktopEventPayloads.properties);
  assert.equal(args.length, 141);
  assert.deepEqual(args, values);
  assert.equal(events.length, 17);
  assert.equal(manifest.commandCount, 141);
  assert.equal(manifest.fixedEventCount, 17);
  assert.deepEqual(
    manifest.commands.map((command) => command.name),
    args,
  );
  for (const schema of [argsSchema, valuesSchema, eventSchema])
    assert.doesNotThrow(() => ajv.compile(schema));
});

test('command schemas preserve outer compatibility and strict nested records', () => {
  const resize = compileProperty(argsSchema, 'CommandArgs', 'resize_session');
  assert.equal(resize({ sessionId: 's', cols: 80, rows: 24, ignored: true }), true);
  assert.equal(resize({ sessionId: 's', cols: -1, rows: 24 }), false);
  assert.equal(resize({ sessionId: 's', cols: 1.5, rows: 24 }), false);
  assert.equal(resize({ sessionId: 's', cols: 2 ** 32, rows: 24 }), false);

  const createSession = compileProperty(argsSchema, 'CommandArgs', 'create_session');
  assert.equal(
    createSession({
      request: {
        name: 'fixture',
        host: '127.0.0.1',
        port: 22,
        username: 'user',
        authMethod: 'password',
        terminalCols: 80,
        terminalRows: 24,
        ignoredBySerde: true,
      },
    }),
    true,
  );

  const saveRoutes = compileProperty(argsSchema, 'CommandArgs', 'ai_save_routes');
  assert.equal(
    saveRoutes({ input: { routes: [], expectedRevision: 0, deniedBySerde: true } }),
    false,
  );
});

test('the versioned schema retains the 24 recorded Tauri/Serde boundary outcomes', () => {
  const schemas = {
    string_arg: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: true,
    },
    optional_arg: {
      type: 'object',
      properties: { value: { type: ['string', 'null'] } },
      additionalProperties: true,
    },
    integer_arg: {
      type: 'object',
      properties: { value: { type: 'integer', minimum: 0, maximum: 65_535 } },
      required: ['value'],
      additionalProperties: true,
    },
    tuple_arg: {
      type: 'object',
      properties: {
        value: {
          type: 'array',
          items: {
            type: 'array',
            items: [{ type: 'string' }, { type: 'string' }],
            additionalItems: false,
            minItems: 2,
            maxItems: 2,
          },
        },
      },
      required: ['value'],
      additionalProperties: true,
    },
    nested_arg: {
      type: 'object',
      properties: {
        value: {
          type: 'object',
          properties: {
            port: { type: 'integer', minimum: 0, maximum: 65_535 },
            title: { type: ['string', 'null'] },
          },
          required: ['port'],
          additionalProperties: false,
        },
      },
      required: ['value'],
      additionalProperties: true,
    },
  } as const;
  const validators = Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]),
  );
  assert.equal(serdeCases.length, 24);
  for (const fixture of serdeCases)
    assert.equal(
      validators[fixture.command](fixture.args),
      'Ok' in fixture.baseline,
      `${fixture.command}: ${JSON.stringify(fixture.args)}`,
    );
});

test('representative values and event payloads use contract schemas', () => {
  assert.equal(compileProperty(valuesSchema, 'CommandValues', 'list_profiles')([]), true);
  assert.equal(compileProperty(valuesSchema, 'CommandValues', 'list_profiles')({}), false);
  assert.equal(compileProperty(eventSchema, 'DesktopEventPayloads', 'system-about')(null), true);
  assert.equal(compileProperty(eventSchema, 'DesktopEventPayloads', 'system-about')(''), false);
  const dynamic = eventSchema.definitions.DesktopEventPayloads.patternProperties;
  assert.deepEqual(Object.values(dynamic), [{ type: 'string' }]);
});
