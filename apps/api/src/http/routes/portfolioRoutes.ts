import { Router } from 'express';

import {
  createTransactionsRequestSchema,
  portfolioHistoryQuerySchema,
  portfolioIdParamSchema,
  portfolioTransactionParamsSchema,
  transactionListQuerySchema,
  updatePortfolioRequestSchema,
  updateTransactionRequestSchema,
  type CreateTransactionsRequest,
  type PortfolioHistoryQuery,
  type TransactionInput,
  type TransactionListQuery,
  type UpdatePortfolioRequest,
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

  // GET /portfolios — the user's portfolios (V1: the single auto-created default).
  router.get('/', async (req, res) => {
    const list = await ctx.portfolio.listPortfolios(req.authUser!.id);
    res.json(list);
  });

  // GET /portfolios/:portfolioId — holdings + totals (§6.8).
  router.get('/:portfolioId', validateParams(portfolioIdParamSchema), async (req, res) => {
    const { portfolioId } = req.valid?.params as { portfolioId: string };
    const portfolio = await ctx.portfolio.getPortfolio(req.authUser!.id, portfolioId);
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
      res.json({ portfolio });
    },
  );

  // GET /portfolios/:portfolioId/history?range= — value-over-time series (§6.8).
  router.get(
    '/:portfolioId/history',
    validateParams(portfolioIdParamSchema),
    validateQuery(portfolioHistoryQuerySchema),
    async (req, res) => {
      const { portfolioId } = req.valid?.params as { portfolioId: string };
      const { range } = req.valid?.query as PortfolioHistoryQuery;
      const history = await ctx.portfolio.getHistory(req.authUser!.id, portfolioId, range);
      res.json(history);
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
