# Playbook: client check-in sweep (fitness)

How the Assistant Coach runs the daily check-in sweep for {{business_name}}.

## Sweep procedure

1. Pull the client list from the client DB (local only — never exported).
2. For each client, find the last meaningful interaction (check-in reply, session log,
   delivered plan).
3. Flag any client silent 3+ days.
4. For each flagged client, draft a short, warm follow-up message. Reference their
   actual program ("How did week 2 of the strength block feel?") — never generic spam.
5. Queue all drafts for {{owner_name}}'s approval. Nothing sends without approval.

## Tone rules

- Coach's voice, not bot voice. Short (2–3 sentences max).
- One question per message. No guilt-tripping, no streak-shaming.
- If a client mentions pain, injury, or illness: stop, flag for {{owner_name}}
  immediately, do not draft training advice.

## Escalation

- Silent 14+ days → mark for personal call by {{owner_name}}, not another text.
- Any medical-sounding mention → same-day flag, highest priority.
