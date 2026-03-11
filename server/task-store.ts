import fs from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskRecord } from "../shared/types.js";

interface TaskStoreFile {
  tasks: TaskRecord[];
}

export class TaskStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<TaskRecord[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as TaskStoreFile;
      return parsed.tasks ?? [];
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown task store error.";
      if (message.includes("ENOENT")) {
        await this.save([]);
        return [];
      }
      throw error;
    }
  }

  async save(tasks: TaskRecord[]): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    await fs.writeFile(
      this.filePath,
      JSON.stringify(
        {
          tasks
        } satisfies TaskStoreFile,
        null,
        2
      )
    );
  }

  async ensureArtifactsDir(artifactDir: string): Promise<void> {
    await fs.mkdir(artifactDir, { recursive: true });
  }
}
