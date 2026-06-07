/**
 * Compliance Audit Routes
 *
 * GET /api/projects/:projectId/compliance/audit   — Full auditable trail for
 *     every regulated key in the project (owner-only). JSON by default;
 *     `?format=csv` returns a flat CSV (one row per history event) with an
 *     attachment Content-Disposition header.
 * GET /api/projects/:projectId/compliance/summary — Roll-up counts of regulated
 *     keys (total / fully-approved / with-pending) for a dashboard banner.
 *
 * This is the sellable artifact of the compliance lock (see utils/compliance.ts
 * and the moat strategy): a regulated-fintech buyer can prove, per key, who
 * approved which copy, when, and against which regulator citation.
 *
 * Both routes are owner-only — the audit trail names individual approvers and
 * is the evidence a buyer hands to their regulator, so it stays scoped to the
 * project owner rather than every member.
 *
 * All routes are protected by authMiddleware + requireProjectRole("owner").
 */

import { Router, Response } from "express";
import { authMiddleware } from "../middleware/auth";
import { requireProjectRole, ProjectAuthRequest } from "../middleware/projectAuth";
import Translation from "../models/Translation";
import TranslationHistory from "../models/TranslationHistory";
import User from "../models/User";
import { sendSuccess, sendError } from "../utils/response";
import { validateObjectId } from "../utils/validate";
import { iterateCells, DEFAULT_REGISTER, Register } from "../utils/registers";

// mergeParams so :projectId from the mount path is visible here.
const router = Router({ mergeParams: true });
router.use(authMiddleware);

// Per-(lang, register) compliance status, read straight off the sources map.
// "approved" = AI draft a human owner reviewed; "human" = human-authored;
// "ai" = unreviewed AI draft; "pending" = a non-owner's edit held for approval.
// Anything else (incl. a missing source) is reported as "pending" so an
// unaccounted-for cell never reads as cleared.
type CellStatus = "approved" | "human" | "ai" | "pending";

function normalizeStatus(source: string | undefined): CellStatus {
  if (source === "approved" || source === "human" || source === "ai") return source;
  return "pending";
}

// A regulated cell is "cleared" for compliance when its copy is something the
// SDK will actually serve — human-authored or human-approved (mirrors
// canServe() in utils/compliance.ts). "ai" and "pending" are NOT cleared.
function isCleared(status: CellStatus): boolean {
  return status === "human" || status === "approved";
}

// Escape one CSV field per RFC 4180: wrap in double quotes if it contains a
// comma, quote, or newline, and double any embedded quotes. A leading
// =/+/-/@ (and tab/CR, per OWASP) is prefixed with a single quote to defuse
// spreadsheet formula injection (a `mandatedBy` citation or value is
// attacker-influenced text).
function csvField(value: unknown): string {
  let s = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ─── COMPLIANCE AUDIT (per-key trail) ───────────────────────
// For every regulated:true key in the project, return its citation, the
// current per-(lang, register) approval status, and the full history (each
// event with the approver resolved to { name, email }), newest-first.
router.get(
  "/audit",
  requireProjectRole("owner"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;
      const { format } = req.query;

      const idError = validateObjectId(projectId as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      // Only regulated keys are auditable — the lock guarantee (and therefore
      // the evidence a buyer needs) only applies to them.
      const translations = await Translation.find({ projectId, regulated: true }).sort({
        key: 1,
      });

      const translationIds = translations.map((t) => t._id);

      // Pull all history for these keys in ONE query, newest-first, then bucket
      // by translationId in memory — avoids a per-key history query.
      const historyDocs = translationIds.length
        ? await TranslationHistory.find({ translationId: { $in: translationIds } }).sort({
            createdAt: -1,
          })
        : [];

      // Batched approver resolution: collect every distinct changedBy id across
      // ALL history events, resolve them in a single User.find, then look up by
      // id. This is the no-N+1 requirement — one query regardless of key count.
      const approverIds = Array.from(
        new Set(historyDocs.map((h) => String(h.changedBy)).filter(Boolean))
      );
      const approvers = approverIds.length
        ? await User.find({ _id: { $in: approverIds } })
            .select("name email")
            .lean<{ _id: any; name: string; email: string }[]>()
        : [];
      const approverById = new Map(
        approvers.map((u) => [String(u._id), { name: u.name, email: u.email }])
      );
      const resolveApprover = (id: any) =>
        approverById.get(String(id)) || { name: "Unknown", email: "" };

      // Bucket history by translationId (already sorted newest-first globally,
      // which preserves newest-first within each bucket).
      const historyByTranslation = new Map<string, typeof historyDocs>();
      for (const h of historyDocs) {
        const k = String(h.translationId);
        if (!historyByTranslation.has(k)) historyByTranslation.set(k, []);
        historyByTranslation.get(k)!.push(h);
      }

      const keys = translations.map((t) => {
        // Current per-(lang, register) status from the sources map.
        const statuses: {
          lang: string;
          register: Register;
          status: CellStatus;
        }[] = [];
        for (const { lang, register, value } of iterateCells(t.sources as any)) {
          statuses.push({ lang, register, status: normalizeStatus(value) });
        }

        const history = (historyByTranslation.get(String(t._id)) || []).map((h) => ({
          lang: h.lang,
          register: (h.register || DEFAULT_REGISTER) as Register,
          oldValue: h.oldValue || "",
          newValue: h.newValue || "",
          source: h.source || "",
          changedBy: resolveApprover(h.changedBy),
          createdAt: h.createdAt,
        }));

        return {
          key: t.key,
          mandatedBy: (t as any).mandatedBy || "",
          // True only when there's at least one localized cell AND every cell is
          // cleared — an empty regulated key isn't "fully approved".
          fullyApproved:
            statuses.length > 0 && statuses.every((s) => isCleared(s.status)),
          statuses,
          history,
        };
      });

      // ─── CSV export ───────────────────────────────────────────
      // One row per history event so the file reads like an audit log. Order
      // matches the JSON: keys A→Z, events newest-first within each key.
      if (typeof format === "string" && format.toLowerCase() === "csv") {
        const header = [
          "key",
          "citation",
          "lang",
          "register",
          "oldValue",
          "newValue",
          "source",
          "approverName",
          "approverEmail",
          "timestamp",
        ];
        const rows: string[] = [header.map(csvField).join(",")];
        for (const k of keys) {
          for (const e of k.history) {
            rows.push(
              [
                k.key,
                k.mandatedBy,
                e.lang,
                e.register,
                e.oldValue,
                e.newValue,
                e.source,
                e.changedBy.name,
                e.changedBy.email,
                e.createdAt instanceof Date
                  ? e.createdAt.toISOString()
                  : new Date(e.createdAt).toISOString(),
              ]
                .map(csvField)
                .join(",")
            );
          }
        }
        // CRLF line endings per RFC 4180 (Excel-friendly).
        const csv = rows.join("\r\n") + "\r\n";
        const filename = `compliance-audit-${projectId}.csv`;
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        return res.status(200).send(csv);
      }

      return sendSuccess(res, 200, {
        projectId,
        generatedAt: new Date().toISOString(),
        totalRegulatedKeys: keys.length,
        keys,
      });
    } catch (e) {
      return sendError(res, 500, "Failed to build compliance audit");
    }
  }
);

// ─── COMPLIANCE SUMMARY (roll-up counts) ────────────────────
// Lightweight counts for the dashboard banner: how many regulated keys exist,
// how many are fully cleared, and how many still have a not-yet-cleared cell.
router.get(
  "/summary",
  requireProjectRole("owner"),
  async (req: ProjectAuthRequest, res: Response) => {
    try {
      const { projectId } = req.params;

      const idError = validateObjectId(projectId as string, "Project ID");
      if (idError) return sendError(res, 400, idError);

      const translations = await Translation.find({ projectId, regulated: true });

      let fullyApproved = 0;
      let withPending = 0;
      for (const t of translations) {
        const statuses: CellStatus[] = [];
        for (const { value } of iterateCells(t.sources as any)) {
          statuses.push(normalizeStatus(value));
        }
        const hasCells = statuses.length > 0;
        const allCleared = hasCells && statuses.every(isCleared);
        if (allCleared) fullyApproved++;
        // A key counts as "with pending" when it has at least one cell the SDK
        // would withhold (ai/pending), OR it has no localized cells at all
        // (nothing has been approved yet) — both mean the key isn't audit-ready.
        if (!allCleared) withPending++;
      }

      return sendSuccess(res, 200, {
        total: translations.length,
        fullyApproved,
        withPending,
      });
    } catch (e) {
      return sendError(res, 500, "Failed to build compliance summary");
    }
  }
);

export default router;
