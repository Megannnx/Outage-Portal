/**
 * Backhaul providers are private: their names must never appear in anything
 * sent to residents or ISPs. Customer wording comes from approved templates,
 * the cause/fault vocabularies and the verified RFO, so those are checked here
 * before they can be saved, approved or sent.
 */
import { backhaulProviders, sites } from "../db/schema";
import { badRequest } from "../lib/errors";
import type { Tx } from "../db/client";

/** Contract intermediaries that are also kept private. */
const ALWAYS_PRIVATE = ["Connexifi", "Connexify", "Gaia"];

export async function privateTerms(db: Tx): Promise<string[]> {
  const provs = await db.select({ name: backhaulProviders.name, publicName: backhaulProviders.publicName, aliases: backhaulProviders.aliases }).from(backhaulProviders);
  const siteNames = (await db.select({ name: sites.name }).from(sites)).map((s) => s.name.toLowerCase());
  const terms = new Set<string>(ALWAYS_PRIVATE);
  for (const p of provs) for (const t of [p.name, p.publicName, ...(p.aliases ?? [])]) if (t && t.trim().length >= 3) terms.add(t.trim());
  // A term that is part of a site name (e.g. "Arun" in "Arun Place") would block legitimate wording.
  return [...terms].filter((t) => !siteNames.some((n) => n.includes(t.toLowerCase())));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function findPrivateTerm(text: string, terms: string[]): string | null {
  for (const t of terms) if (new RegExp(`(^|[^\\p{L}\\p{N}])${esc(t)}($|[^\\p{L}\\p{N}])`, "iu").test(text)) return t;
  return null;
}

export async function assertNoPrivateTerms(db: Tx, text: string, what: string) {
  const hit = findPrivateTerm(text, await privateTerms(db));
  if (hit) throw badRequest(`${what} mentions "${hit}". Backhaul providers are kept private and must not appear in client communications — please reword.`);
}
