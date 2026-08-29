// Bring-your-own API keys, encrypted at rest.
//
// Two properties matter, and they are why keys do not live in a plain settings row:
//
//   * **Secrets are encrypted.** This holds values that can spend money, and a database
//     dump is a far more ordinary accident than a compromised host.
//   * **A secret is never read back out to a caller who only wants to display it.**
//     `hint` returns a mask built from the plaintext — `sk-ant-…9ZQ` — and there is no
//     path that hands the whole value to a UI. Only the code about to make a call asks
//     for the key itself.
//
// Resolution order is stored, then environment, and `source` says which answered. A UI
// that cannot distinguish "no key" from "a key from the environment" shows an empty
// field over a working deployment, and the first thing someone does about that is paste
// a second key in.

import { isSubscription, wireOf } from "./pricing.js";
import { maskSecret, SecretBox } from "./secret-box.js";

/** Namespaces the derived key. Never reuse it for another store — see SecretBox. */
const SECRET_LABEL = "ai-auth-api-keys";

const DEFAULT_ENV_NAMES = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };

export class ApiKeyStore {
  constructor(options) {
    this.options = options;
    this.box = new SecretBox(options.secret, options.secretLabel ?? SECRET_LABEL);
    this.prefix = options.namespace ? `${options.namespace}:key:` : "key:";
    this.env = options.env ?? process.env;
    this.envNames = {
      anthropic: options.envNames?.anthropic ?? DEFAULT_ENV_NAMES.anthropic,
      openai: options.envNames?.openai ?? DEFAULT_ENV_NAMES.openai,
    };
  }

  storeKey(wire) { return `${this.prefix}${wire}`; }

  /** Store a key, or clear it by passing null or an empty string. */
  async set(wire, key) {
    const trimmed = key?.trim() ?? "";
    if (trimmed.length === 0) {
      await this.options.store.delete(this.storeKey(wire));
      return;
    }
    await this.options.store.write(this.storeKey(wire), {
      payload: this.box.seal(trimmed),
      // The mask lives beside the ciphertext rather than being recomputed on read, so
      // showing a settings page costs no decryption and a rotated host secret still renders.
      meta: { hint: maskSecret(trimmed) },
    });
  }

  /** The stored key in the clear. For the code about to make a call, and nothing else. */
  async stored(wire) {
    const record = await this.options.store.read(this.storeKey(wire));
    if (!record) return null;
    return this.box.open(record.payload);
  }

  /** Enough to recognise a key, never enough to use one. Safe to send to a browser. */
  async hint(wire) {
    const record = await this.options.store.read(this.storeKey(wire));
    if (record && typeof record.meta?.hint === "string") return record.meta.hint;
    const fromEnv = this.env[this.envNames[wire]];
    return fromEnv ? maskSecret(fromEnv) : null;
  }

  /**
   * What a caller should use for this provider, and where it came from.
   *
   * Subscription providers resolve to a null key with `source: "subscription"` — not to
   * "none". Their credential is an OAuth login held elsewhere, and reporting them as
   * unset would put a "configure a key" prompt in front of a fully configured deployment.
   */
  async resolve(provider) {
    if (isSubscription(provider)) return { key: null, source: "subscription", ready: true };

    const wire = wireOf(provider);
    const fromStore = await this.stored(wire);
    if (fromStore) return { key: fromStore, source: "stored", ready: true };

    const fromEnv = this.env[this.envNames[wire]]?.trim();
    if (fromEnv) return { key: fromEnv, source: "environment", ready: true };

    return { key: null, source: "none", ready: false };
  }
}
