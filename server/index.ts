import express from "express";
import cors from "cors";
import path from "node:path";
import { config, hasOpenAIKey } from "./config.js";
import { getOpenAIClient } from "./openai.js";
import { TaskRunner } from "./task-runner.js";
import type {
  ClientSecretResponse,
  ResolveApprovalPayload,
  SubmitTaskPayload,
  UpdateTaskInputsPayload
} from "../shared/types.js";

const app = express();
const taskRunner = new TaskRunner(config.taskStorePath, config.artifactDir);

app.use(
  cors({
    origin: config.clientOrigin,
    credentials: true
  })
);
app.use(express.json({ limit: "2mb" }));
app.use("/artifacts", express.static(config.artifactDir));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    openAiConfigured: hasOpenAIKey()
  });
});

app.get("/api/tasks", (_request, response) => {
  response.json(taskRunner.listTasks());
});

app.get("/api/tasks/:taskId", (request, response) => {
  const task = taskRunner.getTask(request.params.taskId);
  if (!task) {
    response.status(404).json({ error: "Task not found." });
    return;
  }
  response.json(task);
});

app.post("/api/tasks", async (request, response) => {
  try {
    const payload = request.body as SubmitTaskPayload;
    if (!payload.request?.trim()) {
      response.status(400).json({ error: "Task request is required." });
      return;
    }

    const task = await taskRunner.submitTask(payload.request, payload.title);
    response.status(201).json(task);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : "Task creation failed."
    });
  }
});

app.post("/api/tasks/:taskId/input", async (request, response) => {
  try {
    const payload = request.body as UpdateTaskInputsPayload;
    const task = await taskRunner.provideInputs(
      request.params.taskId,
      payload.inputs ?? {}
    );
    response.json(task);
  } catch (error) {
    response.status(400).json({
      error: error instanceof Error ? error.message : "Unable to update task."
    });
  }
});

app.post("/api/tasks/:taskId/approve", async (request, response) => {
  try {
    const payload = request.body as ResolveApprovalPayload;
    const task = await taskRunner.resolveApproval(
      request.params.taskId,
      payload.approvalId,
      payload.approved
    );
    response.json(task);
  } catch (error) {
    response.status(400).json({
      error:
        error instanceof Error ? error.message : "Unable to resolve approval."
    });
  }
});

app.post("/api/realtime/client-secret", async (_request, response) => {
  try {
    const client = getOpenAIClient();
    const secret = await client.realtime.clientSecrets.create({
      expires_after: {
        anchor: "created_at",
        seconds: 300
      },
      session: {
        type: "realtime",
        model: config.realtimeModel,
        output_modalities: ["audio"],
        instructions:
          "You are the live voice interface for a background task operator. Ask only for details that actually block execution. When you know enough, call the task delegation tools. Never claim that an action is complete unless the backend task status says it is complete.",
        audio: {
          input: {
            turn_detection: {
              type: "semantic_vad"
            }
          },
          output: {
            voice: "marin"
          }
        }
      }
    });

    response.json({
      value: secret.value,
      expiresAt: new Date(secret.expires_at * 1000).toISOString()
    } satisfies ClientSecretResponse);
  } catch (error) {
    response.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : "Unable to create a realtime client secret."
    });
  }
});

async function start(): Promise<void> {
  await taskRunner.init();
  taskRunner.start();

  const clientBuildPath = path.resolve(process.cwd(), "dist/client");
  app.use(express.static(clientBuildPath));
  app.use((_request, response) => {
    response.sendFile(path.resolve(clientBuildPath, "index.html"));
  });

  app.listen(config.port, () => {
    console.log(`Voice Operator server listening on http://localhost:${config.port}`);
  });
}

void start();
