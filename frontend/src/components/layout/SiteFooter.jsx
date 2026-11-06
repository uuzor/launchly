import { Link } from "@tanstack/react-router";
import PartnerRow from "@/components/shared/PartnerRow";
import { partners } from "@/lib/demo-data";

const columns = [
  {
    title: "Product",
    links: [
      { label: "Discover", to: "/discover" },
      { label: "Markets", to: "/coins" },
      { label: "Creators", to: "/creators" },
      { label: "Dashboard", to: "/dashboard" },
    ],
  },
  {
    title: "Builders",
    links: [
      { label: "Launch a product", to: "/launch" },
      { label: "Campaign rules", to: "/discover" },
      { label: "Milestones", to: "/dashboard" },
    ],
  },
];

export default function SiteFooter() {
  return (
    <footer className="relative border-t border-white/[0.07] bg-[#070707]">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-white text-[15px] font-extrabold text-black">
                L
              </span>
              <span className="text-[17px] font-semibold tracking-tight text-white">Launchly</span>
            </div>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-white/45">
              Build something. Launch it. Let the community help it grow. Trading fees fund the
              creators who promote the product.
            </p>
            <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1.5">
              <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-brand" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/50">
                NEAR testnet prototype
              </span>
            </div>
          </div>

          {columns.map((col) => (
            <div key={col.title}>
              <h4 className="text-[10px] font-bold uppercase tracking-[0.22em] text-white/35">
                {col.title}
              </h4>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      to={link.to}
                      className="text-sm text-white/60 transition-colors hover:text-white"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 border-t border-white/[0.07] pt-8">
          <p className="text-center text-[10px] font-semibold uppercase tracking-[0.24em] text-white/25">
            Built on NEAR · Powered by the ecosystem
          </p>
          <PartnerRow items={partners.slice(0, 8)} className="mt-5" itemClassName="text-white/25" />
        </div>

        <div className="mt-10 flex flex-col gap-3 border-t border-white/[0.07] pt-6 text-[11px] leading-relaxed text-white/30 sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 Launchly — testnet prototype. No real funds are handled.</p>
          <p className="sm:text-right">
            Reserve yield is simulated. Campaign data in this demo is simulated and labelled.
          </p>
        </div>
      </div>
    </footer>
  );
}