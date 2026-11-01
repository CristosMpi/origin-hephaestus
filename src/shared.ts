export const statuses = [
  'Submitted',
  'Analyzing',
  'Implementing',
  'Validating',
  'Awaiting approval',
  'Changes requested',
  'Rejected',
  'Pushed',
  'Failed',
] as const;
export type Status = (typeof statuses)[number];
export type Role = 'user' | 'reviewer' | 'admin';
export type Actor = { email: string; role: Role; method: 'public' | 'admin' | 'access' | 'api' };
export type Feedback = {
  type: 'bug' | 'feature' | 'improvement';
  title: string;
  description: string;
  expected: string;
  actual?: string;
  steps?: string;
  application: string;
  pageUrl?: string;
  version?: string;
};
export type Check = { command: string; exitCode: number; output: string; durationMs: number };
export type FileChange = {
  path: string;
  before: string;
  after: string;
  mode: '100644' | '100755';
  deleted?: boolean;
};
export type Proposal = {
  commit: string;
  parent: string;
  tree: string;
  summary: string;
  plan: string[];
  files: FileChange[];
  diff: string;
  checks: Check[];
  limitations: string[];
  author: { name: string; email: string; date: string };
  message: string;
  readyAt: string;
  mode: 'demo' | 'live';
  commands?: Check[];
  inspectedFiles?: string[];
  localBranch?: string;
};
export type RequestRecord = {
  id: string;
  title: string;
  application: string;
  type: Feedback['type'];
  status: Status;
  author: string;
  feedback: Feedback;
  created_at: string;
  updated_at: string;
  revision: number;
  destination: string;
  proposal: Proposal | null;
  approved_commit: string | null;
  approved_destination: string | null;
  approved_by: string | null;
  approved_at: string | null;
  push_claim: string | null;
  pushed_at: string | null;
  pr_url: string | null;
  review_started_at: string | null;
  first_ready_at: string | null;
  validation_first: number | null;
  first_review_accepted: number | null;
  version: number;
  mode: 'demo' | 'live';
};
export type AuditEvent = {
  id: number;
  request_id: string;
  kind: string;
  actor: string;
  message: string;
  created_at: string;
  data_json: string | null;
};
export type Settings = {
  repository: string;
  baseBranch: string;
  applications: string[];
  provider: 'openai-compatible';
  model: string;
  maxRevisions: number;
  timeoutSeconds: number;
  checks: string[];
  reviewers: { email: string; role: 'reviewer' | 'admin' }[];
};
export type Metric = {
  key: string;
  label: string;
  value: number | null;
  unit: 'duration' | 'percent' | 'count';
  samples: number;
  definition: string;
};
