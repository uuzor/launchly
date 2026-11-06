import { useEffect, useState } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { LogOut, Menu, Plus, Search, Wallet, X } from "lucide-react";
import FaucetButton from "@/components/shared/FaucetButton";
import { shortAccount, useWallet } from "@/lib/wallet";
import { cn } from "@/lib/utils";

const links = [
  { to: "/discover", label: "Discovery" },
  { to: "/coins", label: "Markets" },
  { to: "/creators", label: "Creators", badge: "New" },
  { to: "/dashboard", label: "Dashboard" },
];

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2.5" aria-label="Launchly home">
      <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-white text-[15px] font-extrabold text-black">
        L
      </span>
      <span className="text-[17px] font-semibold tracking-tight text-white">Launchly</span>
      <span className="hidden rounded-full border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-red-400 sm:inline">
        Beta
      </span>
    </Link>
  );
}

export default function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const { accountId, connected, signIn, signOut } = useWallet();
  const location = useLocation();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const isActive = (to) => location.pathname === to || location.pathname.startsWith(`${to}/`);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-all duration-300",
        scrolled || open
          ? "border-b border-white/[0.07] bg-[#080808]/85 backdrop-blur-xl"
          : "border-b border-transparent bg-transparent"
      )}
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <Logo />

        <nav className="hidden items-center gap-0.5 rounded-full border border-white/10 bg-white/[0.04] p-1 backdrop-blur-md lg:flex">
          <Link
            to="/launch"
            className="flex items-center gap-1 rounded-full bg-brand px-3.5 py-1.5 text-[13px] font-semibold text-black transition hover:brightness-105"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={3} /> Launch
          </Link>
          {links.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors",
                isActive(link.to)
                  ? "bg-white/10 text-white"
                  : "text-white/60 hover:bg-white/[0.06] hover:text-white"
              )}
            >
              {link.label}
              {link.badge && (
                <span className="rounded-full bg-brand/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-brand">
                  {link.badge}
                </span>
              )}
            </Link>
          ))}
          <Link
            to="/discover"
            aria-label="Search products"
            className="grid h-7 w-7 place-items-center rounded-full text-white/50 transition-colors hover:bg-white/[0.08] hover:text-white"
          >
            <Search className="h-3.5 w-3.5" />
          </Link>
        </nav>

        <div className="flex items-center gap-2">
          {connected && <FaucetButton className="hidden sm:flex" />}
          {connected ? (
            <span className="hidden items-center gap-2 rounded-full border border-brand/30 bg-brand/10 px-4 py-2 text-[13px] font-semibold text-brand sm:flex">
              <Wallet className="h-3.5 w-3.5" />
              <span className="num">{shortAccount(accountId)}</span>
              <button
                type="button"
                onClick={signOut}
                aria-label="Disconnect wallet"
                title="Disconnect"
                className="text-brand/60 transition-colors hover:text-brand"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={signIn}
              className="hidden items-center gap-2 rounded-full bg-white px-4 py-2 text-[13px] font-semibold text-black transition hover:bg-white/90 sm:flex"
            >
              <Wallet className="h-3.5 w-3.5" />
              Connect wallet
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle navigation"
            className="grid h-9 w-9 place-items-center rounded-full border border-white/10 text-white/80 lg:hidden"
          >
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-white/[0.07] bg-[#080808]/95 px-4 pb-5 pt-3 lg:hidden">
          <div className="flex flex-col gap-1">
            {[{ to: "/launch", label: "Launch a product" }, ...links].map(
              (link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  className={cn(
                    "rounded-xl px-3 py-2.5 text-sm font-medium",
                    isActive(link.to) ? "bg-white/[0.08] text-white" : "text-white/65"
                  )}
                >
                  {link.label}
                </Link>
              )
            )}
          </div>
          {connected && (
            <FaucetButton label="Get test USDT" className="mt-3 w-full justify-center py-2.5" />
          )}
          {connected ? (
            <div className="mt-3 flex w-full items-center justify-between gap-2 rounded-xl border border-brand/30 bg-brand/10 px-4 py-2.5 text-sm font-semibold text-brand">
              <span className="num truncate">{accountId}</span>
              <button
                type="button"
                onClick={signOut}
                className="flex shrink-0 items-center gap-1.5 text-brand/70 hover:text-brand"
              >
                <LogOut className="h-4 w-4" /> Disconnect
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={signIn}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-white py-2.5 text-sm font-semibold text-black"
            >
              <Wallet className="h-4 w-4" />
              Connect wallet
            </button>
          )}
          <p className="mt-3 text-center text-[10px] uppercase tracking-[0.18em] text-white/30">
            NEAR testnet · every trade is a signed transaction
          </p>
        </div>
      )}
    </header>
  );
}