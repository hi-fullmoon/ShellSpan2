import { spawn } from 'node:child_process';

type RawStore = {
  set(service: string, account: string, value: string): Promise<void>;
  get(service: string, account: string): Promise<string | undefined>;
  delete(service: string, account: string): Promise<void>;
};

async function processCall(
  command: string,
  args: string[],
  input?: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
    child.stdin.end(input);
  });
}

class MemoryRawStore implements RawStore {
  private readonly values = new Map<string, string>();
  private key(service: string, account: string) {
    return `${service}\0${account}`;
  }
  async set(service: string, account: string, value: string) {
    this.values.set(this.key(service, account), value);
  }
  async get(service: string, account: string) {
    return this.values.get(this.key(service, account));
  }
  async delete(service: string, account: string) {
    this.values.delete(this.key(service, account));
  }
}

async function macKeytar() {
  const module = await import('keytar');
  return module.default || module;
}

class MacRawStore implements RawStore {
  async set(service: string, account: string, value: string) {
    const keytar = await macKeytar();
    await keytar.setPassword(service, account, value);
  }
  async get(service: string, account: string) {
    const keytar = await macKeytar();
    return (await keytar.getPassword(service, account)) ?? undefined;
  }
  async delete(service: string, account: string) {
    const keytar = await macKeytar();
    await keytar.deletePassword(service, account);
  }
}

const windowsInterop = String.raw`
using System;
using System.Runtime.InteropServices;
public static class ShellSpanCred {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct CREDENTIAL {
  public UInt32 Flags, Type; public string TargetName, Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist, AttributeCount; public IntPtr Attributes;
  public string TargetAlias, UserName;
 }
 [DllImport("advapi32", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredWrite(ref CREDENTIAL c, UInt32 f);
 [DllImport("advapi32", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredRead(string t, UInt32 ty, UInt32 f, out IntPtr c);
 [DllImport("advapi32", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CredDelete(string t, UInt32 ty, UInt32 f);
 [DllImport("advapi32", SetLastError=true)] static extern void CredFree(IntPtr p);
 public static void Write(string target,string user,string secret) {
  IntPtr blob=Marshal.StringToCoTaskMemUni(secret); try { var c=new CREDENTIAL { Type=1,TargetName=target,UserName=user,CredentialBlob=blob,CredentialBlobSize=(UInt32)(secret.Length*2),Persist=3 }; if(!CredWrite(ref c,0)) throw new System.ComponentModel.Win32Exception(); } finally { Marshal.ZeroFreeCoTaskMemUnicode(blob); }
 }
 public static string Read(string target) { IntPtr p; if(!CredRead(target,1,0,out p)) { if(Marshal.GetLastWin32Error()==1168) return null; throw new System.ComponentModel.Win32Exception(); } try { var c=(CREDENTIAL)Marshal.PtrToStructure(p,typeof(CREDENTIAL)); return Marshal.PtrToStringUni(c.CredentialBlob,(int)c.CredentialBlobSize/2); } finally { CredFree(p); } }
 public static void Delete(string target) { if(!CredDelete(target,1,0) && Marshal.GetLastWin32Error()!=1168) throw new System.ComponentModel.Win32Exception(); }
}`;

class WindowsRawStore implements RawStore {
  private target(service: string, account: string) {
    return windowsCredentialTarget(service, account);
  }
  private async call(operation: string, service: string, account: string, input?: string) {
    const script = `$ErrorActionPreference='Stop';Add-Type -TypeDefinition $env:SHELLSPAN_CRED_INTEROP;${operation}`;
    const envValue = windowsInterop;
    const childArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
      this.target(service, account),
      account,
    ];
    return processCall('powershell.exe', childArgs, input, {
      ...process.env,
      SHELLSPAN_CRED_INTEROP: envValue,
    });
  }
  async set(service: string, account: string, value: string) {
    const result = await this.call(
      `[ShellSpanCred]::Write($args[0],$args[1],[Console]::In.ReadToEnd())`,
      service,
      account,
      value,
    );
    if (result.code !== 0) throw new Error('keyring set_password failed');
  }
  async get(service: string, account: string) {
    const result = await this.call(
      `$v=[ShellSpanCred]::Read($args[0]);if($null -ne $v){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v))}`,
      service,
      account,
    );
    if (result.code !== 0) throw new Error('keyring get_password failed');
    const encoded = result.stdout.trim();
    return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : undefined;
  }
  async delete(service: string, account: string) {
    const result = await this.call(`[ShellSpanCred]::Delete($args[0])`, service, account);
    if (result.code !== 0) throw new Error('keyring delete_credential failed');
  }
}

export function windowsCredentialTarget(service: string, account: string) {
  return `${account}.${service}`;
}

export async function platformCredentialRoundTrip(service: string, account: string, value: string) {
  const store: RawStore =
    process.platform === 'darwin'
      ? new MacRawStore()
      : process.platform === 'win32'
        ? new WindowsRawStore()
        : new LinuxRawStore();
  try {
    await store.set(service, account, value);
    return (await store.get(service, account)) === value;
  } finally {
    await store.delete(service, account).catch(() => {});
  }
}

class LinuxRawStore implements RawStore {
  async set(service: string, account: string, value: string) {
    const result = await processCall(
      'secret-tool',
      ['store', `--label=keyring:${account}@${service}`, 'service', service, 'username', account],
      value,
    );
    if (result.code !== 0) throw new Error('keyring set_password failed');
  }
  async get(service: string, account: string) {
    const result = await processCall('secret-tool', [
      'lookup',
      'service',
      service,
      'username',
      account,
    ]);
    if (result.code === 1) return undefined;
    if (result.code !== 0) throw new Error('keyring get_password failed');
    return result.stdout.replace(/\r?\n$/, '');
  }
  async delete(service: string, account: string) {
    const result = await processCall('secret-tool', [
      'clear',
      'service',
      service,
      'username',
      account,
    ]);
    if (result.code !== 0 && result.code !== 1) throw new Error('keyring delete_credential failed');
  }
}

type Vault = {
  version: number;
  entries: Record<string, Record<string, string>>;
  tombstones: Record<string, string[]>;
};

export class CredentialStore {
  private readonly raw: RawStore;
  private readonly vaultService: string;
  private readonly vaultAccount: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(env: NodeJS.ProcessEnv) {
    this.raw =
      env.SHELLSPAN_CREDENTIAL_TEST_MODE === '1'
        ? new MemoryRawStore()
        : process.platform === 'darwin'
          ? new MacRawStore()
          : process.platform === 'win32'
            ? new WindowsRawStore()
            : new LinuxRawStore();
    const production = env.SHELLSPAN_BUILD_MODE === 'production';
    this.vaultService = production
      ? 'com.shellspan.credential-vault'
      : 'com.shellspan.dev.credential-vault';
    this.vaultAccount = production ? 'shellspan-v1' : 'shellspan-dev-v1';
  }

  private serialize<T>(operation: () => Promise<T>) {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }

  private async loadVault(): Promise<Vault> {
    const raw = await this.raw.get(this.vaultService, this.vaultAccount);
    if (raw === undefined) return { version: 1, entries: {}, tombstones: {} };
    let vault: Vault;
    try {
      vault = JSON.parse(raw) as Vault;
    } catch {
      throw new Error('credential vault is invalid');
    }
    if (vault.version !== 1)
      throw new Error(`unsupported credential vault version: ${vault.version}`);
    vault.entries ||= {};
    vault.tombstones ||= {};
    return vault;
  }

  private saveVault(vault: Vault) {
    return this.raw.set(this.vaultService, this.vaultAccount, JSON.stringify(vault));
  }

  private validate(service: string, account: string) {
    if (!service) throw new Error('credential service cannot be empty');
    if (!account) throw new Error('credential key cannot be empty');
    if (service === this.vaultService && account === this.vaultAccount)
      throw new Error('credential identifier is reserved for the ShellSpan vault');
  }

  set(service: string, account: string, value: string) {
    this.validate(service, account);
    return this.serialize(async () => {
      if (process.platform !== 'darwin' && !(this.raw instanceof MemoryRawStore))
        return this.raw.set(service, account, value);
      const vault = await this.loadVault();
      (vault.entries[service] ||= {})[account] = value;
      vault.tombstones[service] = (vault.tombstones[service] || []).filter(
        (key) => key !== account,
      );
      if (!vault.tombstones[service].length) delete vault.tombstones[service];
      await this.saveVault(vault);
    });
  }

  get(service: string, account: string) {
    this.validate(service, account);
    return this.serialize(async () => {
      if (process.platform !== 'darwin' && !(this.raw instanceof MemoryRawStore))
        return this.raw.get(service, account);
      const vault = await this.loadVault();
      const current = vault.entries[service]?.[account];
      if (current !== undefined) return current;
      if (vault.tombstones[service]?.includes(account)) return undefined;
      const legacy = await this.raw.get(service, account);
      if (legacy === undefined) return undefined;
      (vault.entries[service] ||= {})[account] = legacy;
      await this.saveVault(vault);
      await this.raw.delete(service, account).catch(() => {});
      return legacy;
    });
  }

  delete(service: string, account: string) {
    this.validate(service, account);
    return this.serialize(async () => {
      if (process.platform !== 'darwin' && !(this.raw instanceof MemoryRawStore))
        return this.raw.delete(service, account);
      const vault = await this.loadVault();
      if (vault.entries[service]) {
        delete vault.entries[service][account];
        if (!Object.keys(vault.entries[service]).length) delete vault.entries[service];
      }
      const tombstones = new Set(vault.tombstones[service] || []);
      tombstones.add(account);
      vault.tombstones[service] = [...tombstones].sort();
      await this.saveVault(vault);
      await this.raw.delete(service, account).catch(() => {});
    });
  }

  testSeedRaw(service: string, account: string, value: string) {
    if (!(this.raw instanceof MemoryRawStore)) throw new Error('test credential store unavailable');
    return this.raw.set(service, account, value);
  }

  testRawGet(service: string, account: string) {
    if (!(this.raw instanceof MemoryRawStore)) throw new Error('test credential store unavailable');
    return this.raw.get(service, account);
  }
}
