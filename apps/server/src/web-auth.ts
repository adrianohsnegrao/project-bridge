import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseConnection } from "./database.js";

export type WebRole = "admin" | "manager" | "reviewer" | "viewer";
export type Permission = "projects:read" | "projects:write" | "approvals:decide" | "audit:read";
export interface WebUser { id: string; name: string; email: string; role: WebRole; permissions: Permission[] }

const rolePermissions: Record<WebRole, Permission[]> = {
  admin: ["projects:read", "projects:write", "approvals:decide", "audit:read"],
  manager: ["projects:read", "projects:write", "audit:read"],
  reviewer: ["projects:read", "approvals:decide"],
  viewer: ["projects:read"],
};

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export function passwordHash(password: string, salt = randomBytes(16).toString("hex")): string {
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export class WebAuth {
  constructor(private readonly db: DatabaseConnection) {}

  login(email: string, password: string): { token: string; user: WebUser } | null {
    const row = this.db.prepare("SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1").get(email) as Record<string, unknown> | undefined;
    if (!row) return null;
    const [salt, stored] = String(row.password_hash).split(":");
    const candidate = scryptSync(password, salt, 64);
    const expected = Buffer.from(stored, "hex");
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return null;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    this.db.prepare("INSERT INTO web_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash(token), String(row.id), expiresAt, new Date().toISOString());
    return { token, user: this.toUser(row) };
  }

  authenticate(token?: string): WebUser | null {
    if (!token) return null;
    this.db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(new Date().toISOString());
    const row = this.db.prepare(`
      SELECT users.* FROM web_sessions JOIN users ON users.id = web_sessions.user_id
      WHERE web_sessions.token_hash = ? AND web_sessions.expires_at > ? AND users.active = 1
    `).get(tokenHash(token), new Date().toISOString()) as Record<string, unknown> | undefined;
    return row ? this.toUser(row) : null;
  }

  logout(token?: string): void {
    if (token) this.db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(tokenHash(token));
  }

  has(user: WebUser, permission: Permission): boolean { return user.permissions.includes(permission); }

  private toUser(row: Record<string, unknown>): WebUser {
    const role = row.role as WebRole;
    return { id: String(row.id), name: String(row.name), email: String(row.email), role, permissions: rolePermissions[role] };
  }
}

export function sessionToken(cookie?: string): string | undefined {
  return cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("pb_session="))?.slice("pb_session=".length);
}
