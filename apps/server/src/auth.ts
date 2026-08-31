import { createHash, timingSafeEqual } from "node:crypto";
import * as z from "zod/v4";
import type { ClientContext } from "./types.js";

const CredentialSchema = z.object({
  client_name: z.string().trim().min(2).max(100),
  token: z.string().min(24),
  scopes: z.array(z.string().min(3)).min(1),
});

const CredentialsSchema = z.array(CredentialSchema);
type CredentialInput = z.infer<typeof CredentialSchema>;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export class AuthenticationError extends Error {
  constructor(public readonly code: "AUTH_REQUIRED" | "INVALID_TOKEN" | "AUTH_NOT_CONFIGURED", message: string) {
    super(message);
  }
}

export class HttpAuthenticator {
  private readonly credentials: Array<Omit<CredentialInput, "token"> & { tokenHash: Buffer }>;

  constructor(rawCredentials = process.env.PROJECT_BRIDGE_HTTP_CREDENTIALS ?? "[]") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawCredentials);
    } catch {
      throw new Error("PROJECT_BRIDGE_HTTP_CREDENTIALS deve conter um JSON válido.");
    }
    this.credentials = CredentialsSchema.parse(parsed).map(({ token, ...credential }) => ({
      ...credential,
      tokenHash: digest(token),
    }));
  }

  get configuredClients(): number {
    return this.credentials.length;
  }

  authenticate(authorization?: string): ClientContext {
    if (this.credentials.length === 0) {
      throw new AuthenticationError("AUTH_NOT_CONFIGURED", "Autenticação HTTP não configurada no servidor.");
    }
    if (!authorization?.startsWith("Bearer ")) {
      throw new AuthenticationError("AUTH_REQUIRED", "Envie um Bearer token válido.");
    }
    const presentedHash = digest(authorization.slice(7).trim());
    const credential = this.credentials.find((candidate) => timingSafeEqual(candidate.tokenHash, presentedHash));
    if (!credential) throw new AuthenticationError("INVALID_TOKEN", "Bearer token inválido.");
    return {
      clientName: credential.client_name,
      scopes: new Set(credential.scopes),
      transport: "http",
    };
  }
}
