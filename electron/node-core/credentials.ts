import { CredentialStore } from './credential-store.ts';
import type { StorageClient } from './storage.ts';

type KeyRequest = {
  id: string;
  label: string;
  kind: 'password' | 'keyfile';
  privateKey?: string | null;
  publicKey?: string | null;
  keyType?: string | null;
};

export class CredentialManager {
  readonly keyService: string;
  readonly passwordService: string;
  readonly profileSecretService: string;
  readonly aiService: string;

  constructor(
    env: NodeJS.ProcessEnv,
    private readonly storage: StorageClient,
    private readonly store = new CredentialStore(env),
  ) {
    const production = env.SHELLSPAN_BUILD_MODE === 'production';
    this.keyService = production ? 'com.shellspan.key' : 'com.shellspan.dev.key';
    this.passwordService = production
      ? 'com.shellspan.profile-password'
      : 'com.shellspan.dev.profile-password';
    this.profileSecretService = production
      ? 'com.shellspan.profile-secret'
      : 'com.shellspan.dev.profile-secret';
    this.aiService = production ? 'com.shellspan.ai-provider' : 'com.shellspan.dev.ai-provider';
  }

  private secretAccount(profileId: string, kind: string) {
    return `${profileId}:${kind}`;
  }

  private detectKeyType(privateKey: string) {
    let normalized = privateKey.toLowerCase();
    if (normalized.includes('-----begin openssh private key-----')) {
      try {
        normalized = Buffer.from(
          privateKey
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(
              (line) => line && !line.startsWith('-----BEGIN') && !line.startsWith('-----END'),
            )
            .join(''),
          'base64',
        )
          .toString('utf8')
          .toLowerCase();
      } catch {}
    }
    if (normalized.includes('-----begin rsa private key-----') || normalized.includes('ssh-rsa'))
      return 'rsa';
    if (normalized.includes('-----begin ec private key-----') || normalized.includes('ecdsa-sha2'))
      return 'ecdsa';
    if (normalized.includes('ssh-ed25519')) return 'ed25519';
    if (normalized.includes('-----begin dsa private key-----') || normalized.includes('ssh-dss'))
      return 'dsa';
    return 'unknown';
  }

  async command(name: string, args: Record<string, unknown>) {
    switch (name) {
      case 'store_profile_password': {
        const profileId = args.profileId as string;
        const previous = await this.store.get(this.passwordService, profileId);
        await this.store.set(this.passwordService, profileId, args.password as string);
        try {
          const profile = await this.storage.invoke<{ name?: string } | null>('__db_get_profile', {
            id: profileId,
          });
          await this.storage.invoke('__db_upsert_key_credential', {
            id: profileId,
            label: profile?.name || profileId,
            keyType: 'profile',
            kind: 'password',
            service: 'com.shellspan.profile-password',
            updatedAt: Date.now(),
          });
        } catch (error) {
          if (previous === undefined) await this.store.delete(this.passwordService, profileId);
          else await this.store.set(this.passwordService, profileId, previous);
          throw error;
        }
        return null;
      }
      case 'retrieve_profile_password':
        return (await this.store.get(this.passwordService, args.profileId as string)) ?? null;
      case 'delete_profile_password':
        await this.store.delete(this.passwordService, args.profileId as string);
        await this.storage.invoke('__db_delete_key_metadata', {
          id: args.profileId,
          service: 'com.shellspan.profile-password',
        });
        return null;
      case 'store_profile_secret':
        await this.store.set(
          this.profileSecretService,
          this.secretAccount(args.profileId as string, args.kind as string),
          args.value as string,
        );
        return null;
      case 'retrieve_profile_secret':
        return (
          (await this.store.get(
            this.profileSecretService,
            this.secretAccount(args.profileId as string, args.kind as string),
          )) ?? null
        );
      case 'delete_profile_secret':
        await this.store.delete(
          this.profileSecretService,
          this.secretAccount(args.profileId as string, args.kind as string),
        );
        return null;
      case 'delete_profile_secrets':
        await this.store.delete(this.passwordService, args.profileId as string);
        for (const kind of ['passphrase', 'jump-password', 'jump-passphrase'])
          await this.store.delete(
            this.profileSecretService,
            this.secretAccount(args.profileId as string, kind),
          );
        await this.storage.invoke('__db_delete_key_metadata', {
          id: args.profileId,
          service: 'com.shellspan.profile-password',
        });
        return null;
      case 'store_key_credential':
        return this.storeKey(args.request as KeyRequest);
      case 'retrieve_key_credential':
        return this.retrieveKey(args.id as string);
      case 'list_key_credentials':
        return this.storage.invoke('__db_list_key_credentials');
      case 'delete_key_credential':
        return this.deleteKey(args.id as string);
      default:
        throw new Error(`Unknown credential command: ${name}`);
    }
  }

  private async storeKey(request: KeyRequest) {
    if (request.kind !== 'keyfile')
      throw new Error('generic key credentials must contain a private key file');
    if (!request.id.trim()) throw new Error('key credential id cannot be empty');
    if (!request.label.trim()) throw new Error('key credential label cannot be empty');
    if (!request.privateKey?.trim()) throw new Error('key credential private key cannot be empty');
    const keyType =
      request.keyType && request.keyType !== 'unknown'
        ? request.keyType
        : this.detectKeyType(request.privateKey);
    const updatedAt = Date.now();
    const payload = JSON.stringify({
      kind: 'keyFile',
      label: request.label,
      privateKey: request.privateKey ?? null,
      publicKey: request.publicKey ?? null,
      keyType,
      updatedAt,
    });
    const previous = await this.store.get(this.keyService, request.id);
    await this.store.set(this.keyService, request.id, payload);
    try {
      await this.storage.invoke('__db_upsert_key_credential', {
        id: request.id,
        label: request.label,
        keyType,
        kind: 'keyFile',
        service: 'com.shellspan.key',
        publicKey: request.publicKey ?? null,
        updatedAt,
      });
    } catch (error) {
      if (previous === undefined) await this.store.delete(this.keyService, request.id);
      else await this.store.set(this.keyService, request.id, previous);
      throw error;
    }
    return null;
  }

  private async retrieveKey(id: string) {
    const raw = await this.store.get(this.keyService, id);
    if (raw === undefined) return null;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error('failed to parse key credential');
    }
    return {
      id,
      label: typeof value.label === 'string' ? value.label : id,
      kind: value.kind === 'password' ? 'password' : 'keyfile',
      privateKey: typeof value.privateKey === 'string' ? value.privateKey : null,
      publicKey: typeof value.publicKey === 'string' ? value.publicKey : null,
      keyType: typeof value.keyType === 'string' ? value.keyType : 'unknown',
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    };
  }

  private async deleteKey(id: string) {
    const service =
      (await this.storage.invoke<string | null>('__db_key_service', { id })) || 'com.shellspan.key';
    await this.store.delete(service === 'com.shellspan.key' ? this.keyService : service, id);
    await this.storage.invoke('__db_delete_key', { id });
    return service === 'com.shellspan.key'
      ? this.storage.invoke<string[]>('__db_delete_key_references', { id })
      : [];
  }

  async migrateInlineApiKeys() {
    const preferences = await this.storage.invoke<Array<[string, string]>>('load_preferences');
    if (
      preferences.some(([key, value]) => key === 'ai.apiKeyStorageMigrationV4' && value === 'true')
    )
      return 0;
    const raw = preferences.find(([key]) => key === 'ai.providers')?.[1];
    if (raw === undefined) {
      await this.storage.invoke('save_preferences', {
        entries: [['ai.apiKeyStorageMigrationV4', 'true']],
      });
      return 0;
    }
    let providers: unknown;
    try {
      providers = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `invalid stored AI providers: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Array.isArray(providers))
      throw new Error('invalid stored AI providers: expected an array');
    const ids = new Set<string>();
    const pending: Array<[string, string]> = [];
    let changed = false;
    for (const item of providers) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const provider = item as Record<string, unknown>;
      const id = typeof provider.id === 'string' ? provider.id.trim() : '';
      if (!id) throw new Error('cannot migrate a legacy AI API key without a provider id');
      if (id.length > 80 || !/^[A-Za-z0-9_.-]+$/.test(id))
        throw new Error('AI provider id is invalid');
      if (ids.has(id)) throw new Error(`cannot migrate duplicate AI provider id: ${id}`);
      ids.add(id);
      const inline = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
      if ('apiKey' in provider) {
        delete provider.apiKey;
        changed = true;
      }
      if (inline && !(await this.store.get(this.aiService, id))?.trim()) pending.push([id, inline]);
    }
    for (const [id, secret] of pending) await this.store.set(this.aiService, id, secret);
    if (changed)
      await this.storage.invoke('save_preferences', {
        entries: [['ai.providers', JSON.stringify(providers)]],
      });
    await this.storage.invoke('save_preferences', {
      entries: [['ai.apiKeyStorageMigrationV4', 'true']],
    });
    return pending.length;
  }

  testSeedLegacy(service: string, account: string, value: string) {
    return this.store.testSeedRaw(service, account, value);
  }

  testRead(service: string, account: string) {
    return this.store.get(service, account);
  }

  testRawRead(service: string, account: string) {
    return this.store.testRawGet(service, account);
  }

  profilePassword(profileId: string) {
    return this.store.get(this.passwordService, profileId);
  }

  profileSecret(profileId: string, kind: string) {
    return this.store.get(this.profileSecretService, this.secretAccount(profileId, kind));
  }

  async privateKey(id: string) {
    const key = await this.retrieveKey(id);
    return key?.privateKey;
  }
}

export const credentialCommands = new Set([
  'delete_key_credential',
  'delete_profile_password',
  'delete_profile_secret',
  'delete_profile_secrets',
  'list_key_credentials',
  'retrieve_key_credential',
  'retrieve_profile_password',
  'retrieve_profile_secret',
  'store_key_credential',
  'store_profile_password',
  'store_profile_secret',
]);
