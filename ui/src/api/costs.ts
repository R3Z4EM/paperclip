import type {
  CostSummary,
  CostDataQualityReport,
  CostByAgent,
  CostByUserReport,
  CostByProviderModel,
  CostByBiller,
  CostByAgentModel,
  CostByProject,
  CostWindowSpendRow,
  FinanceSummary,
  FinanceByBiller,
  FinanceByKind,
  FinanceEvent,
  ProviderQuotaResult,
} from "@paperclipai/shared";
import { api } from "./client";

/** A Claude subscription account's saved usage (server/src/services/ai-account-usage.ts). */
export type AiAccountUsageWindow = { usedPercent: number | null; resetsAt: string | null };
export type AiAccountUsage = {
  connectionId: string;
  name: string;
  status: "ok" | "needs_sign_in" | "unavailable" | "error";
  message: string | null;
  plan: string | null;
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  session: AiAccountUsageWindow | null;
  weekly: AiAccountUsageWindow | null;
  history: { at: string; session: number | null; weekly: number | null }[];
};

function dateParams(from?: string, to?: string): string {
  const params = new URLSearchParams();
  if (!from && !to) params.set("period", "all");
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const costsApi = {
  dataQuality: (companyId: string, from?: string, to?: string) =>
    api.get<CostDataQualityReport>(`/companies/${companyId}/costs/data-quality${dateParams(from, to)}`),
  retryAccounting: (companyId: string, runId: string) =>
    api.post<{ accounted: boolean }>(`/companies/${companyId}/costs/retry-accounting`, { runId }),
  summary: (companyId: string, from?: string, to?: string) =>
    api.get<CostSummary>(`/companies/${companyId}/costs/summary${dateParams(from, to)}`),
  byUser: (companyId: string, from?: string, to?: string) =>
    api.get<CostByUserReport>(`/companies/${companyId}/costs/by-user${dateParams(from, to)}`),
  byAgent: (companyId: string, from?: string, to?: string) =>
    api.get<CostByAgent[]>(`/companies/${companyId}/costs/by-agent${dateParams(from, to)}`),
  byAgentModel: (companyId: string, from?: string, to?: string) =>
    api.get<CostByAgentModel[]>(`/companies/${companyId}/costs/by-agent-model${dateParams(from, to)}`),
  byProject: (companyId: string, from?: string, to?: string) =>
    api.get<CostByProject[]>(`/companies/${companyId}/costs/by-project${dateParams(from, to)}`),
  byProvider: (companyId: string, from?: string, to?: string) =>
    api.get<CostByProviderModel[]>(`/companies/${companyId}/costs/by-provider${dateParams(from, to)}`),
  byBiller: (companyId: string, from?: string, to?: string) =>
    api.get<CostByBiller[]>(`/companies/${companyId}/costs/by-biller${dateParams(from, to)}`),
  financeSummary: (companyId: string, from?: string, to?: string) =>
    api.get<FinanceSummary>(`/companies/${companyId}/costs/finance-summary${dateParams(from, to)}`),
  financeByBiller: (companyId: string, from?: string, to?: string) =>
    api.get<FinanceByBiller[]>(`/companies/${companyId}/costs/finance-by-biller${dateParams(from, to)}`),
  financeByKind: (companyId: string, from?: string, to?: string) =>
    api.get<FinanceByKind[]>(`/companies/${companyId}/costs/finance-by-kind${dateParams(from, to)}`),
  financeEvents: (companyId: string, from?: string, to?: string, limit: number = 100) =>
    api.get<FinanceEvent[]>(`/companies/${companyId}/costs/finance-events${dateParamsWithLimit(from, to, limit)}`),
  windowSpend: (companyId: string) =>
    api.get<CostWindowSpendRow[]>(`/companies/${companyId}/costs/window-spend`),
  quotaWindows: (companyId: string) =>
    api.get<ProviderQuotaResult[]>(`/companies/${companyId}/costs/quota-windows`),
  aiAccounts: (companyId: string) =>
    api.get<AiAccountUsage[]>(`/companies/${companyId}/costs/ai-accounts`),
};

function dateParamsWithLimit(from?: string, to?: string, limit?: number): string {
  const params = new URLSearchParams();
  if (!from && !to) params.set("period", "all");
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
