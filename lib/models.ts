export type UserRole = "owner" | "admin" | "reader" | "developer";

export type PunchType = "entry" | "lunch_out" | "lunch_back" | "exit";

export type PunchStatus =
  | "on_time"
  | "late"
  | "early"
  | "outside_shift"
  | "possible_forgotten"
  | "external_work";

export type AdjustmentType =
  | "forgotten_with_evidence"
  | "external_work"
  | "manager_punch"
  | "operational_error";

export type AbsenceRule = {
  mode: "by_day" | "by_period" | "custom";
  morningAbsenceValue?: number;
  afternoonAbsenceValue?: number;
  fullDayAbsenceValue?: number;
  forgottenPunchPolicy: "allow_with_evidence" | "requires_approval" | "blocked";
  externalWorkPolicy:
    | "allow_with_reason"
    | "allow_with_photo"
    | "allow_with_geolocation"
    | "blocked";
  requireManagerApproval: boolean;
};

export type RetentionPolicy = {
  punchPhotoRetentionYears: 2 | 5 | "custom";
  customRetentionMonths?: number;
  blockDeletionWhenUnderDispute: boolean;
};

export type CollectiveJourney = {
  id: string;
  name: string;
  entry: string;
  lunchOut: string;
  lunchBack: string;
  exit: string;
  workDaysPerWeek: number;
  toleranceMinutes: number;
  weeklyMinutes: number;
  requiresCompensation: boolean;
  allowsHourBank: boolean;
};

export type IndividualJourney = Omit<CollectiveJourney, "id" | "name"> & {
  reason: string;
};

export type Company = {
  id: string;
  legalName: string;
  cnpj: string;
  ownerUserId: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  defaultJourneyId?: string;
  absenceRule: AbsenceRule;
  retentionPolicy: RetentionPolicy;
  createdAt: Date;
  updatedAt: Date;
};

export type Invite = {
  id: string;
  companyId: string;
  email: string;
  role: Exclude<UserRole, "developer">;
  status: "pending" | "accepted" | "expired" | "revoked";
  invitedBy: string;
  expiresAt: Date;
  createdAt: Date;
};

export type AppUser = {
  id: string;
  companyId?: string;
  name: string;
  email: string;
  role: UserRole;
  createdAt: Date;
};

export type Employee = {
  id: string;
  companyId: string;
  name: string;
  cpf: string;
  phone?: string;
  admissionDate: string;
  role: string;
  department?: string;
  pinHash: string;
  journeyMode: "collective" | "individual";
  collectiveJourneyId?: string;
  individualJourney?: IndividualJourney;
  faceIdStatus: "not_registered" | "registered" | "needs_review";
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type FaceIdRecord = {
  id: string;
  companyId: string;
  employeeId: string;
  photoPath: string;
  consentAcceptedAt: Date;
  capturedBy: string;
  createdAt: Date;
};

export type Punch = {
  id: string;
  companyId: string;
  employeeId: string;
  type: PunchType;
  status: PunchStatus;
  occurredAt: Date;
  serverRecordedAt: Date;
  photoPath: string;
  deviceId: string;
  source: "face_id" | "pin_photo" | "manager";
  hash: string;
  previousHash?: string;
};

export type PunchAdjustment = {
  id: string;
  companyId: string;
  employeeId: string;
  punchId?: string;
  type: AdjustmentType;
  adjustedPunchType: PunchType;
  adjustedTime: Date;
  reason: string;
  evidence: string;
  createdBy: string;
  createdAt: Date;
};

export type AuditLog = {
  id: string;
  companyId: string;
  actorUserId: string;
  action: string;
  entityType: string;
  entityId: string;
  hash: string;
  previousHash?: string;
  createdAt: Date;
};
