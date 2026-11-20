import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { AssignmentForm } from "@/components/admin/assignment-form";
import {
  Alert,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  buttonSecondary,
} from "@/components/ui";
import { requireStaff } from "@/lib/auth";
import { toLocale } from "@/lib/locale";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatNumber } from "@/lib/utils";
import type { AssignmentOverview } from "@/lib/types";

type AssignmentRow = {
  id: string;
  title: string;
  description: string;
  deadline: string | null;
  max_score: number | string;
  allow_resubmit: boolean;
};

export default async function AdminAssignmentsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  const locale = toLocale(raw);
  setRequestLocale(locale);

  await requireStaff(locale);
  const t = await getTranslations("admin.assignments");

  const supabase = await createClient();
  const [assignmentsResult, overviewResult] = await Promise.all([
    supabase
      .from("assignments")
      .select("id, title, description, deadline, max_score, allow_resubmit")
      .order("deadline", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .returns<AssignmentRow[]>(),
    supabase.rpc("admin_assignment_overview"),
  ]);

  const overviewById = new Map(
    ((overviewResult.data ?? []) as AssignmentOverview[]).map((row) => [
      row.assignment_id,
      row,
    ]),
  );

  const assignments = assignmentsResult.data ?? [];
  const now = Date.now();

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      {assignmentsResult.error ? <Alert>{t("loadError")}</Alert> : null}
      {overviewResult.error ? <Alert>{t("overviewError")}</Alert> : null}

      <AssignmentForm locale={locale} mode="create" />

      <Card>
        <CardHeader title={t("listTitle")} />
        {assignments.length === 0 ? (
          <div className="p-5">
            <EmptyState title={t("empty")} description={t("emptyHint")} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-950/40 dark:text-slate-400">
                <tr>
                  <th scope="col" className="px-5 py-3 text-start font-medium">{t("colAssignment")}</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">{t("colDeadline")}</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">{t("colSubmitted")}</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">{t("colPending")}</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">{t("colAverage")}</th>
                  <th scope="col" className="px-5 py-3 text-start font-medium">{t("colStatus")}</th>
                  <th scope="col" className="px-5 py-3 text-end font-medium">{t("colManage")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {assignments.map((assignment) => {
                  const overview = overviewById.get(assignment.id);
                  const open =
                    !assignment.deadline || Date.parse(assignment.deadline) > now;
                  const pending = overview?.pending_count ?? 0;

                  return (
                    <tr key={assignment.id}>
                      <td className="max-w-72 px-5 py-3.5">
                        <p className="truncate font-medium text-slate-900 dark:text-white">
                          {assignment.title}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                          {assignment.description || t("noDescription")}
                        </p>
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5 text-xs text-slate-500 dark:text-slate-400">
                        {assignment.deadline
                          ? formatDate(assignment.deadline, locale, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })
                          : t("noDeadline")}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5">
                        {overview ? (
                          <span className="text-slate-700 dark:text-slate-200">
                            {t("studentsSubmitted", {
                              submitted: formatNumber(overview.student_count, locale),
                              total: formatNumber(overview.class_size, locale),
                            })}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5">
                        {pending > 0 ? (
                          <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                            {formatNumber(pending, locale)}
                          </span>
                        ) : (
                          <span className="text-slate-400">0</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5">
                        {overview?.average_percent === null ||
                        overview?.average_percent === undefined ? (
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {t("noAverage")}
                          </span>
                        ) : (
                          <span className="font-medium text-slate-900 dark:text-white">
                            {formatNumber(overview.average_percent, locale, 1)}%
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5">
                        <span
                          className={
                            open
                              ? "rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                              : "rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                          }
                        >
                          {open ? t("open") : t("closed")}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5 text-end">
                        <Link
                          href={`/admin/assignments/${assignment.id}`}
                          className={`${buttonSecondary} px-3 py-1.5 text-xs`}
                        >
                          {t("manage")}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
