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
- If uncertain, return null with low confidence.

Session:
{{session_text}}

Candidate tasks (JSON):
{{candidates_json}}
