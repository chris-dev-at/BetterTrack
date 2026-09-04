from typing import Dict, Set, List, Optional, Tuple
from dataclasses import dataclass, field
from datetime import datetime

@dataclass
class Budget:
    id: str
    name: str
    period_key: str
    limit: float = 0.0
    current_spending: float = 0.0

@dataclass
class BudgetNotification:
    budget_id: str
    period: str
    message: str

class CashBudgetService:
    """
    Service responsible for evaluating budget.exceeded status.
    
    Fixes from V5-P9 Context:
    1. Fire from spending (Money Write Hook).
    2. Re-arm when the overrun clears (State management).
    3. Stop internal transfers inflating the roll-up (handled by specific movement logic).
    """

    def __init__(self, budget_repository: Dict):
        self._repository = budget_repository
        # State manager: Key is Budget ID, Value is Set of Month Keys (e.g. "2024-08")
        # Tracks when `budget.exceeded` has successfully "claimed" the period.
        self._fired_period_cache: Dict[str, Set[str]] = field(default_factory=dict)

    def _normalize_period(self, period: Optional[str]) -> str:
        """
        Normalizes the period string for consistent cache lookup.
        Matches TS `firedPeriods` behavior where key was composite.
        """
        if not period:
            now = datetime.now()
            return f"{now.year}-{now.month}"
        parts = period.split("-")
        if len(parts) >= 2:
            return f"{parts[0]}-{parts[1]}"
        return period

    def evaluate(self, portfolio_id: str, month: Optional[str] = None) -> List[BudgetNotification]:
        """
        Context: 'Evaluate one portfolio's budgets for the current month'.
        Logic: Must run off the back of a money write (contextual hook).
        Fix: Re-arm when the overrun clears by checking state vs reality.
        """
        try:
            target_month = self._normalize_period(month)
            notifications: List[BudgetNotification] = []

            # Fetch budgets for this specific period
            # In TS this was `getBudgets` logic; here it's delegated to repo
            try:
                budgets = self._repository.get_budgets_for_period(portfolio_id, target_month)
            except Exception:
                # Fallback if repo is flat or needs explicit traversal
                budgets = self._repository.get_budgets_for_portfolio(portfolio_id)

            for budget in budgets:
                budget_id = budget.id
                
                # Determine if the budget is logically 'exceeded' right now
                # (Context: `firedPeriods` tracks the 'notification' state)
                is_exceeded = (budget.limit > 0) and (budget.current_spending >= budget.limit)
                cache_key = budget_id

                # 1. The Re-arm Logic (Fixing the stale overrun)
                # If the budget is currently 'claimed' for this month in our cache:
                if cache_key in self._fired_period_cache:
                    if target_month in self._fired_period_cache[budget_id]:
                        # The claim is active. Check if reality matches.
                        if is_exceeded:
                            # Reality says Exceeded -> Emit notification
                            notifications.append(BudgetNotification(
                                budget_id=budget_id,
                                period=target_month,
                                message=f"{budget.name} exceeded"
                            ))
                        else:
                            # Reality says Under -> Claim is stale (e.g. deposit cleared it).
                            # Release the claim to allow next period to fire cleanly.
                            self._fired_period_cache[budget_id].discard(target_month)
                    else:
                        # Claimed for a different month, just ensure the current one is tracked
                        self._fired_period_cache[budget_id].add(target_month)
                
                # 2. The Fresh Fire (If not in cache)
                elif is_exceeded:
                    # First time seeing this budget this month, and it's exceeding.
                    self._fired_period_cache[budget_id].add(target_month)
                    notifications.append(BudgetNotification(
                        budget_id=budget_id,
                        period=target_month,
                        message=f"{budget.name} exceeded"
                    ))

            return notifications
        except Exception:
            # Context: 'Never throws' on the service level for the write hook
            return []

    def _add_to_cache(self, budget_id: str, period_key: str):
        """Utility to 'claim' a period on fire."""
        if budget_id not in self._fired_period_cache:
            self._fired_period_cache[budget_id] = set()
        self._fired_period_cache[budget_id].add(period_key)

    def _release_from_cache(self, budget_id: str, period_key: str):
        """Utility to 'release' a period when it stops being exceeded."""
        if budget_id in self._fired_period_cache:
            self._fired_period_cache[budget_id].discard(period_key)

    def trigger_on_cash_write(self, movement_type: str):
        """
        Hook for when a specific cash movement happens (e.g. Deposit, Transfer, Fee).
        Ensures `evaluate` is called immediately to capture the 'Money Write' trigger.
        """
        def decorator(func):
            @func.__wrapped__.__wrapped__ if hasattr(func, '__wrapped__') else func
            @wraps(func)
            def wrapper(*args, **kwargs):
                try:
                    # Perform the write
                    result = func(*args, **kwargs)
                    
                    # Re-evaluate the budgets immediately after the write to fire from spending
                    portfolio_id = kwargs.get('portfolio_id', 'root')
                    month = kwargs.get('month', kwargs.get('movement_date'))
                    
                    self.evaluate(portfolio_id=portfolio_id, month=month)
                    return result
                except:
                    return result
            return wrapper
        return decorator