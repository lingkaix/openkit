/**
 * Automation definition stored by nanocore.
 */
export interface AutomationRecord {
  /** Stable automation identifier. */
  readonly id: string;
  /** User-facing automation name. */
  readonly name: string;
  /** Workspace the automation will target when enabled. */
  readonly workspaceId: string;
  /** Cron expression supplied by the UI. */
  readonly cron: string;
  /** Prompt that will be sent when the automation executes. */
  readonly prompt: string;
  /** Current automation state. */
  readonly status: 'paused' | 'enabled';
  /** ISO timestamp for creation. */
  readonly createdAt: string;
  /** ISO timestamp for last update. */
  readonly updatedAt: string;
}

/**
 * Input for creating one automation definition.
 */
export interface CreateAutomationInput {
  /** User-facing automation name. */
  readonly name: string;
  /** Target workspace ID. */
  readonly workspaceId: string;
  /** Cron expression supplied by the UI. */
  readonly cron: string;
  /** Prompt to send during execution. */
  readonly prompt: string;
}

/**
 * Input for updating one automation definition.
 */
export interface UpdateAutomationInput {
  /** New automation status. */
  readonly status: AutomationRecord['status'];
}

/**
 * App-local automation definition store.
 */
export class AutomationStore {
  private readonly automations = new Map<string, AutomationRecord>();

  /**
   * Return all automation definitions.
   *
   * @returns Automation records.
   */
  public listAutomations(): AutomationRecord[] {
    return [...this.automations.values()];
  }

  /**
   * Create a paused automation definition.
   *
   * @param input Automation creation input.
   * @returns Created automation record.
   */
  public createAutomation(input: CreateAutomationInput): AutomationRecord {
    const timestamp = new Date().toISOString();
    const automation: AutomationRecord = {
      id: `auto_${this.automations.size + 1}`,
      ...input,
      status: 'paused',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.automations.set(automation.id, automation);
    return automation;
  }

  /**
   * Update one automation definition.
   *
   * @param automationId Automation identifier.
   * @param input Automation update input.
   * @returns Updated automation record.
   */
  public updateAutomation(automationId: string, input: UpdateAutomationInput): AutomationRecord {
    const automation = this.automations.get(automationId);

    if (!automation) {
      throw new Error(`Automation not found: ${automationId}`);
    }

    const updatedAutomation: AutomationRecord = {
      ...automation,
      status: input.status,
      updatedAt: new Date().toISOString(),
    };

    this.automations.set(automationId, updatedAutomation);
    return updatedAutomation;
  }

  /**
   * Delete one automation definition.
   *
   * @param automationId Automation identifier.
   */
  public deleteAutomation(automationId: string): void {
    if (!this.automations.delete(automationId)) {
      throw new Error(`Automation not found: ${automationId}`);
    }
  }
}
