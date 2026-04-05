-- Per-author daily audit job counter to prevent cost abuse
CREATE TABLE author_audit_budget (
    author_id TEXT NOT NULL,
    date TEXT NOT NULL,
    audit_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (author_id, date)
);
