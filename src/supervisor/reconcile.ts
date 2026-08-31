/**
 * Startup reconciliation.
 *
 * UNIX accounts, cgroups and namespaces live in the container, not the volume,
 * so recreating the container wipes them while the database still describes
 * every project. This rebuilds the system to match the record.
 *
 * It never repairs a disagreement on its own: reassigning a uid under a
 * running system could hand one project's files to another, so conflicts are
 * reported for a human to settle.
 */

import type { StoredProject } from "./store";

export type SystemState = {
  /** Accounts that already exist, by project name. */
  existingAccounts: Map<string, number>;
  /** Projects that have content on disk. */
  existingSites: Set<string>;
  createAccount: (name: string, uid: number) => Promise<void>;
};

export type ReconcileReport = {
  recreated: string[];
  failed: string[];
  discrepancies: string[];
};

export async function reconcile(
  projects: StoredProject[],
  system: SystemState,
): Promise<ReconcileReport> {
  const report: ReconcileReport = { recreated: [], failed: [], discrepancies: [] };

  for (const project of projects) {
    const existingUid = system.existingAccounts.get(project.name);

    if (existingUid === project.uid) continue;

    if (existingUid !== undefined) {
      report.discrepancies.push(
        `Project '${project.name}' is recorded with uid ${project.uid} but the ` +
          `system account has uid ${existingUid}. Left untouched: reassigning it ` +
          "could transfer ownership of another project's files.",
      );
      continue;
    }

    try {
      await system.createAccount(project.name, project.uid);
      report.recreated.push(project.name);
    } catch (error) {
      // One broken project must not leave the whole instance down.
      report.failed.push(project.name);
      report.discrepancies.push(
        `Could not restore project '${project.name}': ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  const recorded = new Set(projects.map((project) => project.name));
  for (const site of system.existingSites) {
    if (!recorded.has(site)) {
      report.discrepancies.push(
        `Content for '${site}' exists on disk but no project is recorded for it.`,
      );
    }
  }

  return report;
}

/** Renders a report for the startup log. */
export function formatReport(report: ReconcileReport): string {
  const lines: string[] = [];
  if (report.recreated.length > 0) {
    lines.push(`restored ${report.recreated.length} project(s)`);
  }
  if (report.failed.length > 0) {
    lines.push(`FAILED to restore: ${report.failed.join(", ")}`);
  }
  for (const discrepancy of report.discrepancies) {
    lines.push("  ! " + discrepancy);
  }
  return lines.join("\n");
}
