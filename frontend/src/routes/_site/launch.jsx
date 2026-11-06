import { createFileRoute } from "@tanstack/react-router";
import LaunchWizard from "@/components/launch/LaunchWizard";

export const Route = createFileRoute("/_site/launch")({
  head: () => ({
    meta: [
      { title: "Launch a product — Launchly" },
      { name: "description", content: "List a product, publish its campaign rules and launch its coin on a bonding curve." },
    ],
  }),
  component: LaunchWizard,
});