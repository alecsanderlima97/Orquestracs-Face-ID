import { getDownloadURL, ref } from "firebase/storage";
import { storage } from "@/lib/firebase/client";

export async function getStorageFileUrl(path: string) {
  return getDownloadURL(ref(storage, path));
}
