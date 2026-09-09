import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = path.join(workspace, 'tests', 'ssh-e2e', 'compose.yml');
const projectName = process.env.SHELLSPAN_E2E_PROJECT || 'shellspan-e2e';
const imageName = process.env.SHELLSPAN_E2E_IMAGE || 'shellspan-ssh-e2e:local';
const testFilter = process.argv.includes('--agent-native')
  ? 'isolated_ssh_sftp_end_to_end_agent_native_files'
  : 'isolated_ssh_sftp_end_to_end';
const fixtureEnv = {
  ...process.env,
  SHELLSPAN_E2E_SSH_FIXTURE: '1',
  SHELLSPAN_E2E_SSH_HOST: '127.0.0.1',
  SHELLSPAN_E2E_SSH_PORT: process.env.SHELLSPAN_E2E_SSH_PORT || '22222',
  SHELLSPAN_E2E_SSH_USERNAME: 'shellspan',
  SHELLSPAN_E2E_SSH_PASSWORD: 'shellspan-e2e',
  SHELLSPAN_E2E_SSH_JUMP_HOST: '127.0.0.1',
  SHELLSPAN_E2E_SSH_JUMP_PORT: process.env.SHELLSPAN_E2E_SSH_JUMP_PORT || '22223',
  SHELLSPAN_E2E_SSH_JUMP_TARGET_HOST: 'ssh',
  SHELLSPAN_E2E_SSH_JUMP_TARGET_PORT: '22',
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    env: options.env ?? process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

let composeAttempted = false;
let failure;
try {
  run('docker', ['build', '--tag', imageName, path.dirname(composeFile)]);
  // Set this before `up`: Docker can create part of the project and still
  // return a failure (for example, after one container becomes unhealthy).
  // The finally block must tear down that partial environment as well.
  composeAttempted = true;
  run('docker', [
    'compose',
    '--project-name',
    projectName,
    '--file',
    composeFile,
    'up',
    '--detach',
    '--wait',
    '--pull',
    'never',
  ]);
  run(
    'cargo',
    [
      'test',
      '--manifest-path',
      path.join(workspace, 'native', 'Cargo.toml'),
      '--locked',
      testFilter,
      '--',
      '--ignored',
      '--nocapture',
      '--test-threads=1',
    ],
    { env: fixtureEnv },
  );
  if (!process.argv.includes('--agent-native')) {
    run(process.execPath, ['scripts/stage4-ssh-smoke.ts'], { env: fixtureEnv });
  }
} catch (error) {
  failure = error;
} finally {
  if (composeAttempted) {
    const cleanup = spawnSync(
      'docker',
      [
        'compose',
        '--project-name',
        projectName,
        '--file',
        composeFile,
        'down',
        '--volumes',
        '--remove-orphans',
      ],
      {
        cwd: workspace,
        stdio: 'inherit',
      },
    );
    if (!failure && cleanup.error) failure = cleanup.error;
    if (!failure && cleanup.status !== 0) {
      failure = new Error(`docker compose down exited with status ${cleanup.status}`);
    }
  }
}

if (failure) throw failure;
