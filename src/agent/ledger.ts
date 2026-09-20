import {Database} from "bun:sqlite";

export type ObservationTrigger = "cron" | "manual" | "provider_event";
export type ProposalStatus = "approved" | "pending" | "rejected";
export type ActionReceiptStatus = "failed" | "succeeded";

export type ExperimentRuntime = {
  run_id: string;
  next_observation_at: string | null;
  lease_until: string | null;
  last_snapshot_id: string | null;
  cooldown_until: string | null;
  updated_at: string;
};

export type ExperimentRuntimeInput = Omit<
  ExperimentRuntime,
  "last_snapshot_id"
>;

export type ResultSnapshotRecord = {
  snapshot_id: string;
  run_id: string;
  trigger: ObservationTrigger;
  observed_at: string;
  recorded_at: string;
  payload: unknown;
};

export type DecisionProposalRecord = {
  proposal_id: string;
  snapshot_id: string;
  action_type: string;
  policy_version: string;
  prompt_version: string;
  model: string;
  status: ProposalStatus;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  payload: unknown;
};

export type DecisionProposalInput = Omit<
  DecisionProposalRecord,
  "review_note" | "reviewed_at" | "reviewed_by" | "status"
>;

export type ProposalReview = {
  reviewed_at: string;
  reviewed_by: string;
  review_note?: string | null;
};

export type ActionReceiptRecord = {
  receipt_id: string;
  proposal_id: string;
  idempotency_key: string;
  action_type: string;
  status: ActionReceiptStatus;
  recorded_at: string;
  payload: unknown;
};

type ResultSnapshotDatabaseRow = Omit<ResultSnapshotRecord, "payload"> & {
  payload_json: string;
};

type DecisionProposalDatabaseRow = Omit<
  DecisionProposalRecord,
  "payload"
> & {
  payload_json: string;
};

type ActionReceiptDatabaseRow = Omit<ActionReceiptRecord, "payload"> & {
  payload_json: string;
};

function encodeJson(payload: unknown): string {
  const encoded = JSON.stringify(payload);
  if (encoded === undefined) {
    throw new TypeError("Ledger payloads must be JSON serializable.");
  }
  return encoded;
}

function decodePayload<RecordType extends {payload_json: string}>(
  record: RecordType,
): Omit<RecordType, "payload_json"> & {payload: unknown} {
  const {payload_json, ...metadata} = record;
  return {...metadata, payload: JSON.parse(payload_json) as unknown};
}

export class AgentLedger {
  readonly #database: Database;

  constructor(path = ":memory:") {
    this.#database = new Database(path, {strict: true});
    this.#database.run("PRAGMA journal_mode = WAL");
    this.#database.run("PRAGMA foreign_keys = ON");
    this.#database.run("PRAGMA busy_timeout = 5000");

    this.#database.run(`
      CREATE TABLE IF NOT EXISTS experiment_runtime (
        run_id TEXT PRIMARY KEY NOT NULL,
        next_observation_at TEXT,
        lease_until TEXT,
        last_snapshot_id TEXT,
        cooldown_until TEXT,
        updated_at TEXT NOT NULL
      ) STRICT
    `);
    this.#database.run(`
      CREATE TABLE IF NOT EXISTS result_snapshots (
        snapshot_id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL REFERENCES experiment_runtime(run_id),
        trigger TEXT NOT NULL CHECK (
          trigger IN ('cron', 'manual', 'provider_event')
        ),
        observed_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
      ) STRICT
    `);
    this.#database.run(`
      CREATE TABLE IF NOT EXISTS decision_proposals (
        proposal_id TEXT PRIMARY KEY NOT NULL,
        snapshot_id TEXT NOT NULL REFERENCES result_snapshots(snapshot_id),
        action_type TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('approved', 'pending', 'rejected')
        ),
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        reviewed_by TEXT,
        review_note TEXT,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        UNIQUE (snapshot_id, policy_version, prompt_version),
        CHECK (
          (status = 'pending' AND reviewed_at IS NULL AND reviewed_by IS NULL)
          OR
          (status != 'pending' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
        )
      ) STRICT
    `);
    this.#database.run(`
      CREATE TABLE IF NOT EXISTS action_receipts (
        receipt_id TEXT PRIMARY KEY NOT NULL,
        proposal_id TEXT NOT NULL REFERENCES decision_proposals(proposal_id),
        idempotency_key TEXT NOT NULL UNIQUE,
        action_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('failed', 'succeeded')),
        recorded_at TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        UNIQUE (proposal_id, action_type)
      ) STRICT
    `);
  }

  close(): void {
    this.#database.close();
  }

  getRuntime(runId: string): ExperimentRuntime | null {
    return this.#database
      .query<ExperimentRuntime, [string]>(
        `SELECT run_id, next_observation_at, lease_until, last_snapshot_id,
                cooldown_until, updated_at
         FROM experiment_runtime
         WHERE run_id = ?`,
      )
      .get(runId);
  }

  upsertRuntime(runtime: ExperimentRuntimeInput): ExperimentRuntime {
    this.#database
      .query<
        never,
        [string, string | null, string | null, string | null, string]
      >(
        `INSERT INTO experiment_runtime (
           run_id, next_observation_at, lease_until, cooldown_until, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET
           next_observation_at = excluded.next_observation_at,
           lease_until = excluded.lease_until,
           cooldown_until = excluded.cooldown_until,
           updated_at = excluded.updated_at`,
      )
      .run(
        runtime.run_id,
        runtime.next_observation_at,
        runtime.lease_until,
        runtime.cooldown_until,
        runtime.updated_at,
      );

    return this.getRuntime(runtime.run_id)!;
  }

  acquireLease(
    runId: string,
    now: string,
    leaseUntil: string,
  ): boolean {
    const result = this.#database
      .query<never, [string, string, string, string]>(
        `UPDATE experiment_runtime
         SET lease_until = ?, updated_at = ?
         WHERE run_id = ? AND (lease_until IS NULL OR lease_until <= ?)`,
      )
      .run(leaseUntil, now, runId, now);
    return result.changes === 1;
  }

  releaseLease(
    runId: string,
    leaseUntil: string,
    releasedAt: string,
  ): boolean {
    const result = this.#database
      .query<never, [string, string, string]>(
        `UPDATE experiment_runtime
         SET lease_until = NULL, updated_at = ?
         WHERE run_id = ? AND lease_until = ?`,
      )
      .run(releasedAt, runId, leaseUntil);
    return result.changes === 1;
  }

  completeObservation(
    runId: string,
    leaseUntil: string,
    nextObservationAt: string,
    cooldownUntil: string | null,
    completedAt: string,
  ): boolean {
    const result = this.#database
      .query<never, [string, string | null, string, string, string]>(
        `UPDATE experiment_runtime
         SET next_observation_at = ?, cooldown_until = ?, lease_until = NULL,
             updated_at = ?
         WHERE run_id = ? AND lease_until = ?`,
      )
      .run(
        nextObservationAt,
        cooldownUntil,
        completedAt,
        runId,
        leaseUntil,
      );
    return result.changes === 1;
  }

  recordSnapshot(snapshot: ResultSnapshotRecord): ResultSnapshotRecord {
    const record = this.#database.transaction(() => {
      this.#database
        .query<never, [string, string]>(
          `INSERT INTO experiment_runtime (run_id, updated_at)
           VALUES (?, ?)
           ON CONFLICT (run_id) DO NOTHING`,
        )
        .run(snapshot.run_id, snapshot.recorded_at);
      const insertion = this.#database
        .query<
          never,
          [string, string, ObservationTrigger, string, string, string]
        >(
          `INSERT INTO result_snapshots (
             snapshot_id, run_id, trigger, observed_at,
             recorded_at, payload_json
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (snapshot_id) DO NOTHING`,
        )
        .run(
          snapshot.snapshot_id,
          snapshot.run_id,
          snapshot.trigger,
          snapshot.observed_at,
          snapshot.recorded_at,
          encodeJson(snapshot.payload),
        );

      const persisted = this.#database
        .query<ResultSnapshotDatabaseRow, [string]>(
          `SELECT snapshot_id, run_id, trigger, observed_at,
                  recorded_at, payload_json
           FROM result_snapshots
           WHERE snapshot_id = ?`,
        )
        .get(snapshot.snapshot_id);
      if (persisted === null) {
        throw new Error(`Snapshot ID already exists: ${snapshot.snapshot_id}`);
      }

      if (insertion.changes === 1) {
        this.#database
          .query<never, [string, string, string]>(
            `UPDATE experiment_runtime
             SET last_snapshot_id = ?, updated_at = ?
             WHERE run_id = ?`,
          )
          .run(persisted.snapshot_id, snapshot.recorded_at, snapshot.run_id);
      }
      return persisted;
    }).immediate();

    return decodePayload(record);
  }

  getSnapshot(snapshotId: string): ResultSnapshotRecord | null {
    const record = this.#database
      .query<ResultSnapshotDatabaseRow, [string]>(
        `SELECT snapshot_id, run_id, trigger, observed_at,
                recorded_at, payload_json
         FROM result_snapshots
         WHERE snapshot_id = ?`,
      )
      .get(snapshotId);
    return record === null ? null : decodePayload(record);
  }

  recordProposal(proposal: DecisionProposalInput): DecisionProposalRecord {
    this.#database
      .query<
        never,
        [string, string, string, string, string, string, string, string]
      >(
        `INSERT INTO decision_proposals (
           proposal_id, snapshot_id, action_type, policy_version,
           prompt_version, model, status, created_at, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT (snapshot_id, policy_version, prompt_version) DO NOTHING`,
      )
      .run(
        proposal.proposal_id,
        proposal.snapshot_id,
        proposal.action_type,
        proposal.policy_version,
        proposal.prompt_version,
        proposal.model,
        proposal.created_at,
        encodeJson(proposal.payload),
      );

    const persisted = this.#database
      .query<DecisionProposalDatabaseRow, [string, string, string]>(
        `SELECT proposal_id, snapshot_id, action_type, policy_version,
                prompt_version, model, status, created_at, reviewed_at,
                reviewed_by, review_note, payload_json
         FROM decision_proposals
         WHERE snapshot_id = ? AND policy_version = ? AND prompt_version = ?`,
      )
      .get(
        proposal.snapshot_id,
        proposal.policy_version,
        proposal.prompt_version,
      );
    if (persisted === null) {
      throw new Error(`Proposal ID already exists: ${proposal.proposal_id}`);
    }
    return decodePayload(persisted);
  }

  getProposal(proposalId: string): DecisionProposalRecord | null {
    const proposal = this.#database
      .query<DecisionProposalDatabaseRow, [string]>(
        `SELECT proposal_id, snapshot_id, action_type, policy_version,
                prompt_version, model, status, created_at, reviewed_at,
                reviewed_by, review_note, payload_json
         FROM decision_proposals
         WHERE proposal_id = ?`,
      )
      .get(proposalId);
    return proposal === null ? null : decodePayload(proposal);
  }

  listProposals(status?: ProposalStatus): DecisionProposalRecord[] {
    const proposals = status === undefined
      ? this.#database
          .query<DecisionProposalDatabaseRow, []>(
            `SELECT proposal_id, snapshot_id, action_type, policy_version,
                    prompt_version, model, status, created_at, reviewed_at,
                    reviewed_by, review_note, payload_json
             FROM decision_proposals
             ORDER BY created_at DESC, proposal_id`,
          )
          .all()
      : this.#database
          .query<DecisionProposalDatabaseRow, [ProposalStatus]>(
            `SELECT proposal_id, snapshot_id, action_type, policy_version,
                    prompt_version, model, status, created_at, reviewed_at,
                    reviewed_by, review_note, payload_json
             FROM decision_proposals
             WHERE status = ?
             ORDER BY created_at DESC, proposal_id`,
          )
          .all(status);
    return proposals.map(decodePayload);
  }

  approveProposal(
    proposalId: string,
    review: ProposalReview,
  ): DecisionProposalRecord {
    return this.reviewProposal(proposalId, "approved", review);
  }

  rejectProposal(
    proposalId: string,
    review: ProposalReview,
  ): DecisionProposalRecord {
    return this.reviewProposal(proposalId, "rejected", review);
  }

  recordActionReceipt(receipt: ActionReceiptRecord): ActionReceiptRecord {
    this.#database
      .query<never, [string, string, string, string, string, string, string]>(
        `INSERT INTO action_receipts (
           receipt_id, proposal_id, idempotency_key, action_type, status,
           recorded_at, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        receipt.receipt_id,
        receipt.proposal_id,
        receipt.idempotency_key,
        receipt.action_type,
        receipt.status,
        receipt.recorded_at,
        encodeJson(receipt.payload),
      );

    const persisted = this.#database
      .query<ActionReceiptDatabaseRow, [string]>(
        `SELECT receipt_id, proposal_id, idempotency_key, action_type, status,
                recorded_at, payload_json
         FROM action_receipts
         WHERE idempotency_key = ?`,
      )
      .get(receipt.idempotency_key);
    if (persisted === null) {
      throw new Error(`Receipt ID or action already exists: ${receipt.receipt_id}`);
    }
    return decodePayload(persisted);
  }

  private reviewProposal(
    proposalId: string,
    status: Exclude<ProposalStatus, "pending">,
    review: ProposalReview,
  ): DecisionProposalRecord {
    const result = this.#database
      .query<never, [ProposalStatus, string, string, string | null, string]>(
        `UPDATE decision_proposals
         SET status = ?, reviewed_at = ?, reviewed_by = ?, review_note = ?
         WHERE proposal_id = ? AND status = 'pending'`,
      )
      .run(
        status,
        review.reviewed_at,
        review.reviewed_by,
        review.review_note ?? null,
        proposalId,
      );
    const proposal = this.getProposal(proposalId);
    if (proposal === null) {
      throw new Error(`Proposal not found: ${proposalId}`);
    }
    if (result.changes !== 1) {
      throw new Error(
        `Proposal ${proposalId} cannot transition from ${proposal.status} to ${status}.`,
      );
    }
    return proposal;
  }
}
