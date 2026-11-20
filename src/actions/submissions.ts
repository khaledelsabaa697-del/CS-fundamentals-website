"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { getCurrentProfile } from "@/lib/auth";
import { toLocale } from "@/lib/locale";
import { createClient } from "@/lib/supabase/server";
import {
  idSchema,
  MAX_SUBMISSION_BYTES,
  MAX_SUBMISSION_CHARS,
  textSubmissionSchema,
} from "@/lib/validation";
import { rateLimit } from "@/lib/rate-limit";
import { gradeSubmissionById } from "@/lib/grading/service";
import type { SubmitAssignmentState } from "@/lib/types";

type AssignmentRow = {
  id: string;
  deadline: string | null;
  allow_resubmit: boolean;
  allowed_submission_types: "file" | "text" | "both";
};

/** Maximum resubmits/attempts from one student per 10 minutes. */
const UPLOAD_LIMIT = 5;
const UPLOAD_WINDOW_MS = 10 * 60_000;

export async function submitAssignmentAction(
  _previous: SubmitAssignmentState,
  formData: FormData,
): Promise<SubmitAssignmentState> {
  const locale = toLocale(formData.get("locale"));
  const t = await getTranslations({ locale, namespace: "assignments" });

  const profile = await getCurrentProfile();
  if (!profile || profile.role !== "student") {
    return { status: "error", error: t("errors.forbidden") };
  }

  const assignmentId = idSchema.safeParse(formData.get("assignment_id"));
  if (!assignmentId.success) {
    return { status: "error", error: t("errors.invalid") };
  }

  const submissionType = formData.get("submission_type") as "file" | "text" | null;

  const supabase = await createClient();

  const { data: assignment, error: assignmentError } = await supabase
    .from("assignments")
    .select("id, deadline, allow_resubmit, allowed_submission_types")
    .eq("id", assignmentId.data)
    .maybeSingle()
    .returns<AssignmentRow | null>();

  if (assignmentError || !assignment) {
    return { status: "error", error: t("errors.notFound") };
  }

  if (assignment.deadline && Date.parse(assignment.deadline) <= Date.now()) {
    return { status: "error", error: t("errors.deadlinePassed") };
  }

  // Check if submission type is allowed for this assignment
  if (submissionType && assignment.allowed_submission_types !== "both" && assignment.allowed_submission_types !== submissionType) {
    return { status: "error", error: t("errors.invalidType") };
  }

  if (!assignment.allow_resubmit) {
    const { count } = await supabase
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("assignment_id", assignment.id)
      .eq("student_id", profile.id);

    if ((count ?? 0) > 0) {
      return { status: "error", error: t("errors.resubmitNotAllowed") };
    }
  }

  const limit = rateLimit(`submit:${profile.id}`, UPLOAD_LIMIT, UPLOAD_WINDOW_MS);
  if (!limit.ok) {
    return {
      status: "error",
      error: t("errors.tooManyUploads", { seconds: limit.retryAfterSeconds }),
    };
  }

  let codeText: string;
  let filePath: string | null = null;

  if (submissionType === "text") {
    const code = formData.get("code_text") as string | null;
    if (!code) {
      return { status: "error", error: t("errors.codeMissing") };
    }
    const parsed = textSubmissionSchema.safeParse({ code });
    if (!parsed.success) {
      return { status: "error", error: t("errors.codeInvalid") };
    }
    codeText = parsed.data.code;
  } else {
    // File upload (default)
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return { status: "error", error: t("errors.fileMissing") };
    }
    if (!/\.cpp$/i.test(file.name)) {
      return { status: "error", error: t("errors.fileType") };
    }
    if (file.size > MAX_SUBMISSION_BYTES) {
      return { status: "error", error: t("errors.fileSize") };
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_SUBMISSION_BYTES) {
      return { status: "error", error: t("errors.fileSize") };
    }

    codeText = new TextDecoder("utf-8").decode(bytes);
    if (bytes.includes(0) || codeText.includes("\uFFFD")) {
      return { status: "error", error: t("errors.fileNotText") };
    }
    if (!codeText.trim()) {
      return { status: "error", error: t("errors.fileEmpty") };
    }
    if (codeText.length > MAX_SUBMISSION_CHARS) {
      return { status: "error", error: t("errors.fileSize") };
    }

    // Upload file to storage
    filePath = `${profile.id}/${assignment.id}/${Date.now()}-${crypto
      .randomUUID()
      .slice(0, 8)}.cpp`;

    const { error: uploadError } = await supabase.storage
      .from("submissions")
      .upload(filePath, bytes, {
        contentType: "text/x-c++src",
        upsert: false,
      });

    if (uploadError) {
      console.error("submitAssignmentAction upload failed:", uploadError.message);
      const isDev = process.env.NODE_ENV !== "production";
      return {
        status: "error",
        error: isDev
          ? `${t("errors.uploadFailed")}: ${uploadError.message}`
          : t("errors.uploadFailed"),
      };
    }
  }

  const { data: inserted, error: insertError } = await supabase
    .from("submissions")
    .insert({
      assignment_id: assignment.id,
      student_id: profile.id,
      file_path: filePath,
      code_text: codeText,
      submission_type: submissionType ?? "file",
    })
    .select("id")
    .single()
    .returns<{ id: string } | null>();

  if (insertError || !inserted) {
    console.error("submitAssignmentAction insert failed:", insertError?.message);
    if (filePath) {
      await supabase.storage.from("submissions").remove([filePath]);
    }
    // In development, show the actual error for debugging; in production, keep it generic
    const isDev = process.env.NODE_ENV !== "production";
    return {
      status: "error",
      error: isDev && insertError?.message
        ? `${t("errors.saveFailed")}: ${insertError.message}`
        : t("errors.saveFailed"),
    };
  }

  // Grade immediately when possible. A failure leaves the row pending; the
  // teacher's queue ("Grade queued") can retry it.
  const outcome = await gradeSubmissionById(inserted.id, { maxAttempts: 1 });

  revalidatePath(`/${locale}/assignments`);
  revalidatePath(`/${locale}/assignments/${assignment.id}`);
  revalidatePath(`/${locale}/dashboard`);
  revalidatePath(`/${locale}/admin/assignments`);
  revalidatePath(`/${locale}/admin/assignments/${assignment.id}`);

  if (outcome.ok) {
    return {
      status: "success",
      message: t("submittedGraded", { score: outcome.score }),
      grading: "graded",
      score: outcome.score,
    };
  }

  return {
    status: "success",
    message: t("submittedQueued"),
    grading: outcome.reason === "config" ? "failed" : "queued",
    score: null,
  };
}
