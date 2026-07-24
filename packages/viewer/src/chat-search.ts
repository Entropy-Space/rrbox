import type {
  ProjectSummary,
  SessionSummary,
} from "@researchbox/protocol";

export type ChatSearchResult = {
  project: ProjectSummary;
  session: SessionSummary;
};

export type ChatSearchDirection = "next" | "previous";

type RankedChat = {
  match_rank: number;
  project: ProjectSummary;
  session: SessionSummary;
};

export function searchChats(
  projects: readonly ProjectSummary[],
  sessions: readonly SessionSummary[],
  query: string,
): ChatSearchResult[] {
  const projectsById = new Map(
    projects.map((project) => [project.project_id, project]),
  );
  const normalizedQuery = normalizeSearchText(query);
  const rankedChats: RankedChat[] = [];

  for (const session of sessions) {
    const project = projectsById.get(session.project_id);
    if (!project) continue;

    const matchRank = getMatchRank(
      normalizeSearchText(session.title),
      normalizeSearchText(project.name),
      normalizedQuery,
    );
    if (matchRank === null) continue;

    rankedChats.push({
      match_rank: matchRank,
      project,
      session,
    });
  }

  return rankedChats
    .sort(compareRankedChats)
    .map(({ project, session }) => ({
      project: { ...project },
      session: { ...session },
    }));
}

export function moveChatSearchSelection(
  currentIndex: number,
  resultCount: number,
  direction: ChatSearchDirection,
): number {
  if (!Number.isSafeInteger(resultCount) || resultCount <= 0) return -1;
  const current =
    Number.isSafeInteger(currentIndex) &&
    currentIndex >= 0 &&
    currentIndex < resultCount
      ? currentIndex
      : direction === "next"
        ? -1
        : 0;
  return direction === "next"
    ? (current + 1) % resultCount
    : (current - 1 + resultCount) % resultCount;
}

export function shouldFocusComposerAfterChatSearch(
  isFocusRequested: boolean,
  isSearchOpen: boolean,
  isManagementPending: boolean,
  isCoreReady: boolean,
): boolean {
  return (
    isFocusRequested &&
    !isSearchOpen &&
    !isManagementPending &&
    isCoreReady
  );
}

function normalizeSearchText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function getMatchRank(
  title: string,
  projectName: string,
  query: string,
): number | null {
  if (!query) return 0;
  if (title === query) return 0;
  if (projectName === query) return 1;
  if (title.startsWith(query)) return 2;
  if (projectName.startsWith(query)) return 3;
  if (title.includes(query)) return 4;
  if (projectName.includes(query)) return 5;

  const queryTerms = query.split(" ");
  return queryTerms.every(
    (term) => title.includes(term) || projectName.includes(term),
  )
    ? 6
    : null;
}

function compareRankedChats(
  left: RankedChat,
  right: RankedChat,
): number {
  return (
    left.match_rank - right.match_rank ||
    compareTextDescending(
      left.session.updated_at,
      right.session.updated_at,
    ) ||
    compareTextAscending(
      left.project.project_id,
      right.project.project_id,
    ) ||
    compareTextAscending(
      left.session.session_id,
      right.session.session_id,
    )
  );
}

function compareTextAscending(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTextDescending(left: string, right: string): number {
  return compareTextAscending(right, left);
}
