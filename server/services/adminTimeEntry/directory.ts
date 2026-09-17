import type { Pool } from 'pg';
import { getPostgresPool } from '../../db/postgres';
import { getMssqlPool, sql } from '../../db/mssql';
import type { AdminTutor, Page, TutorFilters } from './contracts';
import { AdminTimeEntryError, invalid, positiveId } from './errors';
import { encodeCursor, decodeCursor } from './pagination';
export async function fetchCenterRoster(
  franchiseId: number,
): Promise<AdminTutor[]> {
  const pool = await getMssqlPool();
  const request = pool.request().input('FranchiseId', sql.Int, franchiseId);
  const result = await request.query(
    'SELECT ID,FirstName,LastName,IsDeleted FROM dbo.tblTutors WHERE FranchiseID=@FranchiseId',
  );
  return result.recordset.map((r: any) => ({
    tutorId: r.ID,
    displayName:
      `${r.FirstName ?? ''} ${r.LastName ?? ''}`.trim() || `Tutor #${r.ID}`,
    active: r.IsDeleted === 0 || r.IsDeleted === false,
    historyOnly: false,
  }));
}
export function createAdminDirectory(
  deps: {
    pool?: () => Pool;
    roster?: (franchiseId: number) => Promise<AdminTutor[]>;
  } = {},
) {
  const pool = deps.pool ?? getPostgresPool,
    roster = deps.roster ?? fetchCenterRoster;
  const history = async (franchiseId: number) =>
    new Set<number>(
      (
        await pool().query(
          'SELECT DISTINCT tutorid FROM public.time_entry_days WHERE franchiseid=$1',
          [franchiseId],
        )
      ).rows.map((r) => r.tutorid),
    );
  const fallback = (tutorId: number): AdminTutor => ({
    tutorId,
    displayName: `Tutor #${tutorId} (history only)`,
    active: false,
    historyOnly: true,
  });
  return {
    requireActiveTutor: async (
      franchiseId: number,
      tutorId: number,
    ): Promise<AdminTutor> => {
      positiveId(franchiseId, 'franchiseId');
      positiveId(tutorId, 'tutorId');
      let tutors: AdminTutor[];
      try {
        tutors = await roster(franchiseId);
      } catch {
        throw new AdminTimeEntryError(
          'ROSTER_UNAVAILABLE',
          'Active tutor roster is unavailable; please retry',
          503,
        );
      }
      const tutor = tutors.find((t) => t.tutorId === tutorId && t.active);
      if (!tutor)
        throw new AdminTimeEntryError(
          'NOT_FOUND',
          'Active tutor not found in this center',
          404,
        );
      return tutor;
    },
    resolveTutor: async (
      franchiseId: number,
      tutorId: number,
      knownHistorical = false,
    ): Promise<AdminTutor> => {
      let tutors: AdminTutor[];
      try {
        tutors = await roster(franchiseId);
      } catch {
        if (knownHistorical || (await history(franchiseId)).has(tutorId))
          return fallback(tutorId);
        throw new AdminTimeEntryError(
          'ROSTER_UNAVAILABLE',
          'Tutor roster is unavailable; please retry',
          503,
        );
      }
      const tutor = tutors.find((t) => t.tutorId === tutorId);
      if (tutor) return tutor;
      if (knownHistorical || (await history(franchiseId)).has(tutorId))
        return fallback(tutorId);
      throw new AdminTimeEntryError(
        'NOT_FOUND',
        'Tutor not found in this center',
        404,
      );
    },
    identitiesForHistory: async (franchiseId: number, ids: number[]) => {
      let tutors: AdminTutor[] = [];
      try {
        tutors = await roster(franchiseId);
      } catch {}
      const map = new Map(tutors.map((t) => [t.tutorId, t]));
      for (const id of ids) if (!map.has(id)) map.set(id, fallback(id));
      return map;
    },
    listAdminTutors: async (
      filters: TutorFilters,
    ): Promise<Page<AdminTutor>> => {
      positiveId(filters.franchiseId, 'franchiseId');
      if (
        typeof filters.search !== 'string' ||
        filters.search.length > 200 ||
        !Number.isInteger(filters.limit) ||
        filters.limit < 1 ||
        filters.limit > 100
      )
        invalid('Invalid tutor filters');
      const historical = await history(filters.franchiseId);
      let tutors: AdminTutor[] = [];
      try {
        tutors = await roster(filters.franchiseId);
      } catch {
        // A failed CRM lookup never verifies active membership. Scoped history
        // remains discoverable, but all fallback identities are non-creatable.
        if (!historical.size)
          throw new AdminTimeEntryError(
            'ROSTER_UNAVAILABLE',
            'Tutor roster is unavailable; please retry',
            503,
          );
      }
      const map = new Map(
        tutors
          .filter((t) => t.active || historical.has(t.tutorId))
          .map((t) => [t.tutorId, t]),
      );
      for (const id of historical) if (!map.has(id)) map.set(id, fallback(id));
      const search = filters.search.trim().toLowerCase(),
        scope = { franchiseId: filters.franchiseId, search };
      const tuple = filters.cursor ? decodeCursor(filters.cursor, scope) : null;
      if (
        tuple &&
        (tuple.length !== 2 ||
          typeof tuple[0] !== 'string' ||
          !Number.isSafeInteger(tuple[1]))
      )
        invalid('Invalid cursor');
      const name = (t: AdminTutor) =>
        t.displayName.normalize('NFKC').toLowerCase();
      const sorted = [...map.values()]
        .filter((t) => name(t).includes(search))
        .sort((a, b) =>
          name(a) < name(b)
            ? -1
            : name(a) > name(b)
              ? 1
              : a.tutorId - b.tutorId,
        )
        .filter(
          (t) =>
            !tuple ||
            name(t) > String(tuple[0]) ||
            (name(t) === tuple[0] && t.tutorId > Number(tuple[1])),
        );
      const items = sorted.slice(0, filters.limit),
        last = items[items.length - 1];
      return {
        items,
        nextCursor:
          sorted.length > filters.limit && last
            ? encodeCursor(scope, [name(last), last.tutorId])
            : null,
      };
    },
  };
}
const directory = createAdminDirectory();
export const requireActiveTutor = directory.requireActiveTutor;
export const listAdminTutors = directory.listAdminTutors;
