-- Reviews and ratings for plugins and themes
CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('plugin', 'theme')),
    entity_id TEXT NOT NULL,
    author_id TEXT NOT NULL REFERENCES authors(id),
    rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    comment TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_unique ON reviews(entity_type, entity_id, author_id);
CREATE INDEX IF NOT EXISTS idx_reviews_entity ON reviews(entity_type, entity_id);
