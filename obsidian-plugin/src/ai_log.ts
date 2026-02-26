import type AiTasksBoardPlugin from "./main";
import { appendJsonl, deriveLogsPath } from "./board_fs";

export type AiTasksLogEvent = {
  ts: string;
  type: string;
  [k: string]: unknown;
};

export async function appendAiTasksLog(plugin: AiTasksBoardPlugin, event: Omit<AiTasksLogEvent, "ts">): Promise<void> {
  const ts = new Date().toISOString();
  const dateStr = ts.slice(0, 10);
  const path = deriveLogsPath(plugin.settings.boardPath, dateStr);
  await appendJsonl(plugin.app.vault, path, { ts, ...event });
}

