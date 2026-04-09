import * as crypto from "node:crypto";

interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

let keytarModulePromise: Promise<KeytarLike | null> | null = null;

async function resolveKeytarModule(): Promise<KeytarLike | null> {
  if (!keytarModulePromise) {
    keytarModulePromise = (async () => {
      try {
        const moduleValue = await import("keytar");
        const candidate = (moduleValue as { default?: unknown }).default ?? moduleValue;

        if (
          typeof (candidate as KeytarLike).getPassword === "function" &&
          typeof (candidate as KeytarLike).setPassword === "function"
        ) {
          return candidate as KeytarLike;
        }

        return null;
      } catch {
        return null;
      }
    })();
  }

  return keytarModulePromise;
}

export interface EncryptionPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface EncryptionServiceOptions {
  passphrase?: string;
  serviceName?: string;
  accountName?: string;
  disableKeychain?: boolean;
}

export class EncryptionService {
  private keyPromise: Promise<Buffer> | null = null;

  constructor(private readonly options: EncryptionServiceOptions = {}) {}

  async encrypt(plainText: string): Promise<EncryptionPayload> {
    const key = await this.getKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

    const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64")
    };
  }

  async decrypt(payload: EncryptionPayload): Promise<string> {
    const key = await this.getKey();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(payload.iv, "base64")
    );

    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final()
    ]);

    return plaintext.toString("utf8");
  }

  private async getKey(): Promise<Buffer> {
    if (!this.keyPromise) {
      this.keyPromise = this.resolveKey();
    }

    return this.keyPromise;
  }

  private async resolveKey(): Promise<Buffer> {
    const keychainKey = await this.loadFromKeychain();
    if (keychainKey) {
      return keychainKey;
    }

    const passphrase = this.options.passphrase ?? process.env.PLURO_PASSPHRASE;
    if (passphrase && passphrase.length > 0) {
      return crypto.scryptSync(passphrase, "pluro-context-salt", 32);
    }

    throw new Error(
      "Unable to resolve encryption key. Set PLURO_PASSPHRASE or provide --passphrase when keychain is unavailable."
    );
  }

  private async loadFromKeychain(): Promise<Buffer | null> {
    if (this.isKeychainDisabled()) {
      return null;
    }

    const keytar = await resolveKeytarModule();
    if (!keytar) {
      return null;
    }

    const serviceName = this.options.serviceName ?? "pluro";
    const accountName = this.options.accountName ?? "master-key";

    try {
      let value = await keytar.getPassword(serviceName, accountName);
      if (!value) {
        value = crypto.randomBytes(32).toString("base64");
        await keytar.setPassword(serviceName, accountName, value);
      }

      const raw = Buffer.from(value, "base64");
      if (raw.length === 32) {
        return raw;
      }

      return crypto.createHash("sha256").update(value).digest();
    } catch {
      return null;
    }
  }

  private isKeychainDisabled(): boolean {
    if (this.options.disableKeychain) {
      return true;
    }

    const envValue = process.env.PLURO_DISABLE_KEYCHAIN;
    if (!envValue) {
      return false;
    }

    const normalized = envValue.trim().toLowerCase();
    return normalized === "1" || normalized === "true";
  }
}
