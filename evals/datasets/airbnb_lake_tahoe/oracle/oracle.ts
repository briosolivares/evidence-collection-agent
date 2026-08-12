/** Tier-B contract for a dynamic, personalized Airbnb search. Ranking and
 * listing contents are cookie-sensitive and have no independent public API,
 * so the exact first-30 membership remains part of the human overlay. */
export interface AirbnbLakeTahoeOracle {
  locationTerms: readonly string[];
  listingCount: 30;
  stayNights: 7;
  earliestCheckInDaysAfterRun: 1;
  latestCheckInDaysAfterRun: 14;
}

export async function fetchOracle(): Promise<AirbnbLakeTahoeOracle> {
  return {
    locationTerms: ['lake tahoe', 'tahoe'],
    listingCount: 30,
    stayNights: 7,
    earliestCheckInDaysAfterRun: 1,
    latestCheckInDaysAfterRun: 14,
  };
}
