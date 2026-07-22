import { Router } from 'express';

import {
  cashEntryRequestSchema,
  cashPreviewRequestSchema,
  cashSourceListQuerySchema,
  cashSourceParamsSchema,
  cashMovementsQuerySchema,
  cashTransferRequestSchema,
  createCashSourceRequestSchema,
  createDividendRequestSchema,
  createPortfolioRequestSchema,
  createTransactionsRequestSchema,
  dividendListQuerySchema,
  dividendParamsSchema,
  portfolioHistoryQuerySchema,
  portfolioIdParamSchema,
  portfolioListQuerySchema,
  portfolioTransactionParamsSchema,
  setCashBalanceRequestSchema,
  taxYearExportQuerySchema,
  taxYearParamsSchema,
  transactionListQuerySchema,
  updateCashSourceRequestSchema,
  updatePortfolioRequestSchema,
  updateTaxSettingsRequestSchema,
  updateTransactionRequestSchema,
  type CashEntryRequest,
  type CashMovementsQuery,
  type CashPreviewRequest,
  type CashSourceListQuery,
  type CashSourceResponse,
  type CashTransferRequest,
  type CreateCashSourceRequest,
  type CreateDividendRequest,
  type CreatePortfolioRequest,
  type CreateTransactionsRequest,
  type DividendListQuery,
  type PortfolioHistoryQuery,
  type PortfolioListQuery,
  type PortfolioMutationResponse,
  type SetCashBalanceRequest,
  type TaxExportLocale,
  type TransactionInput,
  type TransactionListQuery,
  type UpdateCashSourceRequest,
  type UpdatePortfolioRequest,
  type UpdatePortfolioResponse,
  type UpdateTaxSettingsRequest,
  type UpdateTransactionRequest,
} from '@bettertrack/contracts';

import { serializeTaxYearReportCsv, taxReportCsvFilename } from '../../services/tax/taxReportCsv';
import { conditionalGet, CONDITIONAL_LAST_MODIFIED } from '../middleware/conditional';
import { createIdempotency } from '../middleware/idempotency';
import { requireUser } from '../middleware/session';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Portfolio + transaction endpoints (PROJECTPLAN.md §6.8, §7.2, §8). Every route
 * is `portfolio_id`-scoped so multi-portfolio is purely additive; each handler
 * verifies the portfolio belongs to the session user (404 otherwise, enforced in
 * the repository — no IDOR, never a 403). Controllers stay thin.
 *
 * MIRRORCHAIN seam (§13.5 V5-P7 M2, design §1): every portfolio-CONTENT write
 * (transactions, dividends, cash, sources) calls `ctx.mirror.submit*`, which
 * routes a synced copy's write through op append + replication and falls
 * through to the plain portfolio/tax service for every other portfolio — one
 * membership-index lookup is the entire cost on the non-chain path, which
 * otherwise stays byte-identical to before. Reads and copy-scoped writes
 * (rename/visibility/archive of the portfolio itself, tax settings) never
 * route through the chain (design §1 copy-scoped list).
 */
export function createPortfolioRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // Idempotency (§13.4 V4-P2a, #417): the opt-in `Idempotency-Key` middleware,
  // mounted per mutation route below (create/edit/delete transaction; cash
  // deposit/withdraw/transfer/set-balance). Built once; a request without the
  // header passes straight through.
  const idempotency = createIdempotency(ctx);

  // GET /portfolios?includeArchived= — the user's portfolios (active by default,
  // §6.8; archived rows included only when asked, §13.2 V2-P8).
  router.get('/', validateQuery(portfolioListQuerySchema), async (req, res) => {
    const { includeArchived } = req.valid?.query as PortfolioListQuery;
    const list = await ctx.portfolio.listPortfolios(req.authUser!.id, { includeArchived });
    res.json(list);
  });

  // POST /portfolios — create a named portfolio (§13.2 V2-P8).
  router.post('/', validateBody(createPortfolioRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreatePortfolioRequest;
    const portfolio = await ctx.portfolio.createPortfolio(req.authUser!.id, body);
    const response: PortfolioMutationResponse = { portfolio };
    res.status(201).json(response);
  });

  // POST /portfolios/:portfolioId/archive — soft-archive; rejects the last active one (§13.2 V2-P8).
  router.post('/:portfolioId/archive', validateParams(portfolioIdParamSchema), async (req, res) => {
    const { portfolioId } = req.valid?.params as { portfolioId: string };
    const portfolio = await ctx.portfolio.archivePortfolio(req.authUser!.id, portfolioId);
    const response: PortfolioMutationResponse = { portfolio };
    res.json(response);
  });

  // POST /portfolios/:portfolioId/restore — restore an archived portfolio (§13.2 V2-P8).
  router.post('/:portfolioId/restore', validateParams(portfolioIdParamSchema), async (req, res) => {
    const { portfolioId } = req.valid?.params as { portfolioId: string };
    const portfolio = await ctx.portfolio.restorePortfolio(req.authUser!.id, portfolioId);
    const response: PortfolioMutationResponse = { portfolio };
    res.json(response);
  });

  // DELETE /portfolios/:portfolioId — permanently delete a portfolio and its
  // entire dependent-row graph (transactions, cash ledger + sources, dividends,
  // sharing audience + public links, graph cache). The hard option beside
  // archive: owner-scoped (404 on a foreign/unknown id, and on a second call),
  // rejects deleting the only active portfolio (400 LAST_ACTIVE_PORTFOLIO). The
  // deliberate type-to-confirm lives in the client; the API is an authenticated
  // DELETE gated by ownership (bearer needs portfolio:write).
  router.delete('/:portfolioId', validateParams(portfolioIdParamSchema), async (req, res) => {
    const { portfolioId } = req.valid?.params as { portfolioId: string };
    // Routed through the mirror seam (§13.5 V5-P7 M3): a non-chain portfolio
    // deletes plainly; a synced copy is intercepted as leave-then-delete (§6),
    // and an owner's copy-delete is refused with the §7 stopgap 409 until M4.
    await ctx.mirror.submitPortfolioDelete(req.authUser!.id, portfolioId);
    res.status(204).send();
  });

  // GET /portfolios/:portfolioId — holdings + totals (§6.8). Conditional read
  // (V5-P1b, #555): body-derived ETag + snapshot-state Last-Modified; liveToday
  // so a fresh intraday quote is only reflected via the ETag, never masked by
  // an If-Modified-Since 304.
  router.get(
    '/:portfolioId',
    validateParams(portfolioIdParamSchema),
    conditionalGet({ liveToday: true }),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const portfolio = await ctx.portfolio.getPortfolio(req.authUser!.id, portfolioId, {
        baseCurrency: req.authUser!.baseCurrency,
      });
      const freshness = await ctx.portfolio.getSnapshotFreshness(req.authUser!.id, portfolioId);
      if (freshness) res.locals[CONDITIONAL_LAST_MODIFIED] = freshness;
      res.json(portfolio);
    },
  );

  // PATCH /portfolios/:portfolioId — rename and/or change visibility (§6.8).
  router.patch(
    '/:portfolioId',
    validateParams(portfolioIdParamSchema),
    validateBody(updatePortfolioRequestSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const patch = req.valid?.body as UpdatePortfolioRequest;
      const portfolio = await ctx.portfolio.updatePortfolio(req.authUser!.id, portfolioId, patch);
      // Keep the legacy visibility toggle flowing into the single audience model
      // (V3-P5): only after updatePortfolio confirmed ownership (else it 404s).
      if (patch.visibility !== undefined) {
        await ctx.social.applyAudienceVisibility(
          req.authUser!.id,
          'portfolio',
          portfolioId,
          patch.visibility,
        );
      }
      const body: UpdatePortfolioResponse = { portfolio };
      res.json(body);
    },
  );

  // GET /portfolios/:portfolioId/history?range=&overlay= — value-over-time series,
  // optionally with each held asset's own price series for the chart overlay (§6.8, #122).
  router.get(
    '/:portfolioId/history',
    validateParams(portfolioIdParamSchema),
    validateQuery(portfolioHistoryQuerySchema),
    // Conditional read (V5-P1b, #555): body-derived ETag + snapshot-state
    // Last-Modified (issue #553 drives series freshness). liveToday because the
    // trailing point is a fresh quote — ETag-only revalidation, never masked.
    conditionalGet({ liveToday: true }),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const { range, overlay } = req.valid?.query as PortfolioHistoryQuery;
      const history = await ctx.portfolio.getHistory(req.authUser!.id, portfolioId, range, {
        overlay,
        baseCurrency: req.authUser!.baseCurrency,
      });
      const freshness = await ctx.portfolio.getSnapshotFreshness(req.authUser!.id, portfolioId);
      if (freshness) res.locals[CONDITIONAL_LAST_MODIFIED] = freshness;
      res.json(history);
    },
  );

  // GET /portfolios/:portfolioId/cash?source= — cash movements + current balance
  // (§14, #220), optionally narrowed to one source tag (V5-P0c).
  router.get(
    '/:portfolioId/cash',
    validateParams(portfolioIdParamSchema),
    validateQuery(cashMovementsQuerySchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const { source } = req.valid?.query as CashMovementsQuery;
      const cash = await ctx.portfolio.getCashMovements(req.authUser!.id, portfolioId, { source });
      res.json(cash);
    },
  );

  // POST /portfolios/:portfolioId/cash/deposit — record an external deposit (§14).
  router.post(
    '/:portfolioId/cash/deposit',
    validateParams(portfolioIdParamSchema),
    idempotency,
    validateBody(cashEntryRequestSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const body = req.valid?.body as CashEntryRequest;
      const result = await ctx.mirror.submitCashDeposit(req.authUser!.id, portfolioId, body);
      res.status(201).json(result);
    },
  );

  // POST /portfolios/:portfolioId/cash/withdraw — record a withdrawal; 400 on overdraw (§14).
  router.post(
    '/:portfolioId/cash/withdraw',
    validateParams(portfolioIdParamSchema),
    idempotency,
    validateBody(cashEntryRequestSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const body = req.valid?.body as CashEntryRequest;
      const result = await ctx.mirror.submitCashWithdraw(req.authUser!.id, portfolioId, body);
      res.status(201).json(result);
    },
  );

  // POST /portfolios/:portfolioId/cash/preview — live "available → after" preview (§14).
  router.post(
    '/:portfolioId/cash/preview',
    validateParams(portfolioIdParamSchema),
    validateBody(cashPreviewRequestSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const body = req.valid?.body as CashPreviewRequest;
      const preview = await ctx.portfolio.previewCash(req.authUser!.id, portfolioId, body);
      res.json(preview);
    },
  );

  // GET /portfolios/:portfolioId/cash/sources?includeArchived= — the sources with
  // per-source balances, Main first (V3-P3).
  router.get(
    '/:portfolioId/cash/sources',
    validateParams(portfolioIdParamSchema),
    validateQuery(cashSourceListQuerySchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const { includeArchived } = req.valid?.query as CashSourceListQuery;
      const list = await ctx.portfolio.listCashSources(req.authUser!.id, portfolioId, {
        includeArchived,
      });
      res.json(list);
    },
  );

  // POST /portfolios/:portfolioId/cash/sources — create a named source (V3-P3).
  router.post(
    '/:portfolioId/cash/sources',
    validateParams(portfolioIdParamSchema),
    validateBody(createCashSourceRequestSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const body = req.valid?.body as CreateCashSourceRequest;
      const source = await ctx.mirror.submitSourceCreate(req.authUser!.id, portfolioId, body);
      const response: CashSourceResponse = { source };
      res.status(201).json(response);
    },
  );

  // PATCH /portfolios/:portfolioId/cash/sources/:sourceId — rename / relabel (V3-P3).
  router.patch(
    '/:portfolioId/cash/sources/:sourceId',
    validateParams(cashSourceParamsSchema),
    validateBody(updateCashSourceRequestSchema),
    async (req, res) => {
      const { portfolioId, sourceId } = req.valid?.params as {
        portfolioId: string;
        sourceId: string;
      };
      const patch = req.valid?.body as UpdateCashSourceRequest;
      const source = await ctx.mirror.submitSourceUpdate(
        req.authUser!.id,
        portfolioId,
        sourceId,
        patch,
      );
      const response: CashSourceResponse = { source };
      res.json(response);
    },
  );

  // POST /portfolios/:portfolioId/cash/sources/:sourceId/archive — soft-archive;
  // rejects Main and any non-zero balance (V3-P3).
  router.post(
    '/:portfolioId/cash/sources/:sourceId/archive',
    validateParams(cashSourceParamsSchema),
    async (req, res) => {
      const { portfolioId, sourceId } = req.valid?.params as {
        portfolioId: string;
        sourceId: string;
      };
      const source = await ctx.mirror.submitSourceArchive(req.authUser!.id, portfolioId, sourceId);
      const response: CashSourceResponse = { source };
      res.json(response);
    },
  );

  // POST /portfolios/:portfolioId/cash/sources/:sourceId/restore — undo archive (V3-P3).
  router.post(
    '/:portfolioId/cash/sources/:sourceId/restore',
    validateParams(cashSourceParamsSchema),
    async (req, res) => {
      const { portfolioId, sourceId } = req.valid?.params as {
        portfolioId: string;
        sourceId: string;
      };
      const source = await ctx.mirror.submitSourceRestore(req.authUser!.id, portfolioId, sourceId);
      const response: CashSourceResponse = { source };
      res.json(response);
    },
  );

  // POST /portfolios/:portfolioId/cash/transfer — atomic paired movement between
  // two sources; never a TWR flow (V3-P3).
  router.post(
    '/:portfolioId/cash/transfer',
    validateParams(portfolioIdParamSchema),
    idempotency,
    validateBody(cashTransferRequestSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const body = req.valid?.body as CashTransferRequest;
      const result = await ctx.mirror.submitCashTransfer(req.authUser!.id, portfolioId, body);
      res.status(201).json(result);
    },
  );

  // POST /portfolios/:portfolioId/cash/sources/:sourceId/set-balance — "set
  // balance to X": the server computes the delta and records a normal movement (V3-P3, §16).
  router.post(
    '/:portfolioId/cash/sources/:sourceId/set-balance',
    validateParams(cashSourceParamsSchema),
    idempotency,
    validateBody(setCashBalanceRequestSchema),
    async (req, res) => {
      const { portfolioId, sourceId } = req.valid?.params as {
        portfolioId: string;
        sourceId: string;
      };
      const body = req.valid?.body as SetCashBalanceRequest;
      const result = await ctx.mirror.submitSetCashBalance(
        req.authUser!.id,
        portfolioId,
        sourceId,
        body,
      );
      res.json(result);
    },
  );

  // POST /portfolios/:portfolioId/dividends — record a dividend on a held
  // asset into a cash source, tax-mode aware (V3-P4, §13.3).
  router.post(
    '/:portfolioId/dividends',
    validateParams(portfolioIdParamSchema),
    validateBody(createDividendRequestSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const body = req.valid?.body as CreateDividendRequest;
      const result = await ctx.mirror.submitDividendRecord(req.authUser!.id, portfolioId, body);
      res.status(201).json(result);
    },
  );

  // GET /portfolios/:portfolioId/dividends?source= — the recorded dividends
  // (V3-P4), optionally narrowed to one source tag (V5-P0c).
  router.get(
    '/:portfolioId/dividends',
    validateParams(portfolioIdParamSchema),
    validateQuery(dividendListQuerySchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const { source } = req.valid?.query as DividendListQuery;
      const list = await ctx.tax.listDividends(req.authUser!.id, portfolioId, { source });
      res.json(list);
    },
  );

  // DELETE /portfolios/:portfolioId/dividends/:dividendId — remove a dividend;
  // its movements cascade and an AT year re-settles append-only (V3-P4).
  router.delete(
    '/:portfolioId/dividends/:dividendId',
    validateParams(dividendParamsSchema),
    async (req, res) => {
      const { portfolioId, dividendId } = req.valid?.params as {
        portfolioId: string;
        dividendId: string;
      };
      await ctx.mirror.submitDividendDelete(req.authUser!.id, portfolioId, dividendId);
      res.status(204).send();
    },
  );

  // ── Per-portfolio tax treatment (issue #636) ───────────────────────────────
  // The tax slice of the per-portfolio settings scoping cascade
  // (`effective = override ?? user default ?? system('none')`). GET resolves the
  // view; PUT pins this portfolio's override; DELETE resets it to inheriting.

  // GET /portfolios/:portfolioId/settings/tax — the resolved tax view.
  router.get(
    '/:portfolioId/settings/tax',
    validateParams(portfolioIdParamSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const settings = await ctx.tax.getPortfolioTaxSettings(req.authUser!.id, portfolioId);
      res.json(settings);
    },
  );

  // PUT /portfolios/:portfolioId/settings/tax — override this portfolio's tax
  // treatment (applies forward only, like the user-level default; §16).
  router.put(
    '/:portfolioId/settings/tax',
    validateParams(portfolioIdParamSchema),
    validateBody(updateTaxSettingsRequestSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const body = req.valid?.body as UpdateTaxSettingsRequest;
      const settings = await ctx.tax.setPortfolioTaxOverride(req.authUser!.id, portfolioId, body);
      res.json(settings);
    },
  );

  // DELETE /portfolios/:portfolioId/settings/tax — drop the override; the
  // portfolio inherits the user-level default again (reset-to-default).
  router.delete(
    '/:portfolioId/settings/tax',
    validateParams(portfolioIdParamSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const settings = await ctx.tax.clearPortfolioTaxOverride(req.authUser!.id, portfolioId);
      res.json(settings);
    },
  );

  // GET /portfolios/:portfolioId/reports/tax-years — per-year realized P/L +
  // dividends + taxes summaries, newest first (V3-P4d).
  router.get(
    '/:portfolioId/reports/tax-years',
    validateParams(portfolioIdParamSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const report = await ctx.tax.getYearReports(req.authUser!.id, portfolioId);
      res.json(report);
    },
  );

  // GET /portfolios/:portfolioId/reports/tax-years/:year — one year with the
  // per-position drill-down (V3-P4d).
  router.get(
    '/:portfolioId/reports/tax-years/:year',
    validateParams(taxYearParamsSchema),
    async (req, res) => {
      const { portfolioId, year } = req.valid?.params as { portfolioId: string; year: number };
      const report = await ctx.tax.getYearReport(req.authUser!.id, portfolioId, year);
      res.json(report);
    },
  );

  // GET /portfolios/:portfolioId/reports/tax-years/:year/export.csv — the same
  // year report serialized to CSV (V5-P4b, #583). One source of truth: the
  // numbers are copied from the very response the on-screen report renders,
  // never recomputed. Session-owner-scoped exactly like the report itself
  // (`getYearReport` enforces ownership); `?locale=` picks header language only.
  router.get(
    '/:portfolioId/reports/tax-years/:year/export.csv',
    validateParams(taxYearParamsSchema),
    validateQuery(taxYearExportQuerySchema),
    async (req, res) => {
      const { portfolioId, year } = req.valid?.params as { portfolioId: string; year: number };
      const { locale } = (req.valid?.query ?? {}) as { locale?: TaxExportLocale };
      const report = await ctx.tax.getYearReport(req.authUser!.id, portfolioId, year);
      const csv = serializeTaxYearReportCsv(report, locale ?? 'en');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${taxReportCsvFilename(year)}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(csv);
    },
  );

  // GET /portfolios/:portfolioId/transactions?cursor= — newest-first ledger (§8).
  router.get(
    '/:portfolioId/transactions',
    validateParams(portfolioIdParamSchema),
    validateQuery(transactionListQuerySchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const { cursor, limit, source } = req.valid?.query as TransactionListQuery;
      const page = await ctx.portfolio.listTransactions(req.authUser!.id, portfolioId, {
        cursor,
        limit,
        source,
      });
      res.json(page);
    },
  );

  // POST /portfolios/:portfolioId/transactions — single or bulk (the buy flow, §6.8).
  router.post(
    '/:portfolioId/transactions',
    validateParams(portfolioIdParamSchema),
    idempotency,
    validateBody(createTransactionsRequestSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const body = req.valid?.body as CreateTransactionsRequest;
      const inputs: TransactionInput[] = 'transactions' in body ? body.transactions : [body];
      const created = await ctx.mirror.submitTransactionsCreate(
        req.authUser!.id,
        portfolioId,
        inputs,
      );
      res.status(201).json({ transactions: created });
    },
  );

  // PATCH /portfolios/:portfolioId/transactions/:txId — edit; re-validates oversell (§6.8).
  router.patch(
    '/:portfolioId/transactions/:txId',
    validateParams(portfolioTransactionParamsSchema),
    idempotency,
    validateBody(updateTransactionRequestSchema),
    async (req, res) => {
      const { portfolioId, txId } = req.valid?.params as { portfolioId: string; txId: string };
      const patch = req.valid?.body as UpdateTransactionRequest;
      const transaction = await ctx.mirror.submitTransactionUpdate(
        req.authUser!.id,
        portfolioId,
        txId,
        patch,
      );
      res.json({ transaction });
    },
  );

  // DELETE /portfolios/:portfolioId/transactions/:txId — remove; re-validates oversell (§6.8).
  router.delete(
    '/:portfolioId/transactions/:txId',
    validateParams(portfolioTransactionParamsSchema),
    idempotency,
    async (req, res) => {
      const { portfolioId, txId } = req.valid?.params as { portfolioId: string; txId: string };
      await ctx.mirror.submitTransactionDelete(req.authUser!.id, portfolioId, txId);
      res.status(204).send();
    },
  );

  return router;
}
