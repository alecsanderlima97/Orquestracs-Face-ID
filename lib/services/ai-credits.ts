import { getFunctions, httpsCallable } from "firebase/functions";
import { firebaseApp } from "@/lib/firebase/client";
import type { TenantSaasConfig } from "@/lib/services/tenant-access";

const functions = getFunctions(firebaseApp, "us-east1");

export async function consumeAiCredit(tenantId: string, amount = 1) {
  const callable = httpsCallable<
    { tenantId: string; amount: number },
    { tenantId: string; balance: number; used: number; bonus: number; included: number }
  >(functions, "consumeAiCredit");
  const result = await callable({ tenantId, amount });
  return result.data;
}

export async function adjustAiCredits({
  tenantId,
  credits,
  reason,
}: {
  tenantId: string;
  credits: number;
  reason: string;
}) {
  const callable = httpsCallable<
    { tenantId: string; credits: number; reason: string },
    {
      tenantId: string;
      balance: number;
      bonus: number;
      included: number;
      used: number;
      adjustmentId: string;
    }
  >(functions, "adjustAiCredits");
  const result = await callable({ tenantId, credits, reason });
  return result.data;
}

export function applyCreditResult(config: TenantSaasConfig, result: {
  balance: number;
  bonus: number;
  included: number;
  used: number;
}) {
  return {
    ...config,
    aiCredits: {
      ...config.aiCredits,
      balance: result.balance,
      bonus: result.bonus,
      included: result.included,
      used: result.used,
    },
  } satisfies TenantSaasConfig;
}
