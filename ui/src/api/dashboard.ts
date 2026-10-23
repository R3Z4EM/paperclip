import type { DashboardSummary } from "@paperclipai/shared";
import { api } from "./client";

/** The signed-in person's Dashboard cards: their order and which are hidden. */
export type DashboardLayout = { order: string[]; hidden: string[] };

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  layout: (companyId: string) =>
    api.get<{ layout: DashboardLayout | null }>(`/companies/${companyId}/dashboard-layout/me`),
  // null resets to the default layout.
  saveLayout: (companyId: string, layout: DashboardLayout | null) =>
    api.put<{ layout: DashboardLayout | null }>(`/companies/${companyId}/dashboard-layout/me`, { layout }),
};
