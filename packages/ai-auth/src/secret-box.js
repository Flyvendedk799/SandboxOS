// Encryption at rest for anything that can spend money.
//
// One primitive for both kinds of credential this package stores: a pasted API key
// and an OAuth refresh token are the same risk wearing different clothes, and giving
// them different protection would only mean getting one of them wrong.
//
// AES-256-GCM, stored as `iv:tag:ciphertext` in hex. GCM rather than CBC so a tampered
// value fails to decrypt instead of decrypting to garbage some parser downstream then
// has to be robust against.
//
// The key is derived from a secret the host already has — here, the same master key
// custody the secrets server uses (see packages/secrets) — rather than introducing a
// second thing to manage and lose. Each store passes its own `label`, and that
// separation is load-bearing: a ciphertext written by the API-key store must not open
// under the OAuth store's key, so a bug that reads the wrong row fails loudly instead
// of handing one subsystem another's secret.
//
// The honest trade: rotating the host secret makes everything stored unreadable.
// `open` returns null rather than throwing, so reads degrade to "not configured" —
// the user signs in again, which works — instead of taking the process down at boot.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export class SecretBox {
  /**
   * @param {string} secret  the host's own secret; hashed, never used raw
   * @param {string} label   namespaces the derived key — one per store, never reused
   */
  constructor(secret, label) {
    if (!secret) throw new Error("SecretBox needs a non-empty secret");
    if (!label) throw new Error("SecretBox needs a label, so two stores cannot share a key");
    this.key = createHash("sha256").update(`${label}:${secret}`).digest();
  }

  seal(plaintext) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), data.toString("hex")].join(":");
  }

  /** Null for anything that will not open: wrong key, tampered value, or simply not ours. */
  open(sealed) {
    const parts = String(sealed ?? "").split(":");
    if (parts.length !== 3) return null;
    const [ivHex, tagHex, dataHex] = parts;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivHex, "hex"));
      decipher.setAuthTag(Buffer.from(tagHex, "hex"));
      return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }

  sealJson(value) {
    return this.seal(JSON.stringify(value));
  }

  openJson(sealed) {
    const plain = this.open(sealed);
    if (plain === null) return null;
    try { return JSON.parse(plain); } catch { return null; }
  }
}

/**
 * Enough of a secret to recognise, never enough to use.
 *
 * Shown wherever a UI has to say "there is a key here" without becoming a way to read
 * it back out. The head identifies the *kind* of key — `sk-ant-`, `sk-proj-` — and the
 * tail is what someone compares against their own records.
 */
export function maskSecret(secret) {
  const trimmed = String(secret ?? "").trim();
  if (trimmed.length <= 12) return "••••";
  return `${trimmed.slice(0, 7)}…${trimmed.slice(-4)}`;
}
