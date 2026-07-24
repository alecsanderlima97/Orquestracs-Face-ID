import { addDoc, collection, getDocs } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import type { CollectiveJourney } from "@/lib/models";

function journeysRef(companyId: string) {
  return collection(db, "companies", companyId, "journeys");
}

export async function createCollectiveJourney(
  companyId: string,
  journey: Omit<CollectiveJourney, "id">,
) {
  return addDoc(journeysRef(companyId), journey);
}

export async function listCollectiveJourneys(companyId: string) {
  const snapshot = await getDocs(journeysRef(companyId));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as CollectiveJourney);
}
