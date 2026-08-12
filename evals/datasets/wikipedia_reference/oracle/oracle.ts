import { fetchWikipediaReference, type WikipediaReferenceOracle } from './wikipediaClient.js';

export async function fetchOracle(): Promise<WikipediaReferenceOracle> {
  return fetchWikipediaReference();
}
