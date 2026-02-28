{{ctx}}You are helping maintain an Obsidian Markdown task board.
Given a user draft text, decide whether to create a new task or update an existing one.

Return ONLY valid JSON with this shape:
{
  "action": "create"|"update",
  "target_uuid": string|null,
  "title": string,
  "status": "Unassigned"|"Todo"|"Doing"|"Review"|"Done",
  "tags": string[],
  "body": string,
  "reasoning": string,
  "confidence": number
}

Rules:
- Task title should be short and specific (<= 16 Chinese chars or <= 80 Latin chars).
- If action=update, keep the existing task title unless the user explicitly asks to rename it.

Mode hint: {{mode}}
Existing tasks (JSON):
{{tasks_json}}

Tag presets (JSON, optional; prefer these when possible):
{{tag_presets_json}}

User draft:
{{draft}}

{{instruction_block}}
