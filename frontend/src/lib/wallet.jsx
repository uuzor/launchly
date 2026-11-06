// NEAR wallet + read-only RPC helpers (testnet).
//
// Wallet Selector prompts the user per transaction; every execution below is
// an explicit user-signed action. Views use plain RPC fetches (no wallet).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Buffer } from "buffer";

// near-api-js internals expect Node's Buffer; install it once.
if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

export const CONTRACT_ID =
  import.meta.env.VITE_LAUNCHLY_CONTRACT ?? "launchlyv5-1105.testnet";
export const NETWORK = import.meta.env.VITE_NEAR_NETWORK ?? "testnet";
export const RPC_URL =
  import.meta.env.VITE_NEAR_RPC ?? "https://rpc.testnet.fastnear.com";

export const YOCTO = 10n ** 24n;
export const TGAS = 10n ** 12n;
export const GAS_300 = (300n * TGAS).toString();
export const ONE_YOCTO = "1";
export const STORAGE_DEPOSIT = (125n * 10n ** 19n).toString(); // 0.00125 NEAR

const WalletContext = createContext(null);

let selectorPromise = null;

async function loadSelector() {
  if (!selectorPromise) {
    selectorPromise = (async () => {
      const [{ setupWalletSelector }, { setupMyNearWallet }, { setupMeteorWallet }, { setupModal }] =
        await Promise.all([
          import("@near-wallet-selector/core"),
          import("@near-wallet-selector/my-near-wallet"),
          import("@near-wallet-selector/meteor-wallet"),
          import("@near-wallet-selector/modal-ui"),
        ]);
      await import("@near-wallet-selector/modal-ui/styles.css");
      const selector = await setupWalletSelector({
        network: NETWORK,
        modules: [setupMyNearWallet(), setupMeteorWallet()],
      });
      const modal = setupModal(selector, {
        contractId: CONTRACT_ID,
        theme: "dark",
        description: "Connect to trade, post, vote and claim on Launchly.",
      });
      return { selector, modal };
    })();
  }
  return selectorPromise;
}

export function WalletProvider({ children }) {
  const [accountId, setAccountId] = useState(null);
  const [ready, setReady] = useState(false);
  const [handles, setHandles] = useState(null);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let live = true;
    loadSelector()
      .then(({ selector, modal }) => {
        if (!live) return;
        setHandles({ selector, modal });
        const sub = selector.store.observable.subscribe((state) => {
          if (live) setAccountId(state.accounts[0]?.accountId ?? null);
        });
        setReady(true);
        return () => sub.unsubscribe();
      })
      .catch((e) => {
        // Wallet unavailable: app still works read-only, but say so loudly.
        if (live) {
          setLoadError(e?.message ?? "wallet failed to load");
          setReady(true);
        }
      });
    return () => {
      live = false;
    };
  }, []);

  const signIn = useCallback(() => {
    if (handles) {
      handles.modal.show();
    } else if (loadError) {
      // Dynamic import so the toast lib never blocks wallet setup.
      import("sonner").then(({ toast }) =>
        toast.error("Wallet failed to load", { description: String(loadError).slice(0, 160) })
      );
    }
  }, [handles, loadError]);

  const signOut = useCallback(async () => {
    const wallet = handles?.selector
      ? await handles.selector.wallet().catch(() => null)
      : null;
    await wallet?.signOut().catch(() => null);
    setAccountId(null);
  }, [handles]);

  // Sign + send one or more transactions. Each entry: { receiverId,
  // actions } with near-api-js action instances; signerId is attached here.
  // Resolves to an array of outcomes (with .transaction.hash); throws on
  // rejection or chain failure.
  const signAndSend = useCallback(
    async (transactions) => {
      if (!handles) throw new Error("Wallet not ready");
      const wallet = await handles.selector.wallet();
      const accounts = await wallet.getAccounts().catch(() => []);
      const signerId = accounts[0]?.accountId ?? accountId;
      if (!signerId) throw new Error("Wallet not signed in");
      const withSigner = transactions.map((t) => ({ signerId, ...t }));
      const outcomes = await wallet.signAndSendTransactions({ transactions: withSigner });
      const list = Array.isArray(outcomes) ? outcomes : [outcomes];
      for (const o of list) {
        const status = o?.status ?? o?.transaction?.status;
        const failure = status && typeof status === "object" && status.Failure;
        if (failure) {
          throw new Error(`Transaction failed: ${JSON.stringify(failure).slice(0, 200)}`);
        }
      }
      return list;
    },
    [handles, accountId]
  );

  const value = useMemo(
    () => ({ accountId, ready, signIn, signOut, signAndSend, connected: !!accountId }),
    [accountId, ready, signIn, signOut, signAndSend]
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  return (
    useContext(WalletContext) ?? {
      accountId: null,
      ready: false,
      signIn: () => {},
      signOut: async () => {},
      signAndSend: async () => {
        throw new Error("Wallet not ready");
      },
      connected: false,
    }
  );
}

/** Read-only contract view via RPC. Returns parsed JSON result. */
export async function rpcView(receiverId, method, args = {}) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "launchly-view",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: receiverId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`RPC ${method}: ${JSON.stringify(body.error).slice(0, 160)}`);
  const bytes = body.result?.result ?? [];
  const text = new TextDecoder().decode(Uint8Array.from(bytes));
  return text ? JSON.parse(text) : null;
}

export async function ftBalance(tokenId, accountId) {
  if (!accountId) return null;
  try {
    const bal = await rpcView(tokenId, "ft_balance_of", { account_id: accountId });
    return BigInt(bal ?? "0");
  } catch {
    return null;
  }
}

export async function storageBalance(tokenId, accountId) {
  try {
    return await rpcView(tokenId, "storage_balance_of", { account_id: accountId });
  } catch {
    return null;
  }
}

export function formatUnits(raw, decimals, maxFrac = 4) {
  if (raw == null) return "—";
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

/** Parse "1.5" into base units; returns null on invalid input. */
export function parseUnits(text, decimals) {
  const m = String(text ?? "").trim().match(/^(\d+)(?:\.(\d*))?$/);
  if (!m) return null;
  const frac = (m[2] ?? "").padEnd(decimals, "0").slice(0, decimals);
  try {
    return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || "0");
  } catch {
    return null;
  }
}

export function shortAccount(a = "") {
  if (a.length <= 20) return a;
  return `${a.slice(0, 8)}…${a.slice(-6)}`;
}
