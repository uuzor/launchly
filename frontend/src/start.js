import { createStart } from "@tanstack/react-start";
import { errorCaptureFunctionMiddleware, errorCaptureRequestMiddleware } from "@/lib/error-capture";

// Error capture only: structured server-error logging. No auth middleware —
// Launchly pages are public and the backend APIs are permissionless reads.
export const startInstance = createStart(() => ({
  requestMiddleware: [errorCaptureRequestMiddleware],
  functionMiddleware: [errorCaptureFunctionMiddleware],
}));
