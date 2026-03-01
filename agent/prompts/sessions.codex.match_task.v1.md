{{ctx}}You are linking a Codex CLI session to an existing task in an Obsidian Markdown board.
Choose the best matching task UUID from the candidate list, or choose null if none fit.

Return ONLY valid JSON:
{
  "target_uuid": string|null,
  "confidence": number,
  "reasoning": string
}

Rules:
- target_uuid MUST be one of the candidate uuids or null.
- Only return null when **none** of the candidates match the session.
- If one candidate is a weak-but-best match, return it with low confidence (do NOT return null just because you're unsure).
- confidence should be a number between 0 and 1.

Session:
{{session_text}}

Candidate tasks (JSON):
{{candidates_json}}
