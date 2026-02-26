{{ctx}}You are helping maintain an Obsidian Markdown task board.
Given an unstructured or semi-structured text blob, split it into multiple tasks.

Return ONLY valid JSON with this shape:
{
  "tasks": [
    {
      "title": string,
      "status": "Unassigned"|"Todo"|"Doing"|"Review"|"Done",
      "tags": string[],
      "body": string
    }
  ],
  "reasoning": string,
  "confidence": number
}

Rules:
- Extract each actionable item as a separate task.
- Task title should be short and specific (<= 16 Chinese chars or <= 80 Latin chars).
- Prefer tags from tag_presets when provided; choose 1-3 tags per task.
- Limit tasks to max_tasks={{max_tasks}}.

Tag presets (JSON):
{{tag_presets_json}}

Input text:
{{text}}

{{instruction_block}}

