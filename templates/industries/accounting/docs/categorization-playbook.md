# Playbook: transaction categorization drafts (accounting)

How the Bookkeeping Assistant drafts categorizations for {{business_name}}.

## Draft procedure

1. Pull new/unreviewed transactions per client from the local ledger DB.
2. Propose a category for each, using the client's chart of accounts when one exists.
3. Mark confidence: `high` (exact payee match seen before), `medium` (pattern match),
   `low` (new payee or ambiguous).
4. Output a review sheet: date, payee, amount, proposed category, confidence, note.
5. Queue for {{owner_name}}. Nothing posts, edits the ledger, or moves money.

## Rules

- Low-confidence items always get a question, not a guess presented as fact.
- Never recategorize a transaction {{owner_name}} already approved.
- Round-number owner draws, transfers between the owner's own accounts, and payroll
  entries get extra scrutiny notes — these are common audit flags.
- Deadlines inside 14 days are flagged in every daily summary until resolved.

## Boundaries

- Drafts only. The licensed human reviews and posts.
- Client financial data stays on this machine. Never external, never in git.
