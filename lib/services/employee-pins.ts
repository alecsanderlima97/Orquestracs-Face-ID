import { getFunctions, httpsCallable } from "firebase/functions";
import { firebaseApp } from "@/lib/firebase/client";

const functions = getFunctions(firebaseApp, "us-east1");

type VerifiedEmployeePin = {
  employeeId: string;
  externalPunchAllowed: boolean;
  name: string;
};

export async function saveEmployeePin(companyId: string, employeeId: string, pin: string) {
  const callable = httpsCallable<
    { companyId: string; employeeId: string; pin: string },
    { employeeId: string; pinConfigured: boolean }
  >(functions, "setEmployeePin");
  const result = await callable({ companyId, employeeId, pin });
  return result.data;
}

export async function verifyEmployeePin(companyId: string, pin: string) {
  const callable = httpsCallable<
    { companyId: string; pin: string },
    VerifiedEmployeePin
  >(functions, "verifyEmployeePin");
  const result = await callable({ companyId, pin });
  return result.data;
}
