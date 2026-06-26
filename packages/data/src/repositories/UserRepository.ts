import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { users } from "../schema/users.js";
import type { UserRow } from "../schema/users.js";

/**
 * Repository for the global `users` identity table. Unlike the tenant tables,
 * users are NOT course-scoped: a single human is one identity row regardless of
 * how many courses they belong to (their per-course role lives in
 * `courseMemberships`). This repository owns the mapping from an external
 * channel-native identity (Phase-1: the Discord user id, a snowflake) to the
 * stable internal `users.id` uuid that the rest of the system keys on.
 */
export class UserRepository {
  constructor(private readonly db: Db) {}

  /**
   * Resolve an external Discord identity to its internal user row, creating the
   * row on first sight. Idempotent on the `discord_user_id` unique column: a
   * repeated call returns the same uuid `id`. `displayName` is refreshed only
   * when a non-empty value is supplied, so a later call without a display name
   * never blanks an existing one.
   *
   * @param discordUserId the Discord user id (a snowflake) — the external key.
   * @param displayName   optional display name to set/refresh on the row.
   * @returns the resolved `UserRow`, including its internal uuid `id`.
   */
  async upsertByDiscordId(
    discordUserId: string,
    displayName?: string,
  ): Promise<UserRow> {
    // `display_name` is NOT NULL: on first insert we must supply something, so
    // fall back to the snowflake when no display name is provided.
    const insertDisplayName =
      displayName !== undefined && displayName.length > 0
        ? displayName
        : discordUserId;

    const rows = await this.db
      .insert(users)
      .values({ discordUserId, displayName: insertDisplayName })
      .onConflictDoUpdate({
        target: users.discordUserId,
        // Only refresh the display name when the caller actually provided one;
        // otherwise keep the existing value (a no-op update that still RETURNS
        // the conflicting row).
        set:
          displayName !== undefined && displayName.length > 0
            ? { displayName }
            : { discordUserId },
      })
      .returning();

    // `returning()` on a single-row upsert always yields exactly one row.
    const row = rows[0];
    if (row === undefined) {
      throw new Error("UserRepository.upsertByDiscordId: expected a returned row");
    }
    return row;
  }

  /** Resolve a user by internal uuid `id`, or `undefined` if none exists. */
  async getById(id: string): Promise<UserRow | undefined> {
    const rows = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return rows[0];
  }
}
