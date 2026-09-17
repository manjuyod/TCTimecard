/** Preserve PostgreSQL microseconds in revisions while emitting canonical UTC wire values. */
export function persistedTimestamp(value: string | Date): string {
  const iso = new Date(value).toISOString();
  const fraction =
    typeof value === 'string'
      ? value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/i)?.[1]
      : undefined;
  return fraction
    ? iso.replace(
        /\.\d{3}Z$/,
        `.${fraction.replace(/0+$/, '').padEnd(3, '0')}Z`,
      )
    : iso;
}
export const timestampColumns = (fields: string[]) =>
  fields
    .map(
      (field) =>
        `to_char(${field} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${field}`,
    )
    .join(',');
