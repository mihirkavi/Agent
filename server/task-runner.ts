import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Agent, run, tool, webSearchTool } from "@openai/agents";
import type {
  ApprovalType,
  CalendarEventDraft,
  TaskApprovalRequest,
  TaskCategory,
  TaskExecutionContext,
  TaskProgressItem,
  TaskQuestion,
  TaskRecord,
  TaskResult
} from "../shared/types.js";
import { BrowserController, DomainApprovalRequiredError, normalizeDomain } from "./browser-controller.js";
import { config, hasOpenAIKey } from "./config.js";
import { TaskStore } from "./task-store.js";

const calendarEventSchema = z.object({
  title: z.string(),
  startIso: z.string().optional(),
  endIso: z.string().optional(),
  timezone: z.string().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  allDay: z.boolean().optional(),
  durationMinutes: z.number().int().min(15).max(7 * 24 * 60).optional()
});

const taskAnalysisSchema = z.object({
  title: z.string(),
  category: z.enum([
    "information",
    "browser_automation",
    "api_workflow",
    "mixed",
    "unknown"
  ]),
  selectedExecutor: z.enum(["research", "browser", "api", "mixed", "manual"]),
  executionPlan: z.string(),
  searchQuery: z.string().optional(),
  targetUrl: z.string().optional(),
  successCriteria: z.array(z.string()).default([]),
  missingInputs: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string(),
        placeholder: z.string().optional(),
        sensitive: z.boolean().optional()
      })
    )
    .default([]),
  approvals: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        reason: z.string(),
        type: z.enum([
          "authentication",
          "purchase",
          "destructive",
          "sensitive_data",
          "domain_access"
        ]),
        value: z.string().optional()
      })
    )
    .default([]),
  suggestedDomains: z.array(z.string()).default([]),
  calendarEvent: calendarEventSchema.optional()
});

const researchSchema = z.object({
  summary: z.string(),
  details: z.string(),
  sources: z.array(z.string()).default([]),
  nextSteps: z.array(z.string()).default([])
});

type TaskAnalysis = z.infer<typeof taskAnalysisSchema>;
type ResearchOutput = z.infer<typeof researchSchema>;

type BrowserPause =
  | {
      kind: "approval";
      approval: TaskApprovalRequest;
    }
  | {
      kind: "input";
      question: TaskQuestion;
    };

function nowIso(): string {
  return new Date().toISOString();
}

function dedupe<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function sanitizeQuestion(question: TaskQuestion): TaskQuestion {
  return {
    ...question,
    id: question.id.trim() || randomUUID()
  };
}

function sanitizeApproval(approval: TaskApprovalRequest): TaskApprovalRequest {
  return {
    ...approval,
    id: approval.id.trim() || randomUUID()
  };
}

function createDefaultExecutionContext(): TaskExecutionContext {
  return {
    plan: "",
    successCriteria: []
  };
}

function isCalendarTaskRequest(request: string): boolean {
  return (
    /\bcalendar\b/i.test(request) &&
    /\b(add|create|schedule|put|make|set up)\b/i.test(request)
  );
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function formatUtcForIcs(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function formatDateOnlyForIcs(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

function toGoogleCalendarDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function formatEventWindow(
  start: Date,
  end: Date,
  timezone: string,
  allDay: boolean
): string {
  if (allDay) {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeZone: timezone
    }).format(start);
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: timezone
  });

  return `${formatter.format(start)} to ${formatter.format(end)}`;
}

function parseCategory(executor: TaskAnalysis["selectedExecutor"]): TaskCategory {
  switch (executor) {
    case "research":
      return "information";
    case "browser":
      return "browser_automation";
    case "api":
      return "api_workflow";
    case "mixed":
      return "mixed";
    default:
      return "unknown";
  }
}

export class TaskRunner {
  private readonly store: TaskStore;
  private readonly tasks = new Map<string, TaskRecord>();
  private workerTimer: NodeJS.Timeout | null = null;
  private activeTaskId: string | null = null;

  constructor(storePath: string, artifactDir: string) {
    this.store = new TaskStore(storePath);
    void this.store.ensureArtifactsDir(artifactDir);
  }

  async init(): Promise<void> {
    const tasks = await this.store.load();
    for (const task of tasks) {
      this.tasks.set(task.id, task);
    }
  }

  start(): void {
    this.workerTimer = setInterval(() => {
      void this.tick();
    }, 1200);
  }

  stop(): void {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
  }

  listTasks(): TaskRecord[] {
    return Array.from(this.tasks.values()).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  async submitTask(request: string, title?: string): Promise<TaskRecord> {
    const timestamp = nowIso();
    const task: TaskRecord = {
      id: randomUUID(),
      title: title?.trim() || "New task",
      userRequest: request.trim(),
      category: "unknown",
      status: "queued",
      selectedExecutor: "router",
      createdAt: timestamp,
      updatedAt: timestamp,
      suggestedDomains: [],
      execution: createDefaultExecutionContext(),
      missingInputs: [],
      approvals: [],
      collectedInputs: {},
      approvedActionIds: [],
      progress: [
        this.createProgress(
          "status",
          "Task accepted",
          "The worker will analyze the request and decide how to execute it."
        )
      ]
    };

    this.tasks.set(task.id, task);
    await this.persist();
    return task;
  }

  async provideInputs(
    taskId: string,
    inputs: Record<string, string>
  ): Promise<TaskRecord> {
    const task = this.requireTask(taskId);
    const next: TaskRecord = {
      ...task,
      status: "queued",
      updatedAt: nowIso(),
      collectedInputs: {
        ...task.collectedInputs,
        ...inputs
      },
      missingInputs: [],
      progress: [
        ...task.progress,
        this.createProgress(
          "action",
          "Received additional information",
          Object.keys(inputs).join(", ")
        )
      ]
    };

    this.tasks.set(taskId, next);
    await this.persist();
    return next;
  }

  async resolveApproval(
    taskId: string,
    approvalId: string,
    approved: boolean
  ): Promise<TaskRecord> {
    const task = this.requireTask(taskId);
    const approval = task.approvals.find((item) => item.id === approvalId);
    if (!approval) {
      throw new Error("Approval request not found.");
    }

    if (!approved) {
      const cancelled: TaskRecord = {
        ...task,
        status: "cancelled",
        approvals: task.approvals.filter((item) => item.id !== approvalId),
        updatedAt: nowIso(),
        error: `User rejected approval: ${approval.title}`,
        progress: [
          ...task.progress,
          this.createProgress(
            "warning",
            "Task cancelled by user",
            approval.title
          )
        ]
      };

      this.tasks.set(taskId, cancelled);
      await this.persist();
      return cancelled;
    }

    const next: TaskRecord = {
      ...task,
      status: "queued",
      approvals: task.approvals.filter((item) => item.id !== approvalId),
      approvedActionIds: dedupe([...task.approvedActionIds, approvalId]),
      updatedAt: nowIso(),
      progress: [
        ...task.progress,
        this.createProgress("action", "Approval granted", approval.title)
      ]
    };

    this.tasks.set(taskId, next);
    await this.persist();
    return next;
  }

  private async tick(): Promise<void> {
    if (this.activeTaskId || !hasOpenAIKey()) {
      return;
    }

    const nextTask = this.listTasks().find((task) => task.status === "queued");
    if (!nextTask) {
      return;
    }

    this.activeTaskId = nextTask.id;
    try {
      await this.processTask(nextTask.id);
    } finally {
      this.activeTaskId = null;
    }
  }

  private async processTask(taskId: string): Promise<void> {
    let task = await this.updateTask(taskId, (current) => ({
      ...current,
      status: "running",
      updatedAt: nowIso(),
      progress: [
        ...current.progress,
        this.createProgress(
          "analysis",
          "Analyzing task",
          "Classifying intent, required info, and execution strategy."
        )
      ]
    }));

    const analysis = await this.analyzeTask(task);
    task = await this.updateTask(taskId, (current) =>
      this.applyAnalysis(current, analysis)
    );

    if (task.missingInputs.length > 0) {
      return;
    }

    if (task.approvals.length > 0) {
      return;
    }

    task = await this.updateTask(taskId, (current) => ({
      ...current,
      progress: [
        ...current.progress,
        this.createProgress(
          "status",
          `Starting ${current.selectedExecutor} executor`,
          current.execution.plan
        )
      ]
    }));

    try {
      const result = await this.executeTask(task);
      await this.updateTask(taskId, (current) => ({
        ...current,
        status: "completed",
        updatedAt: nowIso(),
        result,
        progress: [
          ...current.progress,
          this.createProgress("result", "Task completed", result.summary)
        ]
      }));
    } catch (error) {
      if (error instanceof DomainApprovalRequiredError) {
        await this.pauseForDomainApproval(taskId, error.domain);
        return;
      }

      const message =
        error instanceof Error ? error.message : "Unknown execution failure.";
      await this.updateTask(taskId, (current) => ({
        ...current,
        status: "failed",
        updatedAt: nowIso(),
        error: message,
        progress: [
          ...current.progress,
          this.createProgress("error", "Task failed", message)
        ]
      }));
    }
  }

  private async analyzeTask(task: TaskRecord): Promise<TaskAnalysis> {
    if (isCalendarTaskRequest(task.userRequest)) {
      return this.analyzeCalendarTask(task);
    }

    const agent = new Agent({
      name: "Task Router",
      model: config.taskModel,
      instructions: `You are the planner for a voice-first operator agent.

Classify the request into a realistic execution path. Prefer "research" for information lookup, comparison, or discovery tasks. Prefer "browser" for appointment booking, ecommerce, forms, reservations, account flows, or any task that likely requires interacting with a public website. Use "mixed" when research is required before browsing.

Ask for only the minimum missing information that blocks task completion. Reuse collected inputs when available. Do not ask for information already clearly present in the request.

Always request approval for:
- logging into any account
- entering payment or placing an order
- submitting destructive or legally consequential actions
- handling particularly sensitive personal data

Return suggestedDomains as bare domains without protocols where possible. If no domain is known, leave it empty. Keep the execution plan concise and operational.`,
      outputType: taskAnalysisSchema
    });

    const result = await run(
      agent,
      JSON.stringify(
        {
          request: task.userRequest,
          collectedInputs: task.collectedInputs,
          approvedActionIds: task.approvedActionIds,
          knownExecutionContext: task.execution
        },
        null,
        2
      )
    );

    if (!result.finalOutput) {
      throw new Error("Planner did not return structured output.");
    }

    return result.finalOutput;
  }

  private async analyzeCalendarTask(task: TaskRecord): Promise<TaskAnalysis> {
    const timezone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";
    const now = new Date();

    const agent = new Agent({
      name: "Calendar Planner",
      model: config.fastModel,
      instructions: `You convert user requests into a local calendar-event workflow.

Current date/time: ${now.toISOString()}
Default timezone: ${timezone}

Return selectedExecutor "api" and category "api_workflow".
This workflow completes by generating an importable ICS calendar file and a Google Calendar deeplink.

Rules:
- Resolve relative dates like "tomorrow" or "next Friday" against the current date.
- Use absolute ISO 8601 timestamps with offsets for startIso and endIso whenever enough information is available.
- If the request gives a start time but no end time or duration, default durationMinutes to 60.
- Ask only for missing details that truly block event creation, typically the event time or date.
- Prefer inferring a reasonable event title from the request instead of asking for one.
- Never ask for approvals; calendar file generation does not require account access.
- Leave suggestedDomains empty.`,
      outputType: taskAnalysisSchema
    });

    const result = await run(
      agent,
      JSON.stringify(
        {
          request: task.userRequest,
          collectedInputs: task.collectedInputs,
          approvedActionIds: task.approvedActionIds,
          knownExecutionContext: task.execution
        },
        null,
        2
      )
    );

    if (!result.finalOutput) {
      throw new Error("Calendar planner did not return structured output.");
    }

    return result.finalOutput;
  }

  private applyAnalysis(task: TaskRecord, analysis: TaskAnalysis): TaskRecord {
    const missingInputs = analysis.missingInputs
      .filter((question) => !task.collectedInputs[question.id])
      .map(sanitizeQuestion);

    const suggestedDomains = dedupe(
      analysis.suggestedDomains
        .map((domain) => normalizeDomain(domain))
        .filter(Boolean)
    );

    const approvalRequests = analysis.approvals.map(sanitizeApproval);
    const domainApprovals = suggestedDomains
      .filter(
        (domain) =>
          !config.allowedAutomationDomains.has(domain) &&
          !task.approvedActionIds.includes(`domain:${domain}`)
      )
      .map(
        (domain) =>
          ({
            id: `domain:${domain}`,
            title: `Allow browser automation on ${domain}`,
            reason:
              "This domain is outside the configured allowlist and must be approved before automated interaction.",
            type: "domain_access" satisfies ApprovalType,
            value: domain
          }) satisfies TaskApprovalRequest
      );

    const pendingApprovals = [...approvalRequests, ...domainApprovals].filter(
      (approval) => !task.approvedActionIds.includes(approval.id)
    );

    const status =
      missingInputs.length > 0
        ? "needs_input"
        : pendingApprovals.length > 0
          ? "needs_approval"
          : "running";

    return {
      ...task,
      title: analysis.title || task.title,
      category: parseCategory(analysis.selectedExecutor),
      status,
      selectedExecutor: analysis.selectedExecutor,
      suggestedDomains,
      execution: {
        plan: analysis.executionPlan,
        searchQuery: analysis.searchQuery,
        targetUrl: analysis.targetUrl,
        successCriteria: analysis.successCriteria,
        calendarEvent: analysis.calendarEvent
      },
      missingInputs,
      approvals: pendingApprovals,
      updatedAt: nowIso(),
      progress: [
        ...task.progress,
        this.createProgress(
          "analysis",
          `Planner selected ${analysis.selectedExecutor}`,
          analysis.executionPlan
        ),
        ...(missingInputs.length > 0
          ? [
              this.createProgress(
                "warning",
                "More information is required",
                missingInputs.map((question) => question.label).join(", ")
              )
            ]
          : []),
        ...(pendingApprovals.length > 0
          ? [
              this.createProgress(
                "warning",
                "Execution paused for approval",
                pendingApprovals.map((approval) => approval.title).join(", ")
              )
            ]
          : [])
      ]
    };
  }

  private async executeTask(task: TaskRecord): Promise<TaskResult> {
    if (task.selectedExecutor === "research") {
      return this.runResearch(task);
    }

    if (task.selectedExecutor === "mixed") {
      const research = await this.runResearch(task);
      await this.updateTask(task.id, (current) => ({
        ...current,
        progress: [
          ...current.progress,
          this.createProgress(
            "result",
            "Research phase complete",
            research.summary
          )
        ]
      }));

      return this.runBrowser(task, research.details);
    }

    if (task.selectedExecutor === "browser") {
      return this.runBrowser(task);
    }

    if (task.selectedExecutor === "api") {
      return this.runApiWorkflow(task);
    }

    return {
      summary: "The task could not be mapped to an executable path.",
      details:
        "The planner did not have enough confidence to choose research or browser automation safely.",
      sources: [],
      nextSteps: ["Provide a more specific instruction or target website."],
      artifactUrls: []
    };
  }

  private async runResearch(task: TaskRecord): Promise<TaskResult> {
    const agent = new Agent({
      name: "Research Executor",
      model: config.fastModel,
      instructions: `Use web search when needed and return a concise answer grounded in current sources. Only claim completion when the user's question has been answered directly.`,
      tools: [webSearchTool()],
      outputType: researchSchema
    });

    const prompt = JSON.stringify(
      {
        request: task.userRequest,
        collectedInputs: task.collectedInputs,
        successCriteria: task.execution.successCriteria,
        preferredSearchQuery: task.execution.searchQuery
      },
      null,
      2
    );

    const result = await run(agent, prompt);
    const output = result.finalOutput as ResearchOutput;

    return {
      summary: output.summary,
      details: output.details,
      sources: output.sources,
      nextSteps: output.nextSteps,
      artifactUrls: []
    };
  }

  private async runApiWorkflow(task: TaskRecord): Promise<TaskResult> {
    if (task.execution.calendarEvent) {
      return this.runCalendarTask(task, task.execution.calendarEvent);
    }

    return {
      summary: "No specific API connector is configured for this task yet.",
      details:
        "The planner identified an API-oriented workflow, but this app only has a concrete calendar-event API executor at the moment.",
      sources: [],
      nextSteps: [
        "Add a provider-specific connector on the server.",
        "Re-run the task once credentials and schemas are available."
      ],
      artifactUrls: []
    };
  }

  private async runCalendarTask(
    task: TaskRecord,
    calendarEvent: CalendarEventDraft
  ): Promise<TaskResult> {
    if (!calendarEvent.startIso) {
      throw new Error("Calendar event is missing a start date/time.");
    }

    const start = new Date(calendarEvent.startIso);
    if (Number.isNaN(start.getTime())) {
      throw new Error("Calendar event start time is invalid.");
    }

    let end: Date;
    if (calendarEvent.endIso) {
      end = new Date(calendarEvent.endIso);
    } else {
      const durationMinutes = calendarEvent.durationMinutes ?? 60;
      end = new Date(start.getTime() + durationMinutes * 60_000);
    }

    if (Number.isNaN(end.getTime()) || end <= start) {
      end = new Date(start.getTime() + 60 * 60_000);
    }

    const timezone =
      calendarEvent.timezone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      "America/Los_Angeles";
    const uid = `${task.id}@voice-operator.local`;
    const createdAt = formatUtcForIcs(new Date());
    const icsPath = path.resolve(config.artifactDir, `${task.id}.ics`);
    const icsUrl = `/artifacts/${task.id}.ics`;
    const displayWindow = formatEventWindow(
      start,
      end,
      timezone,
      calendarEvent.allDay ?? false
    );

    const icsLines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Voice Operator//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${createdAt}`,
      calendarEvent.allDay
        ? `DTSTART;VALUE=DATE:${formatDateOnlyForIcs(start)}`
        : `DTSTART:${formatUtcForIcs(start)}`,
      calendarEvent.allDay
        ? `DTEND;VALUE=DATE:${formatDateOnlyForIcs(end)}`
        : `DTEND:${formatUtcForIcs(end)}`,
      `SUMMARY:${escapeIcsText(calendarEvent.title)}`,
      calendarEvent.location
        ? `LOCATION:${escapeIcsText(calendarEvent.location)}`
        : "",
      calendarEvent.description
        ? `DESCRIPTION:${escapeIcsText(calendarEvent.description)}`
        : "",
      "END:VEVENT",
      "END:VCALENDAR",
      ""
    ].filter(Boolean);

    await fs.mkdir(config.artifactDir, { recursive: true });
    await fs.writeFile(icsPath, icsLines.join("\r\n"), "utf8");

    const googleCalendarUrl = new URL("https://calendar.google.com/calendar/render");
    googleCalendarUrl.searchParams.set("action", "TEMPLATE");
    googleCalendarUrl.searchParams.set("text", calendarEvent.title);
    googleCalendarUrl.searchParams.set(
      "dates",
      `${toGoogleCalendarDate(start)}/${toGoogleCalendarDate(end)}`
    );
    googleCalendarUrl.searchParams.set("ctz", timezone);
    if (calendarEvent.location) {
      googleCalendarUrl.searchParams.set("location", calendarEvent.location);
    }
    if (calendarEvent.description) {
      googleCalendarUrl.searchParams.set("details", calendarEvent.description);
    }

    return {
      summary: "Calendar event package created",
      details:
        `Created an importable calendar event for "${calendarEvent.title}" scheduled ${displayWindow}. ` +
        `ICS file: ${icsUrl}. Google Calendar deeplink: ${googleCalendarUrl.toString()}`,
      sources: [],
      nextSteps: [
        "Open the ICS artifact in Apple Calendar, Outlook, or another calendar app to import it.",
        "Use the Google Calendar deeplink if you want to add it through a signed-in Google Calendar session."
      ],
      artifactUrls: [icsUrl]
    };
  }

  private async runBrowser(
    task: TaskRecord,
    extraContext?: string
  ): Promise<TaskResult> {
    if (config.disableBrowserAutomation) {
      return {
        summary: "Browser automation is disabled.",
        details:
          "Set DISABLE_BROWSER_AUTOMATION=false to enable Playwright-backed execution.",
        sources: [],
        nextSteps: ["Enable browser automation and re-run the task."],
        artifactUrls: []
      };
    }

    const allowedDomains = new Set<string>(
      dedupe([
        ...Array.from(config.allowedAutomationDomains.values()),
        ...task.suggestedDomains,
        ...task.approvedActionIds
          .filter((id) => id.startsWith("domain:"))
          .map((id) => id.replace("domain:", ""))
      ])
    );

    if (
      task.execution.targetUrl &&
      task.execution.targetUrl.includes("://") &&
      !allowedDomains.has(normalizeDomain(new URL(task.execution.targetUrl).hostname))
    ) {
      throw new DomainApprovalRequiredError(
        normalizeDomain(new URL(task.execution.targetUrl).hostname)
      );
    }

    if (allowedDomains.size === 0) {
      throw new Error(
        "No approved browser domains are available. Approve a domain or configure ALLOWED_AUTOMATION_DOMAINS."
      );
    }

    const controller = new BrowserController(
      task.id,
      allowedDomains,
      config.artifactDir,
      config.browserHeadless
    );
    await controller.start();

    const browserPause = {
      current: null as BrowserPause | null
    };
    try {
      const browserAgent = new Agent({
        name: "Browser Operator",
        model: config.taskModel,
        instructions: `You operate a web browser to complete user tasks.

Allowed domains: ${Array.from(allowedDomains).join(", ")}.

Rules:
- Use web search if you need to discover an official or relevant page.
- Stay on approved domains only.
- Use snapshot_page before taking actions and after important page transitions.
- If you need login, purchase confirmation, or a missing detail, call pause_task instead of improvising.
- Never claim success unless the page state confirms it.
- Keep the final answer factual and concise.`,
        tools: [
          webSearchTool(),
          tool({
            name: "open_website",
            description: "Open a specific URL in the browser.",
            parameters: z.object({
              url: z.string().url()
            }),
            execute: async ({ url }) => controller.navigate(url),
            errorFunction: (_context, error) =>
              error instanceof Error ? error.message : "Browser navigation failed."
          }),
          tool({
            name: "snapshot_page",
            description:
              "Inspect the current page and list visible headings, fields, buttons, links, and text.",
            parameters: z.object({}),
            execute: async () => controller.snapshot(),
            errorFunction: (_context, error) =>
              error instanceof Error ? error.message : "Page snapshot failed."
          }),
          tool({
            name: "click_element",
            description:
              "Click a button, link, or interactive element identified by its visible text or label.",
            parameters: z.object({
              target: z.string()
            }),
            execute: async ({ target }) => controller.click(target),
            errorFunction: (_context, error) =>
              error instanceof Error ? error.message : "Click failed."
          }),
          tool({
            name: "fill_field",
            description:
              "Fill an input, textarea, or select-compatible field identified by label, placeholder, or name.",
            parameters: z.object({
              field: z.string(),
              value: z.string()
            }),
            execute: async ({ field, value }) => controller.fill(field, value),
            errorFunction: (_context, error) =>
              error instanceof Error ? error.message : "Field fill failed."
          }),
          tool({
            name: "select_option",
            description: "Select an option from a dropdown field.",
            parameters: z.object({
              field: z.string(),
              option: z.string()
            }),
            execute: async ({ field, option }) =>
              controller.select(field, option),
            errorFunction: (_context, error) =>
              error instanceof Error ? error.message : "Select failed."
          }),
          tool({
            name: "press_key",
            description: "Press a keyboard key such as Enter or Tab.",
            parameters: z.object({
              key: z.string()
            }),
            execute: async ({ key }) => controller.press(key),
            errorFunction: (_context, error) =>
              error instanceof Error ? error.message : "Key press failed."
          }),
          tool({
            name: "wait_seconds",
            description: "Pause briefly to allow the page to update.",
            parameters: z.object({
              seconds: z.number().min(1).max(10)
            }),
            execute: async ({ seconds }) => controller.wait(seconds)
          }),
          tool({
            name: "read_visible_text",
            description: "Read the visible page text as plain text.",
            parameters: z.object({
              maxChars: z.number().min(500).max(5000).optional()
            }),
            execute: async ({ maxChars }) =>
              controller.readVisibleText(maxChars ?? 3200)
          }),
          tool({
            name: "pause_task",
            description:
              "Pause execution when you need an approval or a missing piece of user information.",
            parameters: z.object({
              mode: z.enum(["approval", "input"]),
              id: z.string(),
              title: z.string(),
              reason: z.string(),
              type: z
                .enum([
                  "authentication",
                  "purchase",
                  "destructive",
                  "sensitive_data",
                  "domain_access"
                ])
                .optional(),
              value: z.string().optional(),
              label: z.string().optional(),
              description: z.string().optional(),
              placeholder: z.string().optional(),
              sensitive: z.boolean().optional()
            }),
            execute: async (input) => {
              if (input.mode === "approval") {
                browserPause.current = {
                  kind: "approval",
                  approval: {
                    id: input.id,
                    title: input.title,
                    reason: input.reason,
                    type: input.type ?? "authentication",
                    value: input.value
                  }
                };
              } else {
                browserPause.current = {
                  kind: "input",
                  question: {
                    id: input.id,
                    label: input.label ?? input.title,
                    description: input.description ?? input.reason,
                    placeholder: input.placeholder,
                    sensitive: input.sensitive
                  }
                };
              }

              return "Execution paused. Ask the user for the requested approval or detail.";
            }
          })
        ]
      });

      const finalOutput = await run(
        browserAgent,
        JSON.stringify(
          {
            request: task.userRequest,
            collectedInputs: task.collectedInputs,
            approvedActionIds: task.approvedActionIds,
            preferredStartUrl: task.execution.targetUrl,
            plan: task.execution.plan,
            researchNotes: extraContext ?? "",
            successCriteria: task.execution.successCriteria
          },
          null,
          2
        )
      );

      const pause = browserPause.current;
      if (pause) {
        if (pause.kind === "approval") {
          await this.updateTask(task.id, (current) => ({
            ...current,
            status: "needs_approval",
            approvals: [sanitizeApproval(pause.approval)],
            updatedAt: nowIso(),
            progress: [
              ...current.progress,
              this.createProgress(
                "warning",
                "Browser execution paused for approval",
                pause.approval.title
              )
            ]
          }));
          throw new Error("Task paused for approval.");
        }

        await this.updateTask(task.id, (current) => ({
          ...current,
          status: "needs_input",
          missingInputs: [sanitizeQuestion(pause.question)],
          updatedAt: nowIso(),
          progress: [
            ...current.progress,
            this.createProgress(
              "warning",
              "Browser execution paused for more information",
              pause.question.label
            )
          ]
        }));
        throw new Error("Task paused for additional information.");
      }

      const screenshotUrl = await controller.saveScreenshot();
      const finalText = finalOutput.finalOutput ?? "Browser workflow finished.";
      const sources = dedupe(
        controller.getVisitedUrls().map((url) => {
          try {
            return new URL(url).toString();
          } catch {
            return url;
          }
        })
      );

      return {
        summary: "Browser workflow completed",
        details: finalText,
        sources,
        nextSteps: [],
        artifactUrls: [screenshotUrl]
      };
    } finally {
      await controller.close();
    }
  }

  private async pauseForDomainApproval(
    taskId: string,
    domain: string
  ): Promise<void> {
    await this.updateTask(taskId, (current) => ({
      ...current,
      status: "needs_approval",
      approvals: [
        {
          id: `domain:${domain}`,
          title: `Allow browser automation on ${domain}`,
          reason:
            "The browser executor reached a domain that is not currently approved.",
          type: "domain_access",
          value: domain
        }
      ],
      updatedAt: nowIso(),
      progress: [
        ...current.progress,
        this.createProgress(
          "warning",
          "Domain approval required",
          domain
        )
      ]
    }));
  }

  private createProgress(
    kind: TaskProgressItem["kind"],
    message: string,
    details?: string
  ): TaskProgressItem {
    return {
      id: randomUUID(),
      createdAt: nowIso(),
      kind,
      message,
      details
    };
  }

  private async updateTask(
    taskId: string,
    updater: (task: TaskRecord) => TaskRecord
  ): Promise<TaskRecord> {
    const task = this.requireTask(taskId);
    const updated = updater(task);
    this.tasks.set(taskId, updated);
    await this.persist();
    return updated;
  }

  private requireTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error("Task not found.");
    }
    return task;
  }

  private async persist(): Promise<void> {
    await this.store.save(this.listTasks());
  }
}
