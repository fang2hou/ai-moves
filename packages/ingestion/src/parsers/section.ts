export interface ChangelogSection {
  // Stored as the cursor's high-water mark and used in the item's external key.
  readonly marker: string;
  readonly label: string;
  readonly surface: string | null;
  readonly version: string | null;
  readonly publishedAt: number | null;
  readonly notes: string;
}
