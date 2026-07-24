import { addDoc, collection, getDocs, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { Invite } from "@/lib/models";

const invitesRef = collection(db, "invites");

export async function createInvite(invite: Omit<Invite, "id">) {
  return addDoc(invitesRef, invite);
}

export async function listCompanyInvites(companyId: string) {
  const snapshot = await getDocs(query(invitesRef, where("companyId", "==", companyId)));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as Invite);
}
