-- 0004_audit_budget.sql
-- Daily neuron budget tracking for Workers AI audit costs (COST-02)
-- One row per UTC calendar day, tracking cumulative neuron usage

CREATE TABLE audit_budget (
    date TEXT PRIMARY KEY,
    neurons_used INTEGER NOT NULL DEFAULT 0
);
