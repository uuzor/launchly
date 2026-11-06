//! Pure bonding-curve math for Launchly product coins.
//!
//! Linear curve: the marginal price of whole-token number x, in reserve base
//! units per whole token, is `p(x) = p0 + rise * x / CURVE_TOKENS`.
//! The cost of `dq` token base units starting from `sold` base units sold is:
//!   cost = (p0 * dq + rise * (sold * dq + dq^2 / 2) / CURVE_SUPPLY) / DECIMALS_T
//! Intermediates use U256; creation-time bounds on the parameters keep every
//! intermediate far inside U256 and the result inside u128.

uint::construct_uint! {
    /// 256-bit unsigned integer for overflow-safe curve intermediates.
    pub struct U256(4);
}

/// Product-token decimals: base units per whole token.
pub const DECIMALS_T: u128 = 1_000_000_000_000_000_000;
/// Total supply: 1e9 tokens. 90% sells on the curve, 10% locked for founder.
pub const TOTAL_SUPPLY: u128 = 1_000_000_000 * DECIMALS_T;
pub const CURVE_SUPPLY: u128 = 900_000_000 * DECIMALS_T;
pub const FOUNDER_SUPPLY: u128 = 100_000_000 * DECIMALS_T;
/// Parameter bounds enforced at product creation (keep U256 math safe and
/// prices sane). With rise <= 1e18 the largest intermediate is
/// 1e18 * 1.215e54 = 1.215e72, far below U256::MAX (~1.15e77).
pub const MAX_P0: u128 = 1_000_000_000_000_000_000_000_000; // 1e24
pub const MAX_RISE: u128 = 1_000_000_000_000_000_000; // 1e18

const _: () = assert!(TOTAL_SUPPLY == CURVE_SUPPLY + FOUNDER_SUPPLY);

/// Reserve cost of buying `dq` token base units when `sold` are already sold.
/// Rounds up when `round_up` (buys favor the protocol) else down (sells favor
/// the protocol by paying out less).
pub fn curve_cost(sold: u128, dq: u128, p0: u128, rise: u128, round_up: bool) -> u128 {
    assert!(sold <= CURVE_SUPPLY, "sold exceeds curve supply");
    assert!(dq <= CURVE_SUPPLY - sold, "amount exceeds remaining supply");
    assert!(p0 <= MAX_P0 && rise <= MAX_RISE, "curve params out of bounds");
    if dq == 0 {
        return 0;
    }
    let (sold, dq, p0, rise) = (
        U256::from(sold),
        U256::from(dq),
        U256::from(p0),
        U256::from(rise),
    );
    let base = p0 * dq;
    let slope = rise * (sold * dq + dq * dq / 2) / U256::from(CURVE_SUPPLY);
    let num = base + slope;
    let den = U256::from(DECIMALS_T);
    let bump = if round_up && num % den != U256::from(0u8) {
        U256::from(1u8)
    } else {
        U256::from(0u8)
    };
    let out = num / den + bump;
    assert!(
        out <= U256::from(u128::MAX),
        "curve cost exceeds u128"
    );
    out.low_u128()
}

/// Maximum token base units buyable with `net_reserve` (fee already taken
/// out), plus their exact cost. Binary search: ~90 cheap iterations.
pub fn buy_quote(net_reserve: u128, sold: u128, p0: u128, rise: u128) -> (u128, u128) {
    let remaining = CURVE_SUPPLY.saturating_sub(sold);
    if remaining == 0 || net_reserve == 0 {
        return (0, 0);
    }
    let mut lo = 0u128;
    let mut hi = remaining;
    while lo < hi {
        let mid = lo + (hi - lo + 1) / 2;
        if curve_cost(sold, mid, p0, rise, true) <= net_reserve {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    if lo == 0 {
        (0, 0)
    } else {
        (lo, curve_cost(sold, lo, p0, rise, true))
    }
}

/// Reserve proceeds for selling `dq` token base units. Same integral as a buy
/// over [sold - dq, sold], rounded down.
pub fn sell_proceeds(sold: u128, dq: u128, p0: u128, rise: u128) -> u128 {
    assert!(dq <= sold, "sell amount exceeds sold supply");
    curve_cost(sold - dq, dq, p0, rise, false)
}

/// Fee in basis points, rounded down (favors the trader; dust goes to pool).
pub fn fee_of(amount: u128, bps: u16) -> u128 {
    amount * bps as u128 / 10_000
}

/// Split a fee exactly: 70% pool, 20% ops, remainder to founder.
pub fn split_fee(fee: u128) -> (u128, u128, u128) {
    let pool = fee * 70 / 100;
    let ops = fee * 20 / 100;
    (pool, ops, fee - pool - ops)
}

#[cfg(test)]
mod tests {
    use super::*;

    const P0: u128 = 100; // $0.0001/token at 6-decimal reserve
    const RISE: u128 = 9_900; // rises to $0.01/token at full curve

    #[test]
    fn flat_curve_cost_is_exact() {
        // rise = 0: cost(dq) = p0 * dq / 1e18 exactly for whole tokens.
        let dq = 5 * DECIMALS_T;
        assert_eq!(curve_cost(0, dq, P0, 0, true), 500);
        assert_eq!(curve_cost(0, dq, P0, 0, false), 500);
        // Independent of how much was sold before.
        assert_eq!(curve_cost(123 * DECIMALS_T, dq, P0, 0, true), 500);
    }

    #[test]
    fn sloped_curve_exact_case() {
        // p0 = 0, rise = 9e17 (within MAX_RISE):
        // cost = 9e17 * (q*dq + dq^2/2) / 9e26 / 1e18.
        // q = dq = 1e18 -> 9e17 * 1.5e36 / 9e26 / 1e18 = 1.5e9 exactly.
        let c = curve_cost(DECIMALS_T, DECIMALS_T, 0, 900_000_000_000_000_000, true);
        assert_eq!(c, 1_500_000_000);
    }

    #[test]
    fn cost_rises_with_sold_and_amount() {
        let a = curve_cost(0, DECIMALS_T, P0, RISE, true);
        let b = curve_cost(100_000_000 * DECIMALS_T, DECIMALS_T, P0, RISE, true);
        assert!(b > a, "later tokens cost more: {a} vs {b}");
        let one = curve_cost(0, DECIMALS_T, P0, RISE, true);
        let two = curve_cost(0, 2 * DECIMALS_T, P0, RISE, true);
        assert!(two > 2 * one - 2, "convex: {one} vs {two}");
    }

    #[test]
    fn buy_quote_spends_budget_tightly() {
        let (dq, cost) = buy_quote(10_000, 0, P0, RISE);
        assert!(dq > 0);
        assert!(cost <= 10_000);
        // One more base unit would exceed the budget (or nothing remains).
        if dq < CURVE_SUPPLY {
            assert!(curve_cost(0, dq + 1, P0, RISE, true) > 10_000);
        }
    }

    #[test]
    fn buy_quote_handles_zero_and_sold_out() {
        assert_eq!(buy_quote(0, 0, P0, RISE), (0, 0));
        assert_eq!(buy_quote(1_000_000, CURVE_SUPPLY, P0, RISE), (0, 0));
        // Dust budget below the cost of 1 base unit buys nothing.
        assert_eq!(buy_quote(0, 0, P0, RISE), (0, 0));
    }

    #[test]
    fn buy_quote_can_take_whole_curve() {
        let full_cost = curve_cost(0, CURVE_SUPPLY, P0, RISE, true);
        let (dq, cost) = buy_quote(full_cost, 0, P0, RISE);
        assert_eq!(dq, CURVE_SUPPLY);
        assert_eq!(cost, full_cost);
    }

    #[test]
    fn sell_roundtrip_conserves_value() {
        // Buy then immediately sell back: proceeds <= cost (rounding only).
        let (dq, cost) = buy_quote(50_000, 0, P0, RISE);
        let back = sell_proceeds(dq, dq, P0, RISE);
        assert!(back <= cost);
        assert!(cost - back <= 2, "lost {cost} vs {back}");
    }

    #[test]
    fn sell_after_more_buys_earns_more() {
        // Same lot size sold from two far-apart supplies: the later sale
        // earns strictly more on the rising curve.
        let lot = 1_000 * DECIMALS_T;
        let early = sell_proceeds(10_000 * DECIMALS_T, lot, P0, RISE);
        let late = sell_proceeds(500_000_000 * DECIMALS_T, lot, P0, RISE);
        assert!(late > early, "{early} vs {late}");
    }

    #[test]
    fn fee_split_is_exact() {
        for fee in [0, 1, 3, 99, 100, 101, 1_000_000_000_000u128] {
            let (a, b, c) = split_fee(fee);
            assert_eq!(a + b + c, fee, "fee={fee}");
            assert_eq!(a, fee * 70 / 100);
            assert_eq!(b, fee * 20 / 100);
        }
        // Tiny fee of 1 unit goes entirely to the founder share (remainder).
        assert_eq!(split_fee(1), (0, 0, 1));
    }

    #[test]
    fn fee_of_one_percent() {
        assert_eq!(fee_of(10_000, 100), 100);
        assert_eq!(fee_of(99, 100), 0); // rounds down
        assert_eq!(fee_of(10_000, 50), 50);
        assert_eq!(fee_of(10_000, 200), 200);
    }

    #[test]
    fn supply_splits_curve_and_founder() {
        assert_eq!(TOTAL_SUPPLY, CURVE_SUPPLY + FOUNDER_SUPPLY);
        assert_eq!(FOUNDER_SUPPLY * 10, TOTAL_SUPPLY); // founder holds 10%
    }

    #[test]
    fn max_params_do_not_overflow() {
        // Worst case the contract allows: full-curve buy at max p0/rise.
        let c = curve_cost(0, CURVE_SUPPLY, MAX_P0, MAX_RISE, true);
        assert!(c > 0);
        let (dq, _) = buy_quote(c, 0, MAX_P0, MAX_RISE);
        assert_eq!(dq, CURVE_SUPPLY);
    }

    #[test]
    #[should_panic(expected = "curve params out of bounds")]
    fn params_over_max_panic() {
        let _ = curve_cost(0, 1, MAX_P0 + 1, 0, true);
    }
}
