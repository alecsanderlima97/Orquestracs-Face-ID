import { getFunctions, httpsCallable } from "firebase/functions";
import { firebaseApp } from "@/lib/firebase/client";
import type { PunchType } from "@/lib/models";

const functions = getFunctions(firebaseApp, "us-east1");

export type RepPunchReceipt = {
  companyCnpj: string;
  companyName: string;
  employeeCpf: string;
  employeeName: string;
  hash: string;
  inpiRegistration: string;
  nsr: number;
  occurredAt: string;
  title: string;
};

type RegisterRepPunchInput = {
  companyId: string;
  deviceId: string;
  employeeId: string;
  externalReason?: string;
  location?: {
    accuracy?: number;
    latitude?: number;
    longitude?: number;
    status: "captured" | "denied" | "unavailable" | "timeout";
  };
  origin: "kiosk" | "external" | "manager_adjustment";
  photoPath: string;
  source: "face_id" | "pin_photo" | "external_face_id" | "external_pin_photo" | "manager";
  type: PunchType;
};

type RegisterRepPunchResult = {
  complianceMode: "pilot" | "production";
  missingFields: string[];
  punchId: string;
  receipt: RepPunchReceipt;
};

export async function registerRepPunch(input: RegisterRepPunchInput) {
  const callable = httpsCallable<RegisterRepPunchInput, RegisterRepPunchResult>(
    functions,
    "registerRepPunch",
  );
  const result = await callable(input);
  return result.data;
}

type RepExportsResult = {
  aej: string;
  afd: string;
  filenames: { aej: string; afd: string };
  missingFields: string[];
  officialReady: boolean;
  signatureStatus: "missing_icp_brasil";
};

export async function generateRepExports(companyId: string, startDate: string, endDate: string) {
  const callable = httpsCallable<
    { companyId: string; startDate: string; endDate: string },
    RepExportsResult
  >(functions, "generateRepExports");
  const result = await callable({ companyId, startDate, endDate });
  return result.data;
}
