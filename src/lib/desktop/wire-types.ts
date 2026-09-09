// Raw keychain shapes from fixed B commands.rs/models.rs. The business wrapper
// may normalize kind/nulls; those presentation types are not the IPC payload.
export type KeyCredentialKind = 'password' | 'keyfile';
export interface KeyCredentialRequest {
  id: string;
  label: string;
  kind: KeyCredentialKind;
  privateKey?: string | null;
  publicKey?: string | null;
  keyType?: string | null;
}
export interface KeyCredentialResponse {
  id: string;
  label: string;
  kind: KeyCredentialKind;
  privateKey: string | null;
  publicKey: string | null;
  keyType: string;
  updatedAt: number;
}
export interface KeyCredentialSummary {
  id: string;
  label: string;
  keyType: string;
  kind: KeyCredentialKind;
  service: string;
}
