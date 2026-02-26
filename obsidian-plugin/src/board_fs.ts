import { TFile, Vault } from "obsidian";

export function nowIsoForFilename(): string {
  // Avoid ':' for Windows compatibility.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function deriveHistoryPath(boardPath: string, ts: string): string {
  const baseName = boardPath.split("/").pop() ?? "Board.md";
  const stamped = baseName.replace(/\.md$/i, `.${ts}.md`);

  const idx = boardPath.lastIndexOf("/Boards/");
  if (idx !== -1) {
    const prefix = boardPath.slice(0, idx);
    return `${prefix}/History/Boards/${stamped}`;
  }

  // Fallback: put history next to the board file.
  const parent = boardPath.split("/").slice(0, -1).join("/");
  return `${parent}/History/${stamped}`;
}

export function deriveLogsPath(boardPath: string, dateStr: string): string {
  const safeDate = (dateStr || "").trim() || new Date().toISOString().slice(0, 10);
  const idx = boardPath.lastIndexOf("/Boards/");
  if (idx !== -1) {
    const prefix = boardPath.slice(0, idx);
    return `${prefix}/History/Logs/ai-tasks.${safeDate}.jsonl`;
  }

  const parent = boardPath.split("/").slice(0, -1).join("/");
  return `${parent}/History/ai-tasks.${safeDate}.jsonl`;
}

export async function ensureFolder(vault: Vault, folderPath: string): Promise<void> {
  const parts = folderPath.split("/").filter((p) => p.length > 0);
  let current = "";
  for (const p of parts) {
    current = current ? `${current}/${p}` : p;
    const existing = vault.getAbstractFileByPath(current);
    if (!existing) await vault.createFolder(current);
  }
}

export async function writeWithHistory(vault: Vault, boardFile: TFile, nextContent: string): Promise<void> {
  const current = await vault.read(boardFile);
  const ts = nowIsoForFilename();
  const historyPath = deriveHistoryPath(boardFile.path, ts);
  const historyFolder = historyPath.split("/").slice(0, -1).join("/");
  await ensureFolder(vault, historyFolder);
  await vault.create(historyPath, current);
  await vault.modify(boardFile, nextContent);
}

export async function appendJsonl(vault: Vault, path: string, obj: unknown): Promise<void> {
  const folder = path.split("/").slice(0, -1).join("/");
  if (folder) await ensureFolder(vault, folder);

  const line = JSON.stringify(obj) + "\n";
  const abs = vault.getAbstractFileByPath(path);
  if (abs instanceof TFile) {
    const prev = await vault.read(abs);
    await vault.modify(abs, prev + line);
    return;
  }
  await vault.create(path, line);
}

