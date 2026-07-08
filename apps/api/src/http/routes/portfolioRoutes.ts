import { Router } from 'express';

import {
  cashEntryRequestSchema,
  cashPreviewRequestSchema,
  cashSourceListQuerySchema,
  cashSourceParamsSchema,
  cashTransferRequestSchema,
  createCashSourceRequestSchema,
  createPortfolioRequestSchema,
  createTransactionsRequestSchema,
  portfolioHistoryQuerySchema,
  portfolioIdParamSchema,
  portfolioListQuerySchema,
  portfolioTransactionParamsSchema,
  setCashBalanceRequestSchema,
  transactionListQuerySchema,
  updateCashSourceRequestSchema,
  updatePortfolioRequestSchema,
  updateTransactionRequestSchema,
  type CashEntryRequest,
  type CashPreviewRequest,
  type CashSourceListQuery,
  type CashSourceResponse,
  type CashTransferRequest,
  type CreateCashSourceRequest,
  type CreatePortfolioRequest,
  type CreateTransactionsRequest,
  type PortfolioHistoryQuery,
  type PortfolioListQuery,
  type PortfolioMutationResponse,
  type SetCashBalanceRequest,
  type TransactionInput,
  type TransactionListQuery,
  type UpdateCashSourceRequest,
  type UpdatePortfolioRequest,
  type UpdatePortfolioResponse,
  type UpdateTransactionRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/**
 * Portfolio + transaction endpoints (PROJECTPLAN.md §6.8, §7.2, §8). Every route
 * is `portfolio_id`-scoped so multi-portfolio is purely additive; each handler
 * verifies the portfolio belongs to the session user (404 otherwise, enforced in
 * the repository — no IDOR, never a 403). Controllers stay thin.
 */
export function createPortfolioRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

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

  // GET /portfolios/:portfolioId — holdings + totals (§6.8).
  router.get('/:portfolioId', validateParams(portfolioIdParamSchema), async (req, res) => {
    const { portfolioId } = req.valid?.params as { portfolioId: string };
    const portfolio = await ctx.portfolio.getPortfolio(req.authUser!.id, portfolioId, {
      baseCurrency: req.authUser!.baseCurrency,
    });
    res.json(portfolio);
  });

  // PATCH /portfolios/:portfolioId — rename and/or change visibility (§6.8).
  router.patch(
    '/:portfolioId',
    validateParams(portfolioIdParamSchema),
    validateBody(updatePortfolioRequestSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const patch = req.valid?.body as UpdatePortfolioRequest;
      const portfolio = await ctx.portfolio.updatePortfolio(req.authUser!.id, portfolioId, patch);
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
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const { range, overlay } = req.valid?.query as PortfolioHistoryQuery;
      const history = await ctx.portfolio.getHistory(req.authUser!.id, portfolioId, range, {
        overlay,
        baseCurrency: req.authUser!.baseCurrency,
      });
      res.json(history);
    },
  );

  // GET /portfolios/:portfolioId/cash — cash movements + current balance (§14, #220).
  router.get('/:portfolioId/cash', validateParams(portfolioIdParamSchema), async (req, res) => {
    const { portfolioId } = req.valid?.params as { portfolioId: string };
    const cash = await ctx.portfolio.getCashMovements(req.authUser!.id, portfolioId);
    res.json(cash);
  });

  // POST /portfolios/:portfolioId/cash/deposit — record an external deposit (§14).
  router.post(
    '/:portfolioId/cash/deposit',
    validateParams(portfolioIdParamSchema),
    validateBody(cashEntryRequestSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const body = req.valid?.body as CashEntryRequest;
      const result = await ctx.portfolio.depositCash(req.authUser!.id, portfolioId, body);
      res.status(201).json(result);
    },
  );

  // POST /portfolios/:portfolioId/cash/withdraw — record a withdrawal; 400 on overdraw (§14).
  router.post(
    '/:portfolioId/cash/withdraw',
    validateParams(portfolioIdParamSchema),
    validateBody(cashEntryRequestSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const body = req.valid?.body as CashEntryRequest;
      const result = await ctx.portfolio.withdrawCash(req.authUser!.id, portfolioId, body);
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
      const source = await ctx.portfolio.createCashSource(req.authUser!.id, portfolioId, body);
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
      const source = await ctx.portfolio.updateCashSource(
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
      const source = await ctx.portfolio.archiveCashSource(req.authUser!.id, portfolioId, sourceId);
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
      const source = await ctx.portfolio.restoreCashSource(req.authUser!.id, portfolioId, sourceId);
      const response: CashSourceResponse = { source };
      res.json(response);
    },
  );

  // POST /portfolios/:portfolioId/cash/transfer — atomic paired movement between
  // two sources; never a TWR flow (V3-P3).
  router.post(
    '/:portfolioId/cash/transfer',
    validateParams(portfolioIdParamSchema),
    validateBody(cashTransferRequestSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const body = req.valid?.body as CashTransferRequest;
      const result = await ctx.portfolio.transferCash(req.authUser!.id, portfolioId, body);
      res.status(201).json(result);
    },
  );

  // POST /portfolios/:portfolioId/cash/sources/:sourceId/set-balance — "set
  // balance to X": the server computes the delta and records a normal movement (V3-P3, §16).
  router.post(
    '/:portfolioId/cash/sources/:sourceId/set-balance',
    validateParams(cashSourceParamsSchema),
    validateBody(setCashBalanceRequestSchema),
    async (req, res) => {
      const { portfolioId, sourceId } = req.valid?.params as {
        portfolioId: string;
        sourceId: string;
      };
      const body = req.valid?.body as SetCashBalanceRequest;
      const result = await ctx.portfolio.setCashBalance(
        req.authUser!.id,
        portfolioId,
        sourceId,
        body,
      );
      res.json(result);
    },
  );

  // GET /portfolios/:portfolioId/transactions?cursor= — newest-first ledger (§8).
  router.get(
    '/:portfolioId/transactions',
    validateParams(portfolioIdParamSchema),
    validateQuery(transactionListQuerySchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const { cursor, limit } = req.valid?.query as TransactionListQuery;
      const page = await ctx.portfolio.listTransactions(req.authUser!.id, portfolioId, {
        cursor,
        limit,
      });
      res.json(page);
    },
  );

  // POST /portfolios/:portfolioId/transactions — single or bulk (the buy flow, §6.8).
  router.post(
    '/:portfolioId/transactions',
    validateParams(portfolioIdParamSchema),
    validateBody(createTransactionsRequestSchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const body = req.valid?.body as CreateTransactionsRequest;
      const inputs: TransactionInput[] = 'transactions' in body ? body.transactions : [body];
      const created = await ctx.portfolio.createTransactions(req.authUser!.id, portfolioId, inputs);
      res.status(201).json({ transactions: created });
    },
  );

  // PATCH /portfolios/:portfolioId/transactions/:txId — edit; re-validates oversell (§6.8).
  router.patch(
    '/:portfolioId/transactions/:txId',
    validateParams(portfolioTransactionParamsSchema),
    validateBody(updateTransactionRequestSchema),
    async (req, res) => {
      const { portfolioId, txId } = req.valid?.params as { portfolioId: string; txId: string };
      const patch = req.valid?.body as UpdateTransactionRequest;
      const transaction = await ctx.portfolio.updateTransaction(
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
    async (req, res) => {
      const { portfolioId, txId } = req.valid?.params as { portfolioId: string; txId: string };
      await ctx.portfolio.deleteTransaction(req.authUser!.id, portfolioId, txId);
      res.status(204).send();
    },
  );

  return router;
}
