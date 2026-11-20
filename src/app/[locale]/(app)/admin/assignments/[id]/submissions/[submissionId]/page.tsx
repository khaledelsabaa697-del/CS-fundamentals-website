import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { GradeSubmissionButton } from "@/components/admin/grade-submission-button";
import { ReviewForm } from "@/components/admin/review-form";
import {
  Alert,
  Card,
  CardHeader,
  PageHeader,
  badgeClass,
} from "@/components/ui";
import { requireStaff } from "@/lib/auth";
import { toLocale } from "@/lib/locale";
import { createClient } from "@/lib/supabase/server";
import { gradingStatus } from "@/lib/grading/service";
import { formatDate, formatNumber, stringList } from "@/lib/utils";
import { idSchema } from "@/lib/validation";
import type { SubmissionStatus } from "@/lib/types";

export const maxDuration = 60;

type ReviewRow = {
  id: string;
  assignment_id: string;
  file_path: string;
  code_text: string;
  submission_type: "file" | "text";
  ai_score: number | string | null;
  ai_feedback: string | null;
  ai_feedback_ar: string | null;
  ai_issues: unknown;
  ai_model: string | null;
  ai_graded_at: string | null;
  final_score: number | string | null;
  status: SubmissionStatus;
  created_at: string;
  grading_error: string | null;
  assignments: { id: string; title: string; max_score: number | string } | null;
  profiles: {
    full_name: string;
    username: string;
    student_code: string;
  } | null;
};

export default async function SubmissionReviewPage({
  params,
}: {
  params: Promise<{ locale: string; id: string; submissionId: string }>;
}) {
  const { locale: raw, id, submissionId } = await params;
  const locale = toLocale(raw);
  setRequestLocale(locale);

  await requireStaff(locale);

  const assignmentId = idSchema.safeParse(id);
  const parsedSubmissionId = idSchema.safeParse(submissionId);
  if (!assignmentId.success || !parsedSubmissionId.success) notFound();

  const t = await getTranslations("admin.review");
  const ts = await getTranslations("submissionStatus");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("submissions")
    .select(
      "id, assignment_id, file_path, code_text, submission_type, ai_score, ai_feedback, ai_feedback_ar, ai_issues, ai_model, ai_graded_at, final_score, status, created_at, grading_error, assignments!submissions_assignment_id_fkey(id, title, max_score), profiles!submissions_student_id_fkey(full_name, username, student_code)",
    )
    .eq("id", parsedSubmissionId.data)
    .eq("assignment_id", assignmentId.data)
    .maybeSingle()
    .returns<ReviewRow | null>();

  if (error || !data || !data.assignments) notFound();

  const assignment = data.assignments;
  const student = data.profiles;
  const maxScore = Number(assignment.max_score) || 100;
  const aiScore = data.ai_score === null ? null : Number(data.ai_score);
  const finalScore = data.final_score === null ? null : Number(data.final_score);
  const issues = stringList(data.ai_issues);
  const grading = gradingStatus();

  const { data: signed } = await supabase.storage
    .from("submissions")
    .createSignedUrl(data.file_path, 600);
  const signedUrl = signed?.signedUrl ?? null;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/admin/assignments/${assignment.id}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 transition hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-4 rtl:-scale-x-100"
            aria-hidden="true"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
          {t("back")}
        </Link>
      </div>

      <PageHeader
        title={student?.full_name ?? t("title")}
        description={[
          student ? `@${student.username}` : null,
          student?.student_code ?? null,
          assignment.title,
          formatDate(data.created_at, locale, {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        ]
          .filter(Boolean)
          .join(" · ")}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <span className={badgeClass}>
              {aiScore === null
                ? t("noAiScore")
                : t("aiScoreShort", {
                    score: formatNumber(aiScore, locale, 1),
                    max: formatNumber(maxScore, locale),
                  })}
            </span>
            <span className={`${badgeClass} bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200`}>
              {data.submission_type === "text" ? t("typeText") : t("typeFile")}
            </span>
            <span
              className={
                data.status === "graded"
                  ? "rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                  : data.status === "flagged"
                    ? "rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
                    : "rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              }
            >
              {ts(data.status)}
            </span>
          </div>
        }
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title={t("codeTitle")}
              action={
                signedUrl ? (
                  <a
                    href={signedUrl}
                    download
                    className="text-sm font-medium text-primary-600 hover:text-primary-500 dark:text-primary-400"
                  >
                    {t("download")}
                  </a>
                ) : null
              }
            />
            <pre
              dir="ltr"
              className="max-h-[34rem] overflow-auto rounded-b-2xl bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-100"
            >
              {data.code_text}
            </pre>
          </Card>

          <Card>
            <CardHeader
              title={t("aiTitle")}
              description={
                data.ai_model
                  ? t("aiSubtitle", {
                      model: data.ai_model,
                      date: data.ai_graded_at
                        ? formatDate(data.ai_graded_at, locale, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })
                        : "—",
                    })
                  : undefined
              }
            />
            <div className="space-y-5 p-5">
              {data.grading_error ? (
                <Alert>
                  {t("lastError", { message: data.grading_error.slice(0, 200) })}
                </Alert>
              ) : null}

              {data.ai_feedback === null && data.ai_feedback_ar === null ? (
                <Alert tone="info">{t("aiMissing")}</Alert>
              ) : (
                <>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      {t("feedbackEn")}
                    </p>
                    <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-700 dark:text-slate-200">
                      {data.ai_feedback ?? "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      {t("feedbackAr")}
                    </p>
                    <p
                      dir="rtl"
                      className="mt-1 whitespace-pre-line text-sm leading-relaxed text-slate-700 dark:text-slate-200"
                    >
                      {data.ai_feedback_ar ?? "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      {t("issues")}
                    </p>
                    {issues.length === 0 ? (
                      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                        {t("noIssues")}
                      </p>
                    ) : (
                      <ul className="mt-1 list-disc space-y-1 ps-5 text-sm text-slate-600 dark:text-slate-300">
                        {issues.map((issue, index) => (
                          <li key={index}>{issue}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <ReviewForm
            locale={locale}
            submissionId={data.id}
            maxScore={maxScore}
            aiScore={aiScore}
            finalScore={finalScore}
            status={data.status}
          />

          <Card>
            <CardHeader title={t("regradeTitle")} description={t("regradeSubtitle")} />
            <div className="p-5">
              {grading.configured ? (
                <GradeSubmissionButton locale={locale} submissionId={data.id} />
              ) : (
                <Alert tone="info">{t("errors.gradingNotConfigured")}</Alert>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
