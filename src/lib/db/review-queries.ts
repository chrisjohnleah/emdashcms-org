export interface Review {
  id: string;
  rating: number;
  comment: string;
  authorUsername: string;
  authorAvatarUrl: string | null;
  authorId: string;
  createdAt: string;
}

export interface ReviewStats {
  averageRating: number;
  totalCount: number;
}

export async function getReviews(
  db: D1Database,
  entityType: "plugin" | "theme",
  entityId: string,
): Promise<Review[]> {
  const result = await db
    .prepare(
      `SELECT r.*, a.github_username, a.avatar_url
       FROM reviews r
       JOIN authors a ON r.author_id = a.id
       WHERE r.entity_type = ? AND r.entity_id = ?
       ORDER BY r.created_at DESC`,
    )
    .bind(entityType, entityId)
    .all();

  return (result.results as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    rating: r.rating as number,
    comment: r.comment as string,
    authorUsername: r.github_username as string,
    authorAvatarUrl: r.avatar_url as string | null,
    authorId: r.author_id as string,
    createdAt: r.created_at as string,
  }));
}

export async function getReviewStats(
  db: D1Database,
  entityType: "plugin" | "theme",
  entityId: string,
): Promise<ReviewStats> {
  const result = await db
    .prepare(
      `SELECT AVG(rating) AS avg_rating, COUNT(*) AS total_count
       FROM reviews
       WHERE entity_type = ? AND entity_id = ?`,
    )
    .bind(entityType, entityId)
    .all();

  const r = (result.results as Record<string, unknown>[])[0] ?? {};
  return {
    averageRating: Math.round(((r.avg_rating as number) ?? 0) * 10) / 10,
    totalCount: (r.total_count as number) ?? 0,
  };
}

export async function getUserReview(
  db: D1Database,
  entityType: "plugin" | "theme",
  entityId: string,
  authorId: string,
): Promise<Review | null> {
  const result = await db
    .prepare(
      `SELECT r.*, a.github_username, a.avatar_url
       FROM reviews r
       JOIN authors a ON r.author_id = a.id
       WHERE r.entity_type = ? AND r.entity_id = ? AND r.author_id = ?`,
    )
    .bind(entityType, entityId, authorId)
    .all();

  const rows = result.results as Record<string, unknown>[];
  if (rows.length === 0) return null;
  const r = rows[0];

  return {
    id: r.id as string,
    rating: r.rating as number,
    comment: r.comment as string,
    authorUsername: r.github_username as string,
    authorAvatarUrl: r.avatar_url as string | null,
    authorId: r.author_id as string,
    createdAt: r.created_at as string,
  };
}

export async function createReview(
  db: D1Database,
  entityType: "plugin" | "theme",
  entityId: string,
  authorId: string,
  rating: number,
  comment: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO reviews (id, entity_type, entity_id, author_id, rating, comment)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, entityType, entityId, authorId, rating, comment)
    .run();
  return id;
}

export async function updateReview(
  db: D1Database,
  reviewId: string,
  authorId: string,
  rating: number,
  comment: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE reviews SET rating = ?, comment = ?, updated_at = datetime('now')
       WHERE id = ? AND author_id = ?`,
    )
    .bind(rating, comment, reviewId, authorId)
    .run();
  return result.meta.changes > 0;
}

export async function deleteReview(
  db: D1Database,
  reviewId: string,
): Promise<boolean> {
  const result = await db
    .prepare(`DELETE FROM reviews WHERE id = ?`)
    .bind(reviewId)
    .run();
  return result.meta.changes > 0;
}
