import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Proposal } from '../src/shared';
import { event, getRequest, saveProposal, settings, transition, type RuntimeEnv } from './db';
import { parseProposal, validateProposal } from './domain';
import { boundedText } from './bounded';
export type JobParams = { id: string; revision: number; comment?: string };
export class CodingWorkflow extends WorkflowEntrypoint<RuntimeEnv, JobParams> {
  async run(e: WorkflowEvent<JobParams>, step: WorkflowStep) {
    const { id, revision, comment = '' } = e.payload;
    try {
      const config = await step.do('load trusted configuration', () => settings(this.env));
      await step.do('analyze request', async () => {
        const r = await getRequest(this.env, id);
        if (r.revision !== revision || r.status === 'Rejected')
          throw new Error('Job is superseded.');
        await transition(
          this.env,
          id,
          'Analyzing',
          'Preparing repository inspection in an isolated runner.',
        );
        return r;
      });
      await step.do('begin implementation', () =>
        transition(
          this.env,
          id,
          'Implementing',
          `Preparing focused changes for revision ${revision + 1}.`,
        ),
      );
      const proposal = await step.do(
        'implement isolated proposal',
        { retries: { limit: 1, delay: '5 seconds', backoff: 'constant' }, timeout: '12 minutes' },
        async () => {
          const r = await getRequest(this.env, id);
          if (r.mode !== 'live')
            throw new Error('Archived sample requests cannot run live coding jobs.');
          if (!this.env.RUNNER_URL || !this.env.RUNNER_TOKEN || !config.repository)
            throw new Error(
              'Live coding requires a repository, RUNNER_URL and RUNNER_TOKEN. Configure the isolated runner before retrying.',
            );
          if (!this.env.RUNNER_URL.startsWith('https://'))
            throw new Error('The live runner must use HTTPS.');
          const destination = r.destination.match(/^([\w.-]+\/[\w.-]+)@([^:]+):(.+)$/);
          if (!destination) throw new Error('Invalid captured repository destination.');
          const previous = await this.env.DB.prepare(
            'SELECT proposal_json FROM proposals WHERE request_id=? AND revision<? ORDER BY revision DESC LIMIT 1',
          )
            .bind(id, revision)
            .first<{ proposal_json: string }>();
          const previousProposal = previous
            ? (JSON.parse(previous.proposal_json) as Proposal)
            : null;
          const response = await fetch(`${this.env.RUNNER_URL.replace(/\/$/, '')}/jobs`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.env.RUNNER_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              jobId: `${id}-r${revision}`,
              feedback: r.feedback,
              repository: destination[1],
              baseBranch: destination[2],
              previousProposal: previousProposal
                ? { parent: previousProposal.parent, files: previousProposal.files }
                : undefined,
              model: config.model,
              checks: config.checks,
              timeoutSeconds: config.timeoutSeconds,
              maxAttempts: config.maxRevisions + 1,
              comment,
            }),
            signal: AbortSignal.timeout(Math.min(config.timeoutSeconds + 30, 660) * 1000),
          });
          if (!response.ok)
            throw new Error(`Isolated runner returned ${response.status}. Inspect runner logs.`);
          const raw = await boundedText(response, 1000000);
          const p = parseProposal(JSON.parse(raw));
          if (p.mode !== 'live') throw new Error('Live runner returned a non-live proposal.');
          validateProposal(p, config.checks);
          return p;
        },
      );
      await step.do('record validation', async () => {
        await transition(
          this.env,
          id,
          'Validating',
          'Recording executed checks, changed files and remaining limitations.',
        );
        await this.env.DB.batch([
          this.env.DB.prepare(
            'UPDATE requests SET validation_first=COALESCE(validation_first,?) WHERE id=?',
          ).bind(proposal.checks.every((c) => c.exitCode === 0) ? 1 : 0, id),
          event(
            this.env,
            id,
            'Validation',
            'hephaestus-engine',
            `${proposal.checks.filter((c) => c.exitCode === 0).length}/${proposal.checks.length} checks passed.`,
            proposal.checks,
          ),
          event(
            this.env,
            id,
            'Implementation record',
            'hephaestus-engine',
            'Recorded inspected files, local branch, commands and changed files.',
            {
              inspectedFiles: proposal.inspectedFiles ?? proposal.files.map((f) => f.path),
              localBranch: proposal.localBranch ?? `hephaestus/${id}-r${revision}`,
              commands: proposal.commands ?? proposal.checks,
              changedFiles: proposal.files.map((f) => f.path),
              limitations: proposal.limitations,
            },
          ),
        ]);
      });
      await step.do('prepare human review', () => saveProposal(this.env, id, revision, proposal));
    } catch (e) {
      await step.do('record failure', async () => {
        const r = await getRequest(this.env, id);
        if (r.revision === revision && !r.approved_at && r.status !== 'Rejected')
          await transition(
            this.env,
            id,
            'Failed',
            e instanceof Error ? e.message : 'Coding job failed.',
          );
      });
      throw e;
    }
  }
}
