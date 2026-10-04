/** Native record absence, distinguished from unexpected storage failures. */
export class AutomationRecordNotFoundError extends Error {}

import { randomUUID } from 'node:crypto';

import type {
  AutomationRecord,
  CreateAutomationRequest,
  UpdateAutomationRequest,
} from '@openkit/app-api-schemas';

/**
 * App-local automation definition store.
 */
export class AutomationStore {
  private readonly automationsByUserId = new Map<string, Map<string, AutomationRecord>>();

  /**
   * Return all automation definitions.
   *
   * @param userId User who owns the returned records.
   * @returns User-owned automation records.
   */
  public listAutomations(userId: string): AutomationRecord[] {
    return [...(this.automationsByUserId.get(userId)?.values() ?? [])];
  }

  /** Resolves only owner and Workspace selectors before content admission; administrators may address another user's record. */
  public getAutomationLineage(
    automationId: string,
    userId: string,
    administratorEligible = false
  ): { workspaceId: string; ownerUserId: string } | null {
    for (const [ownerUserId, records] of this.automationsByUserId) {
      if (ownerUserId !== userId && !administratorEligible) continue;
      const record = records.get(automationId);
      if (record) return { workspaceId: record.workspaceId, ownerUserId };
    }
    return null;
  }

  /** Returns admitted records only, retaining ordinary user-private collections and current administrator eligibility. */
  public listAuthorizedAutomations(
    userId: string,
    workspaceIds: readonly string[],
    administratorEligible = false
  ): AutomationRecord[] {
    const admitted = new Set(workspaceIds);
    return [...this.automationsByUserId.entries()].flatMap(([ownerUserId, records]) =>
      ownerUserId === userId || administratorEligible
        ? [...records.values()].filter((record) => admitted.has(record.workspaceId))
        : []
    );
  }

  /**
   * Return one user-owned automation definition.
   *
   * @param userId User who must own the record.
   * @param automationId Automation identifier.
   * @returns User-owned automation record.
   * @throws When the record does not exist in the user's private collection.
   */
  public getAutomation(userId: string, automationId: string): AutomationRecord {
    const automation = this.automationsByUserId.get(userId)?.get(automationId);

    if (!automation) {
      throw new AutomationRecordNotFoundError(`Automation not found: ${automationId}`);
    }

    return automation;
  }

  /**
   * Create a paused automation definition.
   *
   * @param userId User who owns the automation.
   * @param input Automation creation input.
   * @returns Created automation record.
   */
  public createAutomation(userId: string, input: CreateAutomationRequest): AutomationRecord {
    const timestamp = new Date().toISOString();
    const automation: AutomationRecord = {
      id: `auto_${randomUUID()}`,
      ...input,
      status: 'paused',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const automations = this.automationsByUserId.get(userId) ?? new Map();

    automations.set(automation.id, automation);
    this.automationsByUserId.set(userId, automations);
    return automation;
  }

  /**
   * Update one automation definition.
   *
   * @param userId User who must own the automation.
   * @param automationId Automation identifier.
   * @param input Automation update input.
   * @returns Updated automation record.
   */
  public updateAutomation(
    userId: string,
    automationId: string,
    input: UpdateAutomationRequest
  ): AutomationRecord {
    const automation = this.getAutomation(userId, automationId);

    const updatedAutomation: AutomationRecord = {
      ...automation,
      status: input.status,
      updatedAt: new Date().toISOString(),
    };

    this.automationsByUserId.get(userId)?.set(automationId, updatedAutomation);
    return updatedAutomation;
  }

  /**
   * Delete one automation definition.
   *
   * @param userId User who must own the automation.
   * @param automationId Automation identifier.
   * @throws When the record does not exist in the user's private collection.
   */
  public deleteAutomation(userId: string, automationId: string): void {
    const automations = this.automationsByUserId.get(userId);

    if (!automations?.delete(automationId)) {
      throw new AutomationRecordNotFoundError(`Automation not found: ${automationId}`);
    }

    if (automations.size === 0) {
      this.automationsByUserId.delete(userId);
    }
  }
}
