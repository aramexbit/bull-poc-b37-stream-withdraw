# BullStream `withdraw()` / `cancel()` never pay — payout transfer is misrouted (B-37 candidate)

**Contract:** BullStream `0xf02ad48d7ae63f17941e78aaf228c1450db13891`, Robinhood Chain (4663), deployed ~2026-11-20.
**Severity:** Major. **Status:** candidate — forge PoC green, see below.
**Bounty:** Bull.family bug bounty (Major $100–$500). **Contact:** X [@brian_byar17103](https://x.com/brian_byar17103).

## What

`withdraw(id)` never pays the payee. Its payout transfer is misrouted: it calls
`transfer(arbiter, amount)` on the **payer** address as if the payer were the token
contract. When the payer is a normal EOA wallet (the normal case), that CALL is a
no-op success (empty returndata treated as success), the function marks the full
amount as claimed, returns the amount as if it had paid — and the stream is
permanently bricked (later `withdraw()` calls revert `0xddafad98`; neither party can
claim the funds back).

`cancel(id)` (payee-only) has the same swap in its refund path: it calls
`transfer(payee, amount)` on the payer-as-token, so the unvested refund also moves
0 tokens.

## How (reproduced)

Stream struct (verified against the contract's own `stream(id)` getter, which returns
the storage slots in order): slot+0 payee, +1 arbiter, +2 asset (ERC20), +3 payer,
+4 amount, +5 claimed, +6 packed (start | field<<64 | field<<128 | status<<192).
Status 1 = active.

Test stream: payee `0xf39F…92266`, arbiter `0x7099…79C8`, asset USDG
`0x5fc5…1d168`, payer `0x90F7…b906`, amount 500 USDG, start = now − 10000, status 1.
Stream contract funded with 2000 USDG. `withdrawable(1)` = 500000000 before the call.

Honest payee calls `withdraw(1)` — `callTracer` trace of the inner CALL:

```json
{"from": "0xf02ad48d7ae63f17941e78aaf228c1450db13891", "gasUsed": "0x0",
 "to": "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
 "input": "0xa9059cbb00000000000000000000000070997970c51812dc3a010c7d01b50e0d17dc79c8
           000000000000000000000000000000000000000000000000000000001dcd6500",
 "type": "CALL"}
```

- Inner CALL target = `0x90F7…` = the **payer**, not the USDG token.
- Calldata = `transfer(to = 0x7099…` = the **arbiter**, `amount = 0x1dcd6500` = 500000000).
- `gasUsed 0x0`: the target is an EOA, so the call is a no-op success.
- `withdraw()` returned `500000000` as if it had paid.
- Balances after: payee +0, payer +0, arbiter +0, stream contract unchanged.
- `stream(1)` after: `claimed = 500000000` (full). Payee retry reverts `0xddafad98`.
- Attacker `claim(USDG)` and payee `claim(USDG)` both revert `0xf9820cc1` (no fee balance).

Griefing: an attacker calling `withdraw(id)` first has the same effect — the stream is
bricked and the payee can never withdraw (verified: attacker withdraw succeeds, payee
retry reverts `0xddafad98`, nobody gains).

Cancel: payee cancels an unvested stream (withdrawable 0, unvested 500). The refund
CALL is `transfer(payee, 500000000)` sent to the payer-as-token; payer receives 0;
stream keeps the funds; withdraw after cancel reverts `0xddafad98`.

## Impact

- No stream can ever pay out its vested funds through `withdraw()`.
- Any caller (including a random attacker, at zero cost, no role needed) can permanently
  brick any stream by calling `withdraw()` once; the honest payee's own first withdraw
  bricks their stream too.
- Funds locked in the contract have no recovery path: `cancel()` refunds 0 (same bug),
  `claim()` only covers fee balances (verified working and caller-keyed).
- Honest note: the contract is brand new (0 streams live as of 21 Nov 2026), so no funds
  are at risk yet — this is a latent total-break of the contract's core function.

## Suggested fix

In `withdraw()`, pass `(asset = slot+2, payee = slot+0)` to the transfer helper
(instead of slot+3 / slot+1). In `cancel()`, pass `(asset = slot+2, payer = slot+3)`
for the unvested refund. Audit every other payout site for the same one-slot shift.

## Run the PoC

```bash
npm install   # viem
./run.sh      # fresh Anvil (chain-id 4663) + node run.mjs; exits 0 when the bug reproduces
```

`run.mjs` etches the **live** BullStream runtime bytecode verbatim
(`chain/bytecode/stream-runtime.hex`, fetched from the Robinhood Chain RPC 21 Nov 2026)
and a mock 6-decimal USDG. Streams are fabricated with `anvil_setStorageAt` because
`createStream` needs the team's fee-signer quote, which cannot be forged; the layout
is verified against the contract's own `stream(id)` getter and `withdrawable()` math
inside the run (see `layoutCheck`). Everything runs on local Anvil; no mainnet
transactions, no real funds. Results are written to `poc-result.json`.
