import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, SlidersHorizontal } from "lucide-react";
import { dashboardApi, type DashboardLayout } from "../api/dashboard";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

/**
 * The Dashboard's cards in their default order. `half` cards sit two to a row when they are next
 * to each other. Ids are what the server saves (server/src/services/dashboard-layouts.ts).
 */
export const DASHBOARD_CARDS = [
  { id: "active-agents", label: "Active agents" },
  { id: "metrics", label: "Summary numbers (agents, tasks, spend, approvals)" },
  { id: "smoke-lab", label: "Integration smoke (only when Smoke Lab is on)" },
  { id: "ai-accounts", label: "AI accounts" },
  { id: "charts", label: "Charts (run activity, tasks, success rate)" },
  { id: "plugin-widgets", label: "Plugin widgets" },
  { id: "recent-activity", label: "Recent activity", half: true },
  { id: "recent-tasks", label: "Recent tasks", half: true },
] as const;

export type DashboardCardId = (typeof DASHBOARD_CARDS)[number]["id"];

const KNOWN = new Set<string>(DASHBOARD_CARDS.map((card) => card.id));

/** Every card in the person's order (cards added since they saved go last) with its visibility. */
export function resolveDashboardLayout(saved: DashboardLayout | null | undefined) {
  const order = (saved?.order ?? []).filter((id): id is DashboardCardId => KNOWN.has(id));
  for (const card of DASHBOARD_CARDS) if (!order.includes(card.id)) order.push(card.id);
  const hidden = new Set(saved?.hidden ?? []);
  return order.map((id) => ({ ...DASHBOARD_CARDS.find((card) => card.id === id)!, visible: !hidden.has(id) }));
}

/** The saved layout for the signed-in person (null while loading or never customized). */
export function useDashboardLayout(companyId: string | null) {
  return useQuery({
    queryKey: queryKeys.dashboardLayout(companyId!),
    queryFn: () => dashboardApi.layout(companyId!),
    enabled: !!companyId,
    select: (data) => data.layout,
  });
}

export function DashboardCustomizeButton({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { data: saved } = useDashboardLayout(companyId);
  const cards = resolveDashboardLayout(saved);

  // Saves on every change; the Dashboard updates at once and rolls back if the save fails.
  const save = useMutation({
    mutationFn: (layout: DashboardLayout | null) => dashboardApi.saveLayout(companyId, layout),
    onMutate: async (layout) => {
      const key = queryKeys.dashboardLayout(companyId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData(key);
      queryClient.setQueryData(key, { layout });
      return { previous };
    },
    onError: (_error, _layout, context) => {
      queryClient.setQueryData(queryKeys.dashboardLayout(companyId), context?.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.dashboardLayout(companyId) }),
  });

  const apply = (next: typeof cards) =>
    save.mutate({ order: next.map((card) => card.id), hidden: next.filter((card) => !card.visible).map((card) => card.id) });

  const move = (index: number, by: number) => {
    const next = [...cards];
    const [card] = next.splice(index, 1);
    next.splice(index + by, 0, card);
    apply(next);
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="dashboard-customize">
        <SlidersHorizontal className="h-4 w-4" />
        Customize
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>Customize Dashboard</DialogTitle>
          <DialogDescription>
            Choose which cards show and move them up or down. Saved for you only.
          </DialogDescription>
          <ul className="divide-y divide-border rounded-md border">
            {cards.map((card, index) => (
              <li key={card.id} className="flex items-center gap-3 px-3 py-2">
                <Checkbox
                  id={`dashboard-card-${card.id}`}
                  checked={card.visible}
                  onCheckedChange={(checked) =>
                    apply(cards.map((c) => (c.id === card.id ? { ...c, visible: checked === true } : c)))
                  }
                />
                <label htmlFor={`dashboard-card-${card.id}`} className="min-w-0 flex-1 cursor-pointer text-sm">
                  {card.label}
                </label>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${card.label} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${card.label} down`}
                  disabled={index === cards.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
          {save.isError && <p className="text-sm text-destructive">Could not save. Try again.</p>}
          <div className="flex justify-between gap-2">
            <Button variant="ghost" size="sm" disabled={!saved} onClick={() => save.mutate(null)}>
              Reset to default
            </Button>
            <Button size="sm" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
