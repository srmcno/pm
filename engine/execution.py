"""Asynchronous execution manager: IOC leg chaining and failure recovery.

The problem this solves
-----------------------
A triangle is not an atomic trade. It is three orders that can each fill fully,
partially, or not at all, against books that move between them. The paper desk
assumes atomic fills and is therefore an upper bound; this module is the part
that has to survive contact with reality.

Rules encoded here, in order of how much money they save
--------------------------------------------------------
1. **Leg 1 is all-or-nothing by default (FOK).** If nothing filled, nothing is
   at risk and the cycle costs zero. A partial leg 1 is not a smaller trade —
   it is an unhedged position in a micro-cap, which is the single most
   expensive thing this system can do to itself.

2. **Every subsequent leg is sized from what actually filled**, re-quantized to
   the venue's lot size. Sizing leg 2 from the *plan* rather than the *fill* is
   how a bot ends up short of inventory and cancels into a hole.

3. **After leg 1, continuing is a decision, not a reflex.** Once we hold asset
   A, there are two exits: finish legs 2-3, or sell A straight back to the
   quote. `_choose_exit` prices both against the live book and takes the better
   one. `scripts/arblive.py` always continues, which loses money precisely when
   the book has moved against the cycle — the case that matters.

4. **Unwind first, ask later.** A failed leg triggers an immediate aggressive
   IOC back to the quote asset, crossing `unwind_cross_bps` through the bid,
   escalating on each retry. Holding inventory to avoid a few bps of slippage
   is how a few bps becomes the whole bankroll.

5. **The chain has a deadline.** Past `max_leg_latency_ms` on any leg the cycle
   aborts and unwinds, because a leg that is slow to ack is usually a leg that
   is about to fill at a price the plan never contemplated.
"""
from __future__ import annotations

import asyncio
import enum
import json
import os
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping, Sequence

from .book import walk_sell, walk_buy
from .clock import LatencyHistogram, StageTimer, now_ns, wall_ms
from .config import RiskLimits
from .graph import BUY, SELL, Triangle
from .risk import RiskEngine
from .sizing import CyclePlan, LegPlan, SymbolFilters, simulate_cycle
from .venues.base import (OrderRejected, OrderRequest, OrderResult, OrderStatus,
                          RateLimited, Side, TimeInForce, VenueError)

__all__ = ["ExecutionManager", "CycleStatus", "CycleReport", "LegOutcome",
           "DepthProvider"]

# symbol -> (bid_levels, ask_levels)
DepthProvider = Callable[[str], "tuple[Sequence, Sequence] | None"]


class CycleStatus(enum.Enum):
    COMPLETE = "COMPLETE"                 # all three legs filled, flat
    NO_FILL = "NO_FILL"                   # leg 1 never filled — free abort
    UNWOUND = "UNWOUND"                   # aborted mid-chain, returned to quote
    EARLY_EXIT = "EARLY_EXIT"             # deliberately exited after leg 1/2
    STRANDED = "STRANDED"                 # inventory left; engine halts
    REJECTED = "REJECTED"                 # risk gate said no


@dataclass(slots=True)
class LegOutcome:
    leg: int
    symbol: str
    side: str
    tif: str
    requested_qty: float
    limit_price: float
    filled_base: float = 0.0
    filled_quote: float = 0.0
    status: str = "UNSENT"
    ack_ms: float = 0.0
    fill_ms: float = 0.0
    error: str = ""

    def as_dict(self) -> dict:
        return {k: getattr(self, k) for k in self.__slots__}


@dataclass
class CycleReport:
    cycle_id: str
    path: str
    status: CycleStatus = CycleStatus.REJECTED
    planned_bps: float = 0.0
    planned_usd: float = 0.0
    deployed_usd: float = 0.0
    returned_usd: float = 0.0
    legs: list[LegOutcome] = field(default_factory=list)
    stranded_asset: str = ""
    stranded_qty: float = 0.0
    reason: str = ""
    timings_us: dict = field(default_factory=dict)
    tick_to_trade_ms: float = 0.0
    total_ms: float = 0.0

    @property
    def realized_usd(self) -> float:
        return self.returned_usd - self.deployed_usd

    @property
    def realized_bps(self) -> float:
        return (self.realized_usd / self.deployed_usd * 10_000.0
                if self.deployed_usd > 0 else 0.0)

    def as_dict(self) -> dict:
        return {
            "cycleId": self.cycle_id, "path": self.path,
            "status": self.status.value, "plannedBps": round(self.planned_bps, 2),
            "plannedUsd": round(self.planned_usd, 4),
            "deployedUsd": round(self.deployed_usd, 6),
            "returnedUsd": round(self.returned_usd, 6),
            "realizedUsd": round(self.realized_usd, 6),
            "realizedBps": round(self.realized_bps, 2),
            "strandedAsset": self.stranded_asset,
            "strandedQty": self.stranded_qty,
            "reason": self.reason,
            "tickToTradeMs": round(self.tick_to_trade_ms, 2),
            "totalMs": round(self.total_ms, 2),
            "legs": [l.as_dict() for l in self.legs],
            "timingsUs": self.timings_us,
        }


class ExecutionManager:
    """Drives one cycle at a time per symbol set, many cycles concurrently."""

    def __init__(self, router: Any, risk: RiskEngine,
                 filters: Mapping[str, SymbolFilters],
                 depth: DepthProvider,
                 pairs: Mapping[tuple[str, str], str],
                 quote: str = "USDT",
                 limits: RiskLimits | None = None,
                 journal_path: str | None = None,
                 first_leg_tif: TimeInForce = TimeInForce.FOK,
                 bridges: Sequence[str] = ("USDT", "USDC", "BTC", "ETH"),
                 on_report: Callable[[CycleReport], None] | None = None) -> None:
        self.router = router
        self.risk = risk
        self.filters = filters
        self.depth = depth
        self.pairs = dict(pairs)
        self.quote = quote
        # asset -> [(symbol, side, destination asset)], for unwind routing.
        self._by_asset: dict[str, list[tuple[str, int, str]]] = {}
        for (base, quo), sym in self.pairs.items():
            self._by_asset.setdefault(base, []).append((sym, SELL, quo))
            self._by_asset.setdefault(quo, []).append((sym, BUY, base))
        self.limits = limits or risk.limits
        self.journal_path = journal_path
        self.first_leg_tif = first_leg_tif
        self.bridges = tuple(bridges)
        self.on_report = on_report
        self._seq = 0

        self.send_hist = LatencyHistogram("exec.send_to_ack")
        self.fill_hist = LatencyHistogram("exec.send_to_fill")
        self.cycle_hist = LatencyHistogram("exec.cycle_total")
        self.reports: list[CycleReport] = []
        self.completed = 0
        self.unwound = 0
        self.stranded = 0

    # ----------------------------------------------------------------- entry

    async def execute(self, plan: CyclePlan, detected_ns: int = 0,
                      book_age_ms: float = 0.0) -> CycleReport:
        """Run one cycle end to end. Never raises — always returns a report."""
        self._seq += 1
        cid = f"arb-{wall_ms()}-{self._seq}"
        tri = plan.tri
        rep = CycleReport(cid, tri.path, planned_bps=plan.bps,
                          planned_usd=plan.capital_usd)
        timer = StageTimer(detected_ns or now_ns())

        age_ms = (now_ns() - detected_ns) / 1e6 if detected_ns else 0.0
        verdict = self.risk.check_cycle(plan.capital_usd, plan.bps, age_ms,
                                        book_age_ms, tri.symbols)
        timer.mark("risk")
        if not verdict:
            rep.status = CycleStatus.REJECTED
            rep.reason = verdict.reason
            self._finish(rep, timer)
            return rep

        self.risk.lease(tri.symbols)
        self.risk.record_stake(plan.capital_usd)
        try:
            await self._run(plan, rep, timer)
        except asyncio.CancelledError:
            rep.status = CycleStatus.STRANDED
            rep.reason = "cancelled mid-chain"
            raise
        except Exception as e:  # noqa: BLE001 - a bug here must not wedge the loop
            rep.status = CycleStatus.STRANDED
            rep.reason = f"unhandled: {e}"
        finally:
            self.risk.release(tri.symbols)
            self._finish(rep, timer)
        return rep

    # ------------------------------------------------------------- the chain

    async def _run(self, plan: CyclePlan, rep: CycleReport, timer: StageTimer) -> None:
        tri = plan.tri
        legs = plan.legs

        # ---- leg 1 --------------------------------------------------------
        l1 = legs[0]
        tif1 = self.first_leg_tif
        out1, row1 = await self._send(1, l1, tif1, rep)
        timer.mark("leg1")
        if out1.filled_base <= 0:
            rep.status = CycleStatus.NO_FILL
            rep.reason = row1.error or "leg 1 did not fill"
            return

        held_asset = _dst_asset(tri, 0)
        held_qty, spent = _leg1_position(l1, out1)
        rep.deployed_usd = spent
        self.risk.ledger.credit(held_asset, held_qty, spent)

        # ---- decide: continue, or exit straight back to the quote? ---------
        cont_out, exit_out = self._choose_exit(tri, held_asset, held_qty, plan)
        timer.mark("decide")
        if exit_out > cont_out * 1.0001 and exit_out > 0:
            rep.reason = (f"post-leg1 book moved: direct exit "
                          f"${exit_out:.4f} > continue ${cont_out:.4f}")
            recovered = await self._unwind(held_asset, held_qty, rep, tag="early")
            rep.returned_usd += recovered
            rep.status = (CycleStatus.EARLY_EXIT if recovered > 0
                          else CycleStatus.STRANDED)
            if recovered <= 0:
                self._mark_stranded(rep, held_asset, held_qty)
            return

        # ---- leg 2 --------------------------------------------------------
        l2 = self._resize(legs[1], held_qty, tri, 1)
        if l2 is None:
            rep.reason = "leg 2 unsizeable from actual leg-1 fill"
            recovered = await self._unwind(held_asset, held_qty, rep, tag="l2size")
            rep.returned_usd += recovered
            rep.status = CycleStatus.UNWOUND if recovered > 0 else CycleStatus.STRANDED
            if recovered <= 0:
                self._mark_stranded(rep, held_asset, held_qty)
            return

        out2, row2 = await self._send(2, l2, TimeInForce.IOC, rep)
        timer.mark("leg2")
        consumed2 = out2.filled_base if l2.side == SELL else out2.filled_quote
        residual1 = max(0.0, held_qty - consumed2)
        if out2.filled_base <= 0:
            rep.reason = row2.error or "leg 2 did not fill"
            recovered = await self._unwind(held_asset, held_qty, rep, tag="l2fail")
            rep.returned_usd += recovered
            rep.status = CycleStatus.UNWOUND if recovered > 0 else CycleStatus.STRANDED
            if recovered <= 0:
                self._mark_stranded(rep, held_asset, held_qty)
            return

        self.risk.ledger.debit(held_asset, min(consumed2, held_qty), 0.0)
        held2_asset = _dst_asset(tri, 1)
        held2_qty = _leg_received(l2, out2)
        self.risk.ledger.credit(held2_asset, held2_qty, 0.0)

        # A partial leg 2 leaves the leg-1 asset behind. Clear it now, in
        # parallel with leg 3 — waiting until the end is how residue compounds.
        residual_task: asyncio.Task | None = None
        if residual1 > 0 and self._worth_unwinding(held_asset, residual1):
            residual_task = asyncio.create_task(
                self._unwind(held_asset, residual1, rep, tag="l2residual"))

        # ---- leg 3 --------------------------------------------------------
        l3 = self._resize(legs[2], held2_qty, tri, 2)
        if l3 is None:
            rep.reason = "leg 3 unsizeable from actual leg-2 fill"
            recovered = await self._unwind(held2_asset, held2_qty, rep, tag="l3size")
            rep.returned_usd += recovered
            rep.status = CycleStatus.UNWOUND if recovered > 0 else CycleStatus.STRANDED
            if recovered <= 0:
                self._mark_stranded(rep, held2_asset, held2_qty)
            await _drain(residual_task, rep)
            return

        out3, row3 = await self._send(3, l3, TimeInForce.IOC, rep)
        timer.mark("leg3")
        got3 = _leg_received(l3, out3)
        consumed3 = out3.filled_base if l3.side == SELL else out3.filled_quote
        residual2 = max(0.0, held2_qty - consumed3)

        if got3 > 0:
            rep.returned_usd += got3
            self.risk.ledger.debit(held2_asset, min(consumed3, held2_qty), got3)

        if residual2 > 0 and self._worth_unwinding(held2_asset, residual2):
            # Leg 3 failed or partially filled — this is the leg-risk case the
            # brief calls out. Hedge immediately at market rather than hoping.
            recovered = await self._unwind(held2_asset, residual2, rep, tag="l3hedge")
            rep.returned_usd += recovered
            if recovered <= 0:
                self._mark_stranded(rep, held2_asset, residual2)
                rep.status = CycleStatus.STRANDED
                rep.reason = rep.reason or "leg 3 residue could not be hedged"
                await _drain(residual_task, rep)
                return
            rep.status = CycleStatus.UNWOUND
            rep.reason = rep.reason or "leg 3 partial, residue hedged"
        elif got3 <= 0:
            rep.status = CycleStatus.STRANDED
            rep.reason = row3.error or "leg 3 did not fill"
            self._mark_stranded(rep, held2_asset, held2_qty)
            await _drain(residual_task, rep)
            return
        else:
            rep.status = CycleStatus.COMPLETE

        await _drain(residual_task, rep)

    # --------------------------------------------------------------- helpers

    async def _send(self, n: int, leg: LegPlan, tif: TimeInForce,
                    rep: CycleReport) -> tuple[OrderResult, LegOutcome]:
        """One order out, one fill in. Timing and errors land in the report.

        Returns the venue result *and* this leg's outcome row. The outcome is
        also appended to `rep.legs`, but a concurrent residual unwind can
        append between calls, so the caller gets its own row handed back rather
        than indexing into a list that moves.
        """
        side = Side.BUY if leg.side == BUY else Side.SELL
        out = LegOutcome(n, leg.symbol, side.wire, tif.value, leg.order_qty,
                         leg.limit_price)
        rep.legs.append(out)

        notional = leg.order_qty * leg.limit_price
        gate = self.risk.check_leg(leg.symbol, notional)
        if not gate.ok:
            out.status = "BLOCKED"
            out.error = gate.reason
            return OrderResult(f"{rep.cycle_id}-{n}", "", OrderStatus.REJECTED), out

        req = OrderRequest(symbol=leg.symbol, side=side, tif=tif,
                           qty=leg.order_qty, price=leg.limit_price,
                           client_id=f"{rep.cycle_id}-{n}",
                           tag=f"{rep.path}#{n}")
        t0 = now_ns()
        try:
            res = await self.router.submit(req)
        except RateLimited as e:
            out.status, out.error = "RATE_LIMITED", str(e)
            return OrderResult(req.client_id, "", OrderStatus.REJECTED), out
        except (OrderRejected, VenueError) as e:
            out.status, out.error = "REJECTED", str(e)[:200]
            return OrderResult(req.client_id, "", OrderStatus.REJECTED), out
        out.ack_ms = (now_ns() - t0) / 1e6
        self.send_hist.record(now_ns() - t0)

        if not res.status.terminal:
            timeout = self.limits.max_leg_latency_ms / 1000.0
            try:
                res = await self.router.wait_fill(req.client_id, timeout)
            except asyncio.TimeoutError:
                out.status, out.error = "TIMEOUT", f"no fill in {timeout*1000:.0f}ms"
                return res, out
        out.fill_ms = (now_ns() - t0) / 1e6
        self.fill_hist.record(now_ns() - t0)
        out.filled_base = res.filled_base
        out.filled_quote = res.filled_quote
        out.status = res.status.value
        return res, out

    def _resize(self, leg: LegPlan, available: float, tri: Triangle,
                index: int) -> LegPlan | None:
        """Re-cut a planned leg to the quantity that actually arrived.

        Returns None when the resized leg cannot legally be sent (below lot
        size or min-notional) — that is a real outcome, not an edge case, and
        the caller must unwind rather than send something illegal.
        """
        f = self.filters.get(leg.symbol)
        book = self.depth(leg.symbol)
        if leg.side == SELL:
            qty = f.qty(available) if f else available
            if qty <= 0:
                return None
            px = leg.limit_price
            if book:
                w = walk_sell(book[0], qty, leg.fee)
                if w.complete:
                    px = w.worst_px / (1.0 + 5.0 / 10_000.0)
                    px = f.price(px, SELL) if f else px
            if f and not f.ok(qty, px):
                return None
            return LegPlan(leg.symbol, SELL, px, qty, 0.0, 0.0, px, 0, leg.fee)

        # BUY leg: `available` is quote currency to spend.
        px = leg.limit_price
        qty = available / px if px > 0 else 0.0
        if book:
            w = walk_buy(book[1], available, leg.fee)
            if w.complete:
                qty = w.filled / (1.0 - leg.fee)
                px = w.worst_px * (1.0 + 5.0 / 10_000.0)
                px = f.price(px, BUY) if f else px
        qty = f.qty(qty) if f else qty
        # Guard the rounding direction: buying at a padded limit must not need
        # more quote than we hold.
        while qty > 0 and qty * px > available:
            qty = (f.qty(qty - (f.step_size or qty * 1e-6)) if f
                   else qty * 0.999)
        if qty <= 0 or (f and not f.ok(qty, px)):
            return None
        return LegPlan(leg.symbol, BUY, px, qty, available, 0.0, px, 0, leg.fee)

    def _choose_exit(self, tri: Triangle, asset: str, qty: float,
                     plan: CyclePlan) -> tuple[float, float]:
        """(value of finishing legs 2-3, value of selling straight to quote).

        Both priced against the *live* book, not the plan. This is the check
        that turns a moved market from a loss into a smaller loss.
        """
        cont = 0.0
        amt = qty
        for leg in tri.legs[1:]:
            book = self.depth(leg.symbol)
            if not book:
                cont = 0.0
                break
            fee = self.filters[leg.symbol].taker if leg.symbol in self.filters else leg.fee
            if leg.side == SELL:
                w = walk_sell(book[0], amt, fee)
            else:
                w = walk_buy(book[1], amt, fee)
            if not w.complete:
                cont = 0.0
                break
            amt = w.filled
        else:
            cont = amt
        direct = self._quote_value(asset, qty)
        return cont, direct

    def _quote_value(self, asset: str, qty: float) -> float:
        """What `qty` of `asset` fetches right now, selling into the book."""
        route = self._unwind_route(asset)
        if route is None:
            return 0.0
        symbol, side = route
        book = self.depth(symbol)
        if not book:
            return 0.0
        fee = self.filters[symbol].taker if symbol in self.filters else 0.0005
        if side == SELL:
            w = walk_sell(book[0], qty, fee)
        else:
            w = walk_buy(book[1], qty, fee)
        return w.filled if w.complete else 0.0

    def _hop_dest(self, symbol: str, side: int) -> str:
        f = self.filters.get(symbol)
        if f is None:
            return ""
        return f.quote if side == SELL else f.base

    def _unwind_route(self, asset: str) -> tuple[str, int] | None:
        """Direct pair back to the quote asset, either orientation."""
        if asset == self.quote:
            return None
        sym = self.pairs.get((asset, self.quote))
        if sym:
            return sym, SELL
        sym = self.pairs.get((self.quote, asset))
        if sym:
            return sym, BUY
        return None

    def _routes_from(self, asset: str) -> list[tuple[str, int]]:
        """Candidate first hops out of `asset`, best first.

        Direct-to-quote leads. After that come hops whose destination *has* a
        direct route to the quote asset, bridges first. This ordering is the
        difference between "leg 3's pair is broken, so we are stuck holding
        USDC" and "leg 3's pair is broken, so we went out through the other
        pair we were already trading". A direct route that just failed is
        exactly when the second option matters.
        """
        if asset == self.quote:
            return []
        out: list[tuple[str, int]] = []
        seen: set[tuple[str, int]] = set()
        direct = self._unwind_route(asset)
        if direct:
            out.append(direct)
            seen.add(direct)
        two_hop: list[tuple[int, str, int]] = []
        for sym, side, dest in self._by_asset.get(asset, ()):
            if (sym, side) in seen or dest == self.quote or not dest:
                continue
            if self._unwind_route(dest) is None:
                continue
            rank = self.bridges.index(dest) if dest in self.bridges else len(self.bridges)
            two_hop.append((rank, sym, side))
        two_hop.sort(key=lambda x: x[0])
        out.extend((sym, side) for _, sym, side in two_hop)
        return out

    def _worth_unwinding(self, asset: str, qty: float) -> bool:
        """Dust below the venue's minimum is not a position — chasing it just
        burns rate limit and produces rejects."""
        route = self._unwind_route(asset)
        if route is None:
            return True                      # can't price it: treat as real
        symbol, _ = route
        f = self.filters.get(symbol)
        if f is None:
            return qty > 0
        return f.qty(qty) > 0 and self._quote_value(asset, qty) >= max(f.min_notional, 0.5)

    async def _unwind(self, asset: str, qty: float, rep: CycleReport,
                      tag: str = "", max_hops: int = 3) -> float:
        """Get flat in `asset`. Returns USD recovered; 0.0 means still holding.

        Walks a hop at a time rather than committing to a whole route up front,
        because each hop's success changes what we hold. Every candidate route
        out of the current asset is tried before giving up, and each individual
        order escalates its own aggression inside `_unwind_hop`.
        """
        if qty <= 0 or asset == self.quote:
            return 0.0
        cur_asset, cur_qty = asset, qty
        for _hop in range(max_hops):
            if cur_asset == self.quote or cur_qty <= 0:
                break
            routes = self._routes_from(cur_asset)
            if not routes:
                rep.reason = rep.reason or f"no unwind route for {cur_asset}"
                break
            for symbol, side in routes:
                got = await self._unwind_hop(symbol, side, cur_qty, rep,
                                             f"{tag}-{cur_asset}")
                if got > 0:
                    dest = self._hop_dest(symbol, side)
                    if not dest:
                        break
                    cur_asset, cur_qty = dest, got
                    break
            else:
                break                        # every route out of here refused
        if cur_asset == self.quote and cur_qty > 0:
            self.risk.ledger.debit(asset, qty, cur_qty)
            return cur_qty
        # Ended somewhere other than the quote asset: still exposed, and the
        # report must say so in the asset we are *actually* holding now.
        if cur_asset != asset:
            rep.reason = (rep.reason or "") + f" (stalled in {cur_asset})"
            self.risk.ledger.debit(asset, qty, 0.0)
            self.risk.ledger.credit(cur_asset, cur_qty, 0.0)
            rep.stranded_asset, rep.stranded_qty = cur_asset, cur_qty
        return 0.0

    async def _unwind_hop(self, symbol: str, side: int, qty: float,
                          rep: CycleReport, tag: str) -> float:
        f = self.filters.get(symbol)
        cross = self.limits.unwind_cross_bps
        for attempt in range(self.limits.unwind_max_attempts):
            book = self.depth(symbol)
            if not book:
                await asyncio.sleep(0.05)
                continue
            fee = f.taker if f else 0.0005
            if side == SELL:
                order_qty = f.qty(qty) if f else qty
                if order_qty <= 0:
                    return 0.0
                w = walk_sell(book[0], order_qty, fee)
                ref = w.worst_px if w.complete else (book[0][0][0] if book[0] else 0.0)
                if ref <= 0:
                    return 0.0
                px = ref * (1.0 - cross / 10_000.0)
                px = f.price(px, SELL) if f else px
            else:
                w = walk_buy(book[1], qty, fee)
                ref = w.worst_px if w.complete else (book[1][0][0] if book[1] else 0.0)
                if ref <= 0:
                    return 0.0
                px = ref * (1.0 + cross / 10_000.0)
                px = f.price(px, BUY) if f else px
                order_qty = f.qty(qty / px) if f else qty / px
                if order_qty <= 0:
                    return 0.0

            leg = LegPlan(symbol, side, px, order_qty, 0.0, 0.0, px, 0, fee)
            out = LegOutcome(9, symbol, "SELL" if side == SELL else "BUY",
                             "IOC", order_qty, px)
            out.status = f"UNWIND[{tag}#{attempt}]"
            rep.legs.append(out)
            req = OrderRequest(symbol=symbol,
                               side=Side.SELL if side == SELL else Side.BUY,
                               tif=TimeInForce.IOC, qty=order_qty, price=px,
                               client_id=f"unwind-{rep.cycle_id}-{tag}-{attempt}",
                               tag=f"unwind {symbol}")
            try:
                res = await self.router.submit(req)
                if not res.status.terminal:
                    res = await self.router.wait_fill(
                        req.client_id, self.limits.max_leg_latency_ms / 1000.0)
            except Exception as e:  # noqa: BLE001 - keep escalating, do not raise
                out.error = str(e)[:200]
                cross *= 2.0
                continue
            out.filled_base = res.filled_base
            out.filled_quote = res.filled_quote
            out.status = f"UNWIND[{tag}#{attempt}]:{res.status.value}"
            got = res.filled_quote if side == SELL else res.filled_base
            if got > 0:
                return got
            # Nothing filled: cross harder. The book has moved away, and the
            # cost of another 60 bps is trivial next to holding the bag.
            cross *= 2.0
        return 0.0

    def _mark_stranded(self, rep: CycleReport, asset: str, qty: float) -> None:
        rep.stranded_asset = asset
        rep.stranded_qty = qty
        self.stranded += 1
        self.risk.halt(f"stranded {qty:.8f} {asset} on {rep.cycle_id}")

    def _finish(self, rep: CycleReport, timer: StageTimer) -> None:
        rep.timings_us = timer.spans()
        rep.total_ms = timer.elapsed_ns() / 1e6
        rep.tick_to_trade_ms = next(
            (t / 1000.0 for k, t in rep.timings_us.items() if k.endswith("->leg1")),
            rep.total_ms)
        self.cycle_hist.record(timer.elapsed_ns())
        if rep.status is CycleStatus.COMPLETE:
            self.completed += 1
        elif rep.status in (CycleStatus.UNWOUND, CycleStatus.EARLY_EXIT):
            self.unwound += 1
        if rep.deployed_usd > 0:
            self.risk.record_pnl(rep.realized_usd)
        self.reports.append(rep)
        self.reports = self.reports[-500:]
        self._journal(rep)
        if self.on_report is not None:
            try:
                self.on_report(rep)
            except Exception:  # noqa: BLE001
                pass

    def _journal(self, rep: CycleReport) -> None:
        if not self.journal_path:
            return
        try:
            os.makedirs(os.path.dirname(self.journal_path), exist_ok=True)
            with open(self.journal_path, "a") as f:
                f.write(json.dumps({"t": wall_ms(), **rep.as_dict()}) + "\n")
        except OSError:
            pass

    def stats(self) -> dict:
        return {
            "completed": self.completed, "unwound": self.unwound,
            "stranded": self.stranded, "cycles": len(self.reports),
            "sendToAck": self.send_hist.snapshot(),
            "sendToFill": self.fill_hist.snapshot(),
            "cycleTotal": self.cycle_hist.snapshot(),
        }


# ------------------------------------------------------------------- helpers

def _dst_asset(tri: Triangle, index: int) -> str:
    return tri.legs[index].dst


def _leg1_position(leg: LegPlan, res: OrderResult) -> tuple[float, float]:
    """(asset received net of fee, quote actually spent) from leg 1's fill.

    Venues report `executedQty` as the *matched* quantity and deduct the taker
    fee from the asset received, so the position is always the matched size
    net of the fee — on both sides. Getting this wrong by one fee term is a
    0.05 % sizing error on leg 2, which is the same order as the entire edge.
    """
    return _leg_received(leg, res), (res.filled_quote if leg.side == BUY
                                     else res.filled_base)


def _leg_received(leg: LegPlan, res: OrderResult) -> float:
    """What the next leg gets to work with, net of the taker fee."""
    if leg.side == BUY:
        return res.filled_base * (1.0 - leg.fee)
    return res.filled_quote * (1.0 - leg.fee)


async def _drain(task: "asyncio.Task | None", rep: CycleReport) -> None:
    if task is None:
        return
    try:
        recovered = await task
        rep.returned_usd += recovered or 0.0
    except Exception:  # noqa: BLE001
        pass
