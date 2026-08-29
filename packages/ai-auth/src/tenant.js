// The SandboxOS wiring: ai-auth's stores, bound to a tenant.
//
// Everything below the line in this package is deployment-agnostic — it takes a
// credential store and a host secret and does not care where either came from. This
// file is the one place that answers those two questions for SandboxOS, so that no
// caller has to know that a Claude credential is a row in `tenant_secrets` sealed under
// a key derived from the master key, and no caller can accidentally answer them
// differently.

import { hostSecret } from "../../secrets/src/store.js";
import { ClaudeAccountStore } from "./account-store.js";
import { ApiKeyStore } from "./key-store.js";
import { TenantCredentialStore } from "./store.js";

/** Derived once per process: the same tenant must not get two different keys. */
let _secret = null;
function secret() {
  if (_secret === null) _secret = hostSecret("ai-auth");
  return _secret;
}

/** Reset the memoized host secret. Tests point SANDBOXOS_HOME at a fresh temp dir. */
export function _resetHostSecret() {
  _secret = null;
}

/** The tenant's connected Claude subscriptions, keyed by principal. */
export function claudeAccounts(tenantId) {
  return new ClaudeAccountStore({ store: new TenantCredentialStore(tenantId), secret: secret() });
}

/** The tenant's stored API keys, falling back to the host environment. */
export function apiKeys(tenantId) {
  return new ApiKeyStore({ store: new TenantCredentialStore(tenantId), secret: secret() });
}
