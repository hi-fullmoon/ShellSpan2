import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(root, 'electron/contracts/v1');
const inputDirectory = process.env.SHELLSPAN_CONTRACT_SCHEMA_INPUT;
const generator = path.join(root, 'node_modules/.bin/ts-json-schema-generator');
const tsconfig = path.join(root, 'tsconfig.json');

const definitions = [
  {
    file: 'command-args.schema.json',
    source: 'src/lib/desktop/command-types.ts',
    type: 'CommandArgs',
  },
  {
    file: 'command-values.schema.json',
    source: 'src/lib/desktop/command-types.ts',
    type: 'CommandValues',
  },
  {
    file: 'event-payloads.schema.json',
    source: 'src/lib/desktop/event-types.ts',
    type: 'DesktopEventPayloads',
  },
];

function generate(source, type) {
  return JSON.parse(
    execFileSync(
      generator,
      [
        '--path',
        path.join(root, source),
        '--type',
        type,
        '--tsconfig',
        tsconfig,
        '--no-type-check',
      ],
      { cwd: root, encoding: 'utf8' },
    ),
  );
}

function integerBounds(rustType) {
  const type = rustType.replace(/^Option<(.*)>$/, '$1');
  const unsigned = { u8: 255, u16: 65_535, u32: 4_294_967_295 };
  const signed = {
    i8: [-128, 127],
    i16: [-32_768, 32_767],
    i32: [-2_147_483_648, 2_147_483_647],
  };
  if (type in unsigned) return [0, unsigned[type]];
  if (type === 'u64' || type === 'usize') return [0, Number.MAX_SAFE_INTEGER];
  if (type in signed) return signed[type];
  if (type === 'i64' || type === 'isize') return [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  return null;
}

function applyInteger(schema, rustType) {
  const bounds = integerBounds(rustType);
  if (!bounds || !schema) return;
  if (Array.isArray(schema.type))
    schema.type = schema.type.map((type) => (type === 'number' ? 'integer' : type));
  else schema.type = 'integer';
  [schema.minimum, schema.maximum] = bounds;
}

function visitSchema(node, visitor) {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const value of Object.values(node))
    if (value && typeof value === 'object') visitSchema(value, visitor);
}

function camelCase(value) {
  return value.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function applyRustRecord(target, record) {
  if (!target || !record?.definition) return;
  const strict = record.definition.includes('deny_unknown_fields');
  if (strict)
    visitSchema(target, (node) => {
      if (node.type === 'object' && node.additionalProperties === true)
        node.additionalProperties = false;
    });
  target['x-serde-unknown-fields'] = strict ? 'deny' : 'ignore';

  const renameCamelCase = record.definition.includes('rename_all = "camelCase"');
  for (const line of record.definition.split('\n')) {
    const field = line.match(/^\s*(?:pub(?:\(crate\))?\s+)?([a-z][a-z0-9_]*):\s*([^,]+),\s*$/);
    if (!field) continue;
    const property = renameCamelCase ? camelCase(field[1]) : field[1];
    applyInteger(target.properties?.[property], field[2].trim());
  }
}

function refineSerdeCompatibility(schema, typeContract) {
  // Serde accepts unknown struct fields unless deny_unknown_fields is present.
  // JSON dictionaries use an object-valued additionalProperties and are left alone.
  visitSchema(schema, (node) => {
    if (node.type === 'object' && node.additionalProperties === false)
      node.additionalProperties = true;
  });

  for (const [name, records] of Object.entries(typeContract.rootTypes)) {
    const record = records.find((candidate) => candidate.definition);
    const target = schema.definitions[name];
    if (!record || !target) continue;
    applyRustRecord(target, record);
  }
}

await mkdir(outputDirectory, { recursive: true });
const commands = JSON.parse(await readFile(path.join(root, 'electron/contract.json'), 'utf8'));
const typeContract = JSON.parse(
  await readFile(path.join(root, 'electron/type-contract.json'), 'utf8'),
);

for (const definition of definitions) {
  const schema = inputDirectory
    ? JSON.parse(await readFile(path.join(inputDirectory, definition.file), 'utf8'))
    : generate(definition.source, definition.type);
  schema.$id = `https://shellspan.local/contracts/v1/${definition.file}`;
  schema.title = `ShellSpan desktop contract v1: ${definition.type}`;
  schema['x-shellspan-contract-version'] = 1;
  schema['x-shellspan-bootstrap-source'] = definition.source;
  refineSerdeCompatibility(schema, typeContract);
  if (definition.type !== 'CommandArgs')
    visitSchema(schema, (node) => {
      if (
        node.type === 'object' &&
        (typeof node.additionalProperties === 'boolean' ||
          (node.additionalProperties && Object.keys(node.additionalProperties).length === 0))
      )
        node.additionalProperties = false;
    });

  schema.definitions[definition.type].additionalProperties = false;

  if (definition.type === 'CommandArgs') {
    const properties = schema.definitions.CommandArgs.properties;
    for (const command of commands) {
      const commandSchema = properties[command.command];
      // Tauri's outer command argument map ignores unrelated keys. Nested
      // request records retain the stricter TypeScript/Rust object schemas.
      commandSchema.additionalProperties = true;
      for (const argument of command.args) {
        applyInteger(commandSchema.properties?.[argument.name], argument.rustType);
        const rustType = argument.rustType.replace(/^Option<(.*)>$/, '$1');
        const record = typeContract.rootTypes[rustType]?.find((candidate) => candidate.definition);
        applyRustRecord(commandSchema.properties?.[argument.name], record);
      }
    }
  }

  if (definition.type === 'DesktopEventPayloads') {
    const payloads = schema.definitions.DesktopEventPayloads;
    payloads.patternProperties = {
      '^ssh-data:[A-Za-z0-9_/.:\\-]+$': { type: 'string' },
    };
    payloads.description =
      'Fixed renderer events plus dynamic per-session ssh-data event payloads.';
  }

  await writeFile(
    path.join(outputDirectory, definition.file),
    `${JSON.stringify(schema, null, 2)}\n`,
  );
}

console.log(`Bootstrapped ${definitions.length} versioned desktop contract schemas.`);
