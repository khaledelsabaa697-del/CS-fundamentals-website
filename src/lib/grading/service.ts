import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SubmissionStatus } from "@/lib/types";
import { GradingError, gradeCode, providerConfig, isGradingConfigured } from "./provider";

export const MAX_GRADING_ATTEMPTS = 3;

/** A lock older than this is treated as abandoned (crashed function). */
const STALE_LOCK_MS = 2 * 60_000;

type SubmissionRow = {
  id: string;
  code_text: string;
  status: SubmissionStatus;
  final_score: number | string | null;
  graded_by: string | null;
  grading_attempts: number;
  grading_locked_at: string | null;
  assignments: {
    title: string;
    description: string;
    rubric: string;
    expected_output: string | null;
    max_score: number | string;
  } | null;
};

export type GradeFailure =
  | "notFound"
  | "locked"
  | "attempts"
  | "config"
  | "rateLimited"
  | "timeout"
  | "api"
  | "invalid";

export type GradeOutcome =
  | { ok: true; score: number; model: string; mock: boolean }
  | { ok: false; reason: GradeFailure; message: string };

export type QueueOutcome = {
  graded: number;
  failed: number;
  remaining: number;
};

function adminOrNull(): SupabaseClient | null {
  try {
    return createAdminClient();
  } catch (error) {
    console.error(
      "Grading is unavailable:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Grades exactly one submission: claims it with an optimistic lock, calls the
 * grader, then stores the result. Uses the service role because students may
 * never write grading columns.
 *
 * `force` lets a teacher re-grade after the automatic attempts are used up.
 */
export async function gradeSubmissionById(
  submissionId: string,
  options: { force?: boolean; maxAttempts?: number } = {},
): Promise<GradeOutcome> {
  if (!isGradingConfigured()) {
    return { ok: false, reason: "config", message: "Grading is not configured." };
  }

  const admin = adminOrNull();
  if (!admin) {
    return { ok: false, reason: "config", message: "Grading is not available." };
  }

  const { data, error } = await admin
    .from("submissions")
    .select(
      "id, code_text, status, final_score, graded_by, grading_attempts, grading_locked_at, assignments(title, description, rubric, expected_output, max_score)",
    )
    .eq("id", submissionId)
    .maybeSingle()
    .returns<SubmissionRow | null>();

  if (error || !data) {
    console.error("gradeSubmissionById lookup failed:", error?.message);
    return { ok: false, reason: "notFound", message: "Submission not found." };
  }

  const attempts = toNumber(data.grading_attempts) ?? 0;

  if (attempts >= 50) {
    return { ok: false, reason: "attempts", message: "This submission was retried too often." };
  }

  if (!options.force && attempts >= MAX_GRADING_ATTEMPTS) {
    return { ok: false, reason: "attempts", message: "Automatic grading was already retried." };
  }

  if (
    data.grading_locked_at &&
    Date.now() - Date.parse(data.grading_locked_at) < STALE_LOCK_MS
  ) {
    return { ok: false, reason: "locked", message: "This submission is already being graded." };
  }

  // Optimistic claim: only one worker can move `grading_attempts` forward.
  const { data: claimed, error: claimError } = await admin
    .from("submissions")
    .update({
      grading_locked_at: new Date().toISOString(),
      grading_attempts: attempts + 1,
      grading_error: null,
    })
    .eq("id", submissionId)
    .eq("grading_attempts", attempts)
    .select("id")
    .returns<Array<{ id: string }>>();

  if (claimError || !claimed || claimed.length === 0) {
    console.error("gradeSubmissionById claim failed:", claimError?.message);
    return { ok: false, reason: "locked", message: "This submission is already being graded." };
  }

  const assignment = data.assignments;
  if (!assignment) {
    await admin
      .from("submissions")
      .update({ grading_locked_at: null, grading_error: "Assignment missing." })
      .eq("id", submissionId);
    return { ok: false, reason: "notFound", message: "Assignment not found." };
  }

  const maxScore = toNumber(assignment.max_score) ?? 100;

  try {
    const result = await gradeCode(
      {
        title: assignment.title,
        description: assignment.description,
        rubric: assignment.rubric,
        expectedOutput: assignment.expected_output,
        maxScore,
        code: data.code_text,
      },
      { maxAttempts: options.maxAttempts },
    );

    const now = new Date().toISOString();
    const existingFinal = toNumber(data.final_score);
    const patch: Record<string, unknown> = {
      ai_score: result.response.score,
      ai_feedback: result.response.feedback_en,
      ai_feedback_ar: result.response.feedback_ar,
      ai_issues: result.response.issues,
      ai_model: result.model,
      ai_graded_at: now,
      grading_locked_at: null,
      grading_error: null,
    };

    // Never overwrite a teacher's score or flag; only fill in what is missing.
    if (existingFinal === null) {
      patch.final_score = result.response.score;
      patch.graded_at = now;
      patch.graded_by = "ai";
      if (data.status !== "flagged") patch.status = "graded";
    } else if (data.status === "pending") {
      patch.status = "graded";
      patch.graded_at = now;
      patch.graded_by = data.graded_by ?? "ai";
    }

    const { error: saveError } = await admin
      .from("submissions")
      .update(patch)
      .eq("id", submissionId);

    if (saveError) {
      console.error("gradeSubmissionById save failed:", saveError.message);
      await admin
        .from("submissions")
        .update({ grading_locked_at: null, grading_error: `save_failed: ${saveError.message}`.slice(0, 500) })
        .eq("id", submissionId);
      return { ok: false, reason: "api", message: "Could not save the grade." };
    }

    return {
      ok: true,
      score: result.response.score,
      model: result.model,
      mock: result.mock,
    };
  } catch (error) {
    const failure =
      error instanceof GradingError
        ? error
        : new GradingError("api", "Grading failed.");

    await admin
      .from("submissions")
      .update({
        grading_locked_at: null,
        grading_error: `${failure.code}: ${failure.message}`.slice(0, 500),
      })
      .eq("id", submissionId);

    return { ok: false, reason: failure.code, message: failure.message };
  }
}

/**
 * Processes a small batch of pending submissions for one assignment, oldest
 * first. Batches stay small so a serverless function can finish in time; the
 * teacher can click again for the rest.
 */
export async function gradePendingForAssignment(
  assignmentId: string,
  limit = 3,
): Promise<QueueOutcome> {
  const admin = adminOrNull();
  if (!admin) return { graded: 0, failed: 0, remaining: 0 };

  const { data: pending, error } = await admin
    .from("submissions")
    .select("id")
    .eq("assignment_id", assignmentId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(Math.min(5, Math.max(1, limit)))
    .returns<Array<{ id: string }>>();

  if (error) {
    console.error("gradePendingForAssignment lookup failed:", error.message);
    return { graded: 0, failed: 0, remaining: 0 };
  }

  let graded = 0;
  let failed = 0;

  for (const row of pending ?? []) {
    const outcome = await gradeSubmissionById(row.id, { maxAttempts: 2 });
    if (outcome.ok) graded += 1;
    else failed += 1;
  }

  const { count } = await admin
    .from("submissions")
    .select("id", { count: "exact", head: true })
    .eq("assignment_id", assignmentId)
    .eq("status", "pending");

  return { graded, failed, remaining: count ?? 0 };
}

/** Used by the admin screens to explain why grading is / is not available. */
export function gradingStatus(): { configured: boolean; mock: boolean; model: string } {
  const config = providerConfig();
  return {
    configured: Boolean(config.apiKey) || config.mock,
    mock: config.mock,
    model: config.model,
  };
}
