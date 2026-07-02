import { Router } from 'express';

import {
  createTransactionsRequestSchema,
  portfolioHistoryQuerySchema,
  transactionIdParamSchema,
  transactionListQuerySchema,
  updateTransactionRequestSchema,
  type CreateTransactionsRequest,
  type PortfolioHistoryQuery,
  type TransactionInput,
  type TransactionListQuery,
  type UpdateTransactionRequest,
} from '@bettertrack/contracts';

import { requireUser } from '../middleware/session';
import { validateBody, validateParams, validateQuery } from '../middleware/validate';
import type { AppContext } from '../context';

/** Portfolio + transaction endpoints (PROJECTPLAN.md §6.9, §8). Controllers stay thin. */
export function createPortfolioRouter(ctx: AppContext): Router {
  const router = Router();

  router.use(requireUser);

  // GET /portfolio — holdings + totals (§6.9).
  router.get('/', async (req, res) => {
    const portfolio = await ctx.portfolio.getPortfolio(req.authUser!.id);
    res.json(portfolio);
  });

  // GET /portfolio/history?range= — value-over-time series (§6.9).
  router.get('/history', validateQuery(portfolioHistoryQuerySchema), async (req, res) => {
    const { range } = req.valid?.query as PortfolioHistoryQuery;
    const history = await ctx.portfolio.getHistory(req.authUser!.id, range);
    res.json(history);
  });

  // GET /portfolio/transactions?cursor= — newest-first ledger (§8).
  router.get('/transactions', validateQuery(transactionListQuerySchema), async (req, res) => {
    const { cursor, limit } = req.valid?.query as TransactionListQuery;
    const page = await ctx.portfolio.listTransactions(req.authUser!.id, { cursor, limit });
    res.json(page);
  });

  // POST /portfolio/transactions — single or bulk (the buy flow, §6.9).
  router.post('/transactions', validateBody(createTransactionsRequestSchema), async (req, res) => {
    const body = req.valid?.body as CreateTransactionsRequest;
    const inputs: TransactionInput[] = 'transactions' in body ? body.transactions : [body];
    const created = await ctx.portfolio.createTransactions(req.authUser!.id, inputs);
    res.status(201).json({ transactions: created });
  });

  // PATCH /portfolio/transactions/:id — edit; re-validates negative-sell (§6.9).
  router.patch(
    '/transactions/:id',
    validateParams(transactionIdParamSchema),
    validateBody(updateTransactionRequestSchema),
    async (req, res) => {
      const { id } = req.valid?.params as { id: string };
      const patch = req.valid?.body as UpdateTransactionRequest;
      const transaction = await ctx.portfolio.updateTransaction(req.authUser!.id, id, patch);
      res.json({ transaction });
    },
  );

  // DELETE /portfolio/transactions/:id — remove; re-validates negative-sell (§6.9).
  router.delete('/transactions/:id', validateParams(transactionIdParamSchema), async (req, res) => {
    const { id } = req.valid?.params as { id: string };
    await ctx.portfolio.deleteTransaction(req.authUser!.id, id);
    res.status(204).send();
  });

  return router;
}
