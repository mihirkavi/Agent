export type TaskStatus =
  | "queued"
  | "needs_input"
  | "needs_approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskCategory =
  | "information"
  | "browser_automation"
  | "api_workflow"
  | "mixed"
  | "unknown";

export type ApprovalType =
  | "authentication"
  | "purchase"
  | "destructive"
  | "sensitive_data"
  | "domain_access";

export type ProgressKind =
  | "status"
  | "analysis"
  | "action"
  | "warning"
  | "result"
  | "error";

export interface TaskQuestion {
  id: string;
  label: string;
  description: string;
  placeholder?: string;
  sensitive?: boolean;
}

export interface TaskApprovalRequest {
  id: string;
  title: string;
  reason: string;
  type: ApprovalType;
  value?: string;
}

export interface TaskProgressItem {
  id: string;
  createdAt: string;
  kind: ProgressKind;
  message: string;
  details?: string;
}

export interface TaskResult {
  summary: string;
  details: string;
  sources: string[];
  nextSteps: string[];
  artifactUrls: string[];
}

export interface CalendarEventDraft {
  title: string;
  startIso?: string;
  endIso?: string;
  timezone?: string;
  location?: string;
  description?: string;
  allDay?: boolean;
  durationMinutes?: number;
}

export interface TaskExecutionContext {
  plan: string;
  searchQuery?: string;
  targetUrl?: string;
  successCriteria: string[];
  calendarEvent?: CalendarEventDraft;
}

export interface TaskRecord {
  id: string;
  title: string;
  userRequest: string;
  category: TaskCategory;
  status: TaskStatus;
  selectedExecutor: string;
  createdAt: string;
  updatedAt: string;
  suggestedDomains: string[];
  execution: TaskExecutionContext;
  missingInputs: TaskQuestion[];
  approvals: TaskApprovalRequest[];
  collectedInputs: Record<string, string>;
  approvedActionIds: string[];
  progress: TaskProgressItem[];
  result?: TaskResult;
  error?: string;
}

export interface SubmitTaskPayload {
  request: string;
  title?: string;
  history?: unknown[];
}

export interface UpdateTaskInputsPayload {
  inputs: Record<string, string>;
}

export interface ResolveApprovalPayload {
  approvalId: string;
  approved: boolean;
}

export interface ClientSecretResponse {
  value: string;
  expiresAt?: string;
}
