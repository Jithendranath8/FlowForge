import { createHash, randomBytes } from "node:crypto";
import { schema, type Database } from "@flowforge/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { SignInError, type OAuthIdentity } from "./providers.js";

/*
 * Identity mapping (ADR-018).
 *
 * - An identity is (provider, provider account id). Once linked, it always resolves to
 *   the same user, even if the email changes at the provider.
 * - A new identity whose verified email matches an existing user is linked to that user,
 *   so one person signing in with Google and with GitHub has one account. Providers only
 *   hand us verified emails (see providers.ts); an unverified email is refused before
 *   this point, which is what makes linking by email safe.
 * - Only allowlisted emails may sign in (AUTH_ALLOWED_EMAILS); an operator can
 *   pre-provision a user by email to give them access to an existing workspace.
 * - A user without any workspace gets a private one, as its owner.
 */

export interface EmailAllowlist {
  /** Anyone with a verified email may sign in. */
  any: boolean;
  emails: ReadonlySet<string>;
  /** Domains without the @. */
  domains: ReadonlySet<string>;
}

export function parseAllowlist(value: string, any = false): EmailAllowlist {
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const raw of value.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith("@")) domains.add(entry.slice(1));
    else emails.add(entry);
  }
  return { any, emails, domains };
}

export function isAllowed(list: EmailAllowlist, email: string): boolean {
  const e = email.toLowerCase();
  return list.any || list.emails.has(e) || list.domains.has(e.slice(e.lastIndexOf("@") + 1));
}

export interface SignedInUser {
  userId: string;
  tenantId: string;
  /** True when this sign-in created the user. */
  createdUser: boolean;
}

/** Find, link or create the user for a verified identity; returns their default workspace. */
export async function signInIdentity(db: Database, now: Date, identity: OAuthIdentity, allowlist: EmailAllowlist): Promise<SignedInUser> {
  if (!isAllowed(allowlist, identity.email)) throw new SignInError("not_allowed", "This email address is not allowed to sign in", emailForLog(identity.email));
  return db.transaction(async (tx) => {
    const acctOf = () =>
      tx
        .select({ userId: schema.oauthAccounts.userId })
        .from(schema.oauthAccounts)
        .where(and(eq(schema.oauthAccounts.provider, identity.provider), eq(schema.oauthAccounts.providerAccountId, identity.subject)));
    const userByEmail = () =>
      tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(sql`lower(${schema.users.email}) = ${identity.email}`);

    let createdUser = false;
    let [acct] = await acctOf();
    if (!acct) {
      let [user] = await userByEmail();
      if (!user) {
        // Unique on lower(email): a concurrent first sign-in inserts nothing here.
        [user] = await tx
          .insert(schema.users)
          .values({ email: identity.email, name: identity.name, avatarUrl: identity.avatarUrl, createdAt: now })
          .onConflictDoNothing()
          .returning({ id: schema.users.id });
        createdUser = Boolean(user);
        if (!user) [user] = await userByEmail();
      }
      await tx
        .insert(schema.oauthAccounts)
        .values({ userId: user!.id, provider: identity.provider, providerAccountId: identity.subject, createdAt: now })
        .onConflictDoNothing();
      [acct] = await acctOf();
    }
    const userId = acct!.userId;
    await tx.update(schema.users).set({ name: identity.name, avatarUrl: identity.avatarUrl }).where(eq(schema.users.id, userId));

    const [membership] = await tx
      .select({ tenantId: schema.memberships.tenantId })
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, userId))
      .orderBy(asc(schema.memberships.createdAt))
      .limit(1);
    if (membership) return { userId, tenantId: membership.tenantId, createdUser };

    const local = identity.email.slice(0, identity.email.indexOf("@")).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "user";
    const slug = `${local}-${randomBytes(4).toString("hex")}`;
    const [tenant] = await tx
      .insert(schema.tenants)
      .values({ slug, name: `${identity.name ?? local}'s workspace`, createdAt: now })
      .returning({ id: schema.tenants.id });
    await tx.insert(schema.memberships).values({ tenantId: tenant!.id, userId, role: "owner", createdAt: now });
    return { userId, tenantId: tenant!.id, createdUser };
  });
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  role: "owner" | "admin" | "member" | "viewer";
}

export async function workspacesOf(db: Database, userId: string): Promise<Workspace[]> {
  return db
    .select({ id: schema.tenants.id, slug: schema.tenants.slug, name: schema.tenants.name, role: schema.memberships.role })
    .from(schema.memberships)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.memberships.tenantId))
    .where(eq(schema.memberships.userId, userId))
    .orderBy(asc(schema.memberships.createdAt));
}

/**
 * How a refused sign-in's email is logged: its domain and a short fingerprint, never the
 * address. Operators can check a suspected address by computing its fingerprint:
 * sha256(lowercased email) in hex, first 12 characters.
 */
export function emailForLog(email: string): { emailDomain: string; emailHash: string } {
  const e = email.trim().toLowerCase();
  return { emailDomain: e.slice(e.lastIndexOf("@") + 1), emailHash: createHash("sha256").update(e).digest("hex").slice(0, 12) };
}

export type MemberRole = (typeof schema.memberRole.enumValues)[number];

/** Why access could not be removed. */
export class AccessError extends Error {
  constructor(
    readonly code: "not_member" | "last_owner",
    message: string,
  ) {
    super(message);
    this.name = "AccessError";
  }
}

/**
 * Take a user out of a workspace and end their sessions that are working in it, so their
 * next request fails rather than running on until the session expires. A workspace keeps
 * at least one owner. The workspace's memberships are locked, so two owners removing
 * each other at once cannot leave it with none.
 */
export async function removeMember(db: Database, tenantId: string, userId: string): Promise<{ role: MemberRole; sessionsEnded: number }> {
  return db.transaction(async (tx) => {
    const members = await tx
      .select({ userId: schema.memberships.userId, role: schema.memberships.role })
      .from(schema.memberships)
      .where(eq(schema.memberships.tenantId, tenantId))
      .for("update");
    const target = members.find((m) => m.userId === userId);
    if (!target) throw new AccessError("not_member", "Not a member of this workspace");
    if (target.role === "owner" && members.filter((m) => m.role === "owner").length === 1) {
      throw new AccessError("last_owner", "A workspace keeps at least one owner: make someone else an owner first");
    }
    await tx.delete(schema.memberships).where(and(eq(schema.memberships.tenantId, tenantId), eq(schema.memberships.userId, userId)));
    const ended = await tx
      .delete(schema.sessions)
      .where(and(eq(schema.sessions.userId, userId), eq(schema.sessions.activeTenantId, tenantId)))
      .returning({ id: schema.sessions.id });
    return { role: target.role, sessionsEnded: ended.length };
  });
}

/** End every session a user has ("sign out everywhere"). Returns how many ended. */
export async function endSessions(db: Database, userId: string): Promise<number> {
  const ended = await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId)).returning({ id: schema.sessions.id });
  return ended.length;
}
